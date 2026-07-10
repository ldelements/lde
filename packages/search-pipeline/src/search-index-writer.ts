import type { Quad } from '@rdfjs/types';
import type { Dataset } from '@lde/dataset';
import type {
  DatasetOutcome,
  RunContext,
  RunWriter,
  Writer,
} from '@lde/pipeline';
import {
  projectGraph,
  type SearchDocument,
  type SearchSchema,
  type SearchType,
} from '@lde/search';

/** Options for {@link searchIndexWriter}. */
export interface SearchIndexWriterOptions {
  /**
   * The declarative schema driving the projection: one {@link SearchType} per
   * root type, each mapping framed RDF to flat search-document fields. The
   * writer opens one engine run per type in it.
   */
  schema: SearchSchema;
  /**
   * The engine writer that owns a given root type’s collection – e.g. a
   * `@lde/search-typesense` `BlueGreenRebuild` bound to that type and the
   * collection name it keeps its alias on. Called once per {@link SearchType}
   * in the schema when the writer is built.
   *
   * A single-collection deployment returns one writer for its one type; a
   * multi-collection deployment (the Dataset Register’s `datasets` plus its
   * Organization / Class / TerminologySource label collections) returns a
   * distinct writer per type, each an independent blue/green rebuild with its
   * own collection, alias and cross-pod lock. The projection is whole-schema
   * either way; the per-collection fan-out is this writer’s job.
   */
  writerFor: (searchType: SearchType) => Writer<SearchDocument>;
}

/**
 * The projection step of a search-indexing pipeline, as a quad `Writer`, fanned
 * out across a type’s collections. It turns each dataset’s extracted CONSTRUCT
 * quads into engine-agnostic search documents ({@link projectGraph}: frame by
 * root type, then project each node with its type’s declaration) and dispatches
 * each document to the engine run for **its** type. This is the one
 * type-changing step (quad → document), shared across engines – which is why it
 * lives here and not inside an engine adapter.
 *
 * Each root type is an independent engine run (its own collection, alias and
 * lock), so the collections commit, sweep and fail in isolation:
 *
 * - a type whose projection is empty this run affects only its own collection,
 *   never another’s – in particular the `datasets` index still goes live;
 * - `commit` finalizes every collection independently and, if any fails, throws
 *   an `AggregateError` *after* attempting them all, so a non-critical
 *   label-collection failure never blocks the collections that did commit,
 *   while the failure is still surfaced (the pipeline marks the run failed).
 *   Because the pipeline then calls {@link RunWriter.abort}, `abort` finalizes
 *   only the collections that did **not** already go live – aborting a
 *   committed blue/green rebuild would drop its now-live collection;
 * - `abort` (a run failure, or a partial commit) drops every half-built
 *   collection that has not committed and leaves the live ones untouched.
 *
 * A dataset’s quads are buffered until its flush and projected then, so the
 * documents land before every engine acts on the dataset’s completion (e.g. an
 * In-place stale sweep). Memory is bounded by one dataset’s extraction, and
 * released at each flush – nothing accumulates across datasets. Streaming
 * bounded entity batches *within* one huge dataset needs the two-level
 * iteration (dataset → entity-URI batches) and is not implemented yet.
 */
export function searchIndexWriter(
  options: SearchIndexWriterOptions,
): Writer<Quad> {
  const { schema, writerFor } = options;
  // One engine writer per root type, built once; each run opens them all. Keyed
  // by the type IRI, which is also how a projected document names its type.
  const writers = new Map<string, Writer<SearchDocument>>(
    [...schema.values()].map((searchType) => [
      searchType.type,
      writerFor(searchType),
    ]),
  );

  return {
    async openRun(context: RunContext): Promise<RunWriter<Quad>> {
      const runs = new Map<string, RunWriter<SearchDocument>>();
      try {
        for (const [typeIri, writer] of writers) {
          runs.set(typeIri, await writer.openRun(context));
        }
      } catch (error) {
        // One engine run failed to open (e.g. its lock is held); roll the
        // already-opened ones back so no collection or lock is left dangling.
        await Promise.allSettled(
          [...runs.values()].map((run) => run.abort(error)),
        );
        throw error;
      }

      // The collections that have gone live, so `abort` never re-finalizes one
      // (a committed blue/green rebuild’s abort drops its now-live collection).
      const committed = new Set<string>();

      // One buffered pass per dataset, keyed by IRI. The pipeline processes
      // datasets sequentially, but keeping the key explicit makes a write after
      // another dataset's flush safe too.
      const passes = new Map<string, { dataset: Dataset; quads: Quad[] }>();

      const project = async (pass: {
        dataset: Dataset;
        quads: Quad[];
      }): Promise<void> => {
        passes.delete(pass.dataset.iri.toString());
        if (pass.quads.length === 0) {
          return;
        }
        // Whole-schema projection into one mixed stream, split by type here so
        // each type’s documents reach its own collection’s run.
        const byType = new Map<string, SearchDocument[]>();
        for await (const { searchType, document } of projectGraph(
          pass.quads,
          schema,
        )) {
          const documents = byType.get(searchType.type);
          if (documents === undefined) {
            byType.set(searchType.type, [document]);
          } else {
            documents.push(document);
          }
        }
        // Every yielded type is a schema type, so it has a run; iterate the
        // runs and write each the documents projected for its type (none, for a
        // type absent from this pass).
        for (const [typeIri, run] of runs) {
          const documents = byType.get(typeIri);
          if (documents !== undefined) {
            await run.write(pass.dataset, stream(documents));
          }
        }
      };

      return {
        write: async (dataset: Dataset, quads: AsyncIterable<Quad>) => {
          const key = dataset.iri.toString();
          let pass = passes.get(key);
          if (pass === undefined) {
            pass = { dataset, quads: [] };
            passes.set(key, pass);
          }
          for await (const quad of quads) {
            pass.quads.push(quad);
          }
        },

        flush: async (dataset: Dataset, outcome: DatasetOutcome) => {
          const pass = passes.get(dataset.iri.toString());
          if (pass !== undefined) {
            await project(pass);
          }
          // Flush every collection independently: one collection’s flush failure
          // (a rollback, or an In-place stale sweep) must not skip another’s –
          // the pipeline isolates a flush error per dataset and still commits,
          // so a skipped collection would swap live with a dataset it should
          // have rolled back or swept. Every collection is flushed, not just the
          // ones that received documents this dataset: a collection an earlier
          // run held documents for still needs its sweep to reconcile.
          await settleAll(runs.values(), 'flush', (run) =>
            run.flush?.(dataset, outcome),
          );
        },

        reset: async (dataset: Dataset) => {
          // Discard the buffered pass so the re-run replaces it, and let every
          // collection’s run discard whatever it already holds for the dataset –
          // independently, so one collection’s reset failure never leaves
          // another holding the discarded pass’s documents into the re-run.
          passes.delete(dataset.iri.toString());
          await settleAll(runs.values(), 'reset', (run) =>
            run.reset?.(dataset),
          );
        },

        commit: async () => {
          // Safety net: project passes that were never flushed, so a committed
          // run never silently drops written quads.
          for (const pass of [...passes.values()]) {
            await project(pass);
          }
          // Commit every collection independently, so one failure neither
          // blocks nor wipes another – the `datasets` index goes live even if a
          // label collection cannot. Record each collection that went live, so
          // the abort that follows a failed commit never drops it.
          await settleAll(runs, 'commit', async ([typeIri, run]) => {
            await run.commit();
            committed.add(typeIri);
          });
        },

        abort: async (error: unknown) => {
          // Finalize only the collections that have not gone live: aborting a
          // committed blue/green rebuild would drop its now-live collection.
          // Best-effort – cleanup failures must not mask the original error.
          await Promise.allSettled(
            [...runs]
              .filter(([typeIri]) => !committed.has(typeIri))
              .map(([, run]) => run.abort(error)),
          );
        },
      };
    },
  };
}

/**
 * Run `operation` on every collection concurrently and independently, so one
 * collection’s failure never skips another’s (a flush’s rollback, a reset’s
 * discard, a commit’s alias swap). Surface the failures together once all have
 * been attempted, as an `AggregateError` – the run is still marked failed, but
 * every collection got its chance to reconcile or go live first.
 */
async function settleAll<Item>(
  items: Iterable<Item>,
  verb: string,
  operation: (item: Item) => Promise<void> | undefined,
): Promise<void> {
  const targets = [...items];
  const outcomes = await Promise.allSettled(
    targets.map((item) => operation(item)),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${targets.length} search collections failed to ${verb}`,
    );
  }
}

/** Yield the given documents as an async iterable, like a streaming source. */
async function* stream<Item>(items: readonly Item[]): AsyncIterable<Item> {
  yield* items;
}
