import type { Dataset } from '@lde/dataset';
import {
  AsyncQueue,
  type DatasetOutcome,
  type RunContext,
  type RunWriter,
  type Writer,
} from '@lde/pipeline';
import type { SearchDocument, SearchSchema, SearchType } from '@lde/search';
import type { TypedSearchDocument } from './typed-search-document.js';

/** Options for {@link searchIndexWriter}. */
export interface SearchIndexWriterOptions {
  /**
   * The declarative schema: one {@link SearchType} per root type. The writer
   * opens one engine run per type in it and routes each document to its type’s
   * run. Must be the same schema the stages project through.
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
   * own collection, alias and cross-pod lock. The per-collection fan-out is this
   * writer’s job.
   */
  writerFor: (searchType: SearchType) => Writer<SearchDocument>;
}

/**
 * The single terminal of a search-indexing pipeline: an engine-agnostic router
 * that fans already-projected documents out across a type’s collections. The
 * per-type {@link https://github.com/ldelements/lde/blob/main/docs/decisions/0013-project-inside-the-batch-per-root-type.md | stages}
 * project inside the batch and tag each document with its {@link SearchType}
 * ({@link TypedSearchDocument}); this writer dispatches each document to the
 * engine run for **its** type by `searchType.class`. It **owns no projection**
 * (that moved into the stages) and **buffers nothing** (documents stream through
 * to the run as they arrive) – it is purely the per-collection fan-out
 * {@link https://github.com/ldelements/lde/blob/main/docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md | ADR 9}
 * made it.
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
 * Memory is bounded by one batch of documents per type, not the dataset:
 * `write` routes each document to its type’s run through a bounded queue and
 * never accumulates them.
 */
export function searchIndexWriter(
  options: SearchIndexWriterOptions,
): Writer<TypedSearchDocument> {
  const { schema, writerFor } = options;
  // One engine writer per root type, built once; each run opens them all. Keyed
  // by the type IRI, which is also how a tagged document names its type.
  const writers = new Map<string, Writer<SearchDocument>>(
    [...schema.values()].map((searchType) => [
      searchType.class,
      writerFor(searchType),
    ]),
  );

  return {
    async openRun(
      context: RunContext,
    ): Promise<RunWriter<TypedSearchDocument>> {
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

      return {
        write: async (
          dataset: Dataset,
          items: AsyncIterable<TypedSearchDocument>,
        ) => {
          // Route each tagged document to its type’s run, streaming. A stage
          // writes one type, but the terminal carries no stage identity, so it
          // routes per item by the tag. Each type gets one `run.write`, fed a
          // bounded queue the run drains concurrently – so memory stays O(batch)
          // per type, never O(dataset). Almost always one lane per call.
          const lanes = new Map<
            string,
            { queue: AsyncQueue<SearchDocument>; done: Promise<void> }
          >();
          const laneFor = (searchType: SearchType) => {
            let lane = lanes.get(searchType.class);
            if (lane === undefined) {
              const run = runs.get(searchType.class);
              if (run === undefined) {
                throw new Error(
                  `No engine run for search type “${searchType.name}” (${searchType.class}); it is not in this writer’s schema.`,
                );
              }
              const queue = new AsyncQueue<SearchDocument>();
              const done = run.write(dataset, queue);
              // If the run stops consuming (its write rejects), unblock the
              // producer so a full queue cannot deadlock the push loop below.
              done.catch((error: unknown) => queue.abort(error));
              lane = { queue, done };
              lanes.set(searchType.class, lane);
            }
            return lane;
          };

          try {
            for await (const { searchType, document } of items) {
              await laneFor(searchType).queue.push(document);
            }
            for (const lane of lanes.values()) {
              lane.queue.close();
            }
            await Promise.all([...lanes.values()].map((lane) => lane.done));
          } catch (error) {
            for (const lane of lanes.values()) {
              lane.queue.abort(error);
            }
            await Promise.allSettled(
              [...lanes.values()].map((lane) => lane.done),
            );
            throw error;
          }
        },

        flush: async (dataset: Dataset, outcome: DatasetOutcome) => {
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
          // Let every collection’s run discard whatever it already holds for the
          // dataset – independently, so one collection’s reset failure never
          // leaves another holding the discarded documents into the re-run.
          await settleAll(runs.values(), 'reset', (run) =>
            run.reset?.(dataset),
          );
        },

        commit: async () => {
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
