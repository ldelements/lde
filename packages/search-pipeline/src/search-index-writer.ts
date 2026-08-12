import type { Dataset } from '@lde/dataset';
import {
  AsyncQueue,
  type DatasetOutcome,
  type RunContext,
  type RunWriter,
  type Writer,
} from '@lde/pipeline';
import {
  joinGraph,
  type RootType,
  type SearchDocument,
  type SearchSchema,
} from '@lde/search';
import type { TypedSearchDocument } from './typed-search-document.js';

/** Options for {@link searchIndexWriter}. */
export interface SearchIndexWriterOptions {
  /**
   * The declarative schema: one {@link RootType} per collection. The writer
   * opens one engine run per Root Type in it and routes each document to its
   * type’s run. Reference Types are absent from `schema.values()`, so none ever
   * earns a run. Must be the same schema the stages project through.
   */
  schema: SearchSchema;
  /**
   * The engine writer that owns a given root type’s collection – e.g. a
   * `@lde/search-typesense` `BlueGreenRebuild` bound to that type and the
   * collection name it keeps its alias on. Called once per {@link RootType}
   * in the schema when the writer is built.
   *
   * A single-collection deployment returns one writer for its one type; a
   * multi-collection deployment (the Dataset Register’s `datasets` plus its
   * Organization / Class / TerminologySource label collections) returns a
   * distinct writer per type, each an independent blue/green rebuild with its
   * own collection, alias and cross-pod lock. The per-collection fan-out is this
   * writer’s job.
   */
  writerFor: (
    searchType: RootType,
    schema: SearchSchema,
  ) => Writer<SearchDocument>;
}

/**
 * The single terminal of a search-indexing pipeline: an engine-agnostic router
 * that fans already-projected documents out across a type’s collections. The
 * per-type {@link https://github.com/ldelements/lde/blob/main/docs/decisions/0013-project-inside-the-batch-per-root-type.md | stages}
 * project inside the batch and pair each document with its {@link SearchType}
 * ({@link TypedSearchDocument}); this writer dispatches each document to the
 * engine run for **its** type by `searchType.class`. It **owns no projection**
 * (that moved into the stages) and **buffers nothing** (documents stream through
 * to the run as they arrive) – it is purely the per-collection fan-out
 * {@link https://github.com/ldelements/lde/blob/main/docs/decisions/0009-route-a-whole-schema-projection-to-per-type-collections.md | ADR 9}
 * made it.
 *
 * Each root type is an independent engine run (its own collection, alias and
 * lock), and the unit those runs are isolated **by** is the join component –
 * the group of types that reference one another through a
 * {@link ReferenceField.joinable} reference and therefore cannot go live apart
 * ([ADR 19](https://github.com/ldelements/lde/blob/main/docs/decisions/0019-filter-across-collections-through-declared-joins.md)).
 * A type with no joinable reference is a singleton component, so a schema
 * without joins behaves exactly as it did:
 *
 * - a type whose projection is empty this run affects only its own collection,
 *   never another’s – in particular the `datasets` index still goes live;
 * - runs are **opened** in join order, referenced first: an engine cannot
 *   create a collection whose reference names a collection that does not exist
 *   yet;
 * - `commit` finalizes every component independently and, if any fails, throws
 *   an `AggregateError` *after* attempting them all, so a non-critical
 *   label-collection failure never blocks the components that did commit,
 *   while the failure is still surfaced (the pipeline marks the run failed).
 *   Within a component the commits are sequential, referrers first, and stop
 *   at the first failure – so a component ships whole or not at all. Because
 *   the pipeline then calls {@link RunWriter.abort}, `abort` finalizes only the
 *   collections that did **not** already go live – aborting a committed
 *   blue/green rebuild would drop its now-live collection;
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
  // by the type IRI, which is also how a paired document names its type.
  const writers = new Map<string, Writer<SearchDocument>>(
    [...schema.values()].map((searchType) => [
      searchType.class,
      writerFor(searchType, schema),
    ]),
  );
  // The declared join components – the unit a rebuild opens and commits by.
  // A type with no joinable reference is a singleton here, so a schema without
  // joins keeps per-collection isolation exactly as before.
  const components = joinGraph(schema).components;
  // Referenced first, across every component: the order the collections may be
  // created in.
  const openOrder = components.flat();

  return {
    async openRun(
      context: RunContext,
    ): Promise<RunWriter<TypedSearchDocument>> {
      const runs = new Map<string, RunWriter<SearchDocument>>();
      try {
        // Open in join order: a collection whose reference names a peer’s
        // collection cannot be created before that peer’s exists, so a
        // component’s referenced types open first. Locking needs no change –
        // this is still the single deterministic pass that takes every lock in
        // a fixed order, which is what keeps lock-ordering deadlock impossible.
        for (const searchType of openOrder) {
          const writer = writers.get(
            searchType.class,
          ) as Writer<SearchDocument>;
          runs.set(searchType.class, await writer.openRun(context));
        }
      } catch (error) {
        // One engine run failed to open (e.g. its lock is held); roll the
        // already-opened ones back so no collection or lock is left dangling.
        await Promise.allSettled(
          [...runs.values()].map((run) => run.abort(error)),
        );
        throw error;
      }

      // The components with at least one collection live, so `abort` never
      // re-finalizes one: a committed blue/green rebuild’s abort would drop its
      // now-live collection, and an uncommitted PEER’s abort would drop the
      // collection that live one references. Tracked per component rather than
      // per type because that is the unit the second hazard lives at.
      const live = new Set<readonly RootType[]>();

      return {
        write: async (
          dataset: Dataset,
          items: AsyncIterable<TypedSearchDocument>,
        ) => {
          // Route each document to its type’s run, streaming. A stage writes
          // one type, but the terminal carries no stage identity, so it routes
          // per item by its `searchType`. Each type gets one `run.write`, fed a
          // bounded queue the run drains concurrently – so memory stays O(batch)
          // per type, never O(dataset). Almost always one lane per call.
          const lanes = new Map<
            string,
            { queue: AsyncQueue<SearchDocument>; done: Promise<void> }
          >();
          const laneFor = (searchType: RootType) => {
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
          await settleAll(runs.values(), 'flush', 'collection', (run) =>
            run.flush?.(dataset, outcome),
          );
        },

        reset: async (dataset: Dataset) => {
          // Let every collection’s run discard whatever it already holds for the
          // dataset – independently, so one collection’s reset failure never
          // leaves another holding the discarded documents into the re-run.
          await settleAll(runs.values(), 'reset', 'collection', (run) =>
            run.reset?.(dataset),
          );
        },

        commit: async () => {
          // Commit every join COMPONENT independently, so one failure neither
          // blocks nor wipes another – the `datasets` index goes live even if
          // an unrelated label collection cannot. Record each collection that
          // went live, so the abort that follows a failed commit never drops
          // it.
          //
          // Within a component the commits are sequential and in REVERSE join
          // order – referrers before the types they reference. A blue/green
          // commit drops the collection it supersedes, so committing the
          // referent first would delete a collection the still-live referrer’s
          // documents point at. Going the other way, the referrer swaps onto
          // the fresh build (whose references already name the peer’s fresh
          // collection) before the peer’s old collection is dropped, and the
          // only inconsistency left is the alias-flip window Typesense gives no
          // way to close.
          //
          // Sequential, and stopping at the first failure, is what makes the
          // component the unit: a member that cannot commit leaves the rest of
          // its component un-swapped rather than shipping half a rebuild.
          await settleAll(
            components,
            'commit',
            'join component',
            async (component) => {
              for (const searchType of [...component].reverse()) {
                const run = runs.get(
                  searchType.class,
                ) as RunWriter<SearchDocument>;
                await run.commit();
                // Note the component as touched BEFORE the next member’s
                // commit can throw, so the abort that follows knows this
                // component has something live in it.
                live.add(component);
              }
            },
          );
        },

        abort: async (error: unknown) => {
          // Finalize only the collections that have not gone live – and, for a
          // component that went PARTLY live, none of its members at all.
          //
          // Aborting a committed blue/green rebuild would drop its now-live
          // collection; aborting an uncommitted member of a partly-committed
          // component is the same mistake one edge out. Its half-built
          // collection is precisely what the member that DID commit now
          // references by concrete name, so dropping it leaves the live
          // referrer with a dangling reference and every join through it
          // failing – permanently, since the next run builds new collections
          // rather than repairing that one. Leaving it costs an orphaned
          // collection until an operator reclaims it; dropping it costs a
          // broken live index, so the leak is the lesser evil.
          //
          // Best-effort – cleanup failures must not mask the original error.
          const partlyLive = new Set(
            [...live].flatMap((component) =>
              component.map((searchType) => searchType.class),
            ),
          );
          await Promise.allSettled(
            [...runs]
              .filter(([typeIri]) => !partlyLive.has(typeIri))
              .map(([, run]) => run.abort(error)),
          );
        },
      };
    },
  };
}

/**
 * Run `operation` on every item concurrently and independently, so one
 * failure never skips another’s work (a flush’s rollback, a reset’s discard, a
 * commit’s alias swap). Surface the failures together once all have been
 * attempted, as an `AggregateError` – the run is still marked failed, but every
 * item got its chance to reconcile or go live first.
 *
 * `unit` names what was iterated, because that differs by phase: a flush and a
 * reset are per collection, a commit is per join component.
 */
async function settleAll<Item>(
  items: Iterable<Item>,
  verb: string,
  unit: string,
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
      `${failures.length} of ${targets.length} search ${unit}s failed to ${verb}`,
    );
  }
}
