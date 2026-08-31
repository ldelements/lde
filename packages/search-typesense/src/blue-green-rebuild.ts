import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import type {
  DatasetOutcome,
  RunContext,
  RunWriter,
  Writer,
} from '@lde/pipeline';
import type { Dataset } from '@lde/dataset';
import { buildCollectionDefinition } from './collection-definition.js';
import { httpStatus, openLockedRun, releaseLock } from './lock.js';
import {
  assertWritableType,
  openDocuments,
  withBookkeeping,
} from './documents.js';
import {
  resolveRebuildOptions,
  type RebuildOptions,
  type ResolvedRebuildOptions,
} from './rebuild-support.js';

/** {@link BlueGreenRebuild} options: the collection-definition options (`name` is
 *  the logical index name the alias is kept on – omit it to derive one from the
 *  {@link SearchType}) plus the rebuild tuning knobs. */
export type BlueGreenRebuildOptions = RebuildOptions;

/**
 * Blue/green Rebuild (build a fresh index alongside the live one, then swap to
 * it atomically) as a transactional `Writer`: each run builds the search
 * index `options.name` from zero in a fresh versioned collection and goes
 * live atomically on commit. Deletion is implicit – whatever the run does not
 * write does not exist in the new collection. The name is the NDE Stack’s
 * pattern ({@link https://docs.nde.nl/stack/patterns | Stack patterns}).
 *
 * - `openRun` takes the single-flight cross-pod lock ({@link openLockedRun},
 *   throwing `RebuildAlreadyRunning` when another rebuild holds it) and
 *   creates the versioned collection (`${name}_<timestamp>`) with the schema
 *   derived from the {@link SearchType}.
 * - `write` streams documents into the fresh collection, batched across write
 *   calls, each recording the dataset it came from ({@link openDocuments}).
 * - `flush` on a **failed** dataset, and `reset` (the pipeline’s dump-fallback
 *   discard), roll that dataset back out of the not-yet-live collection, so a
 *   swap never ships a half-processed dataset; a successful flush leaves the
 *   streamed documents in place. On a canonically keyed collection the
 *   rollback drops the failed dataset’s *membership*, so a document another
 *   dataset also contributed stays – with a reference from that dataset that
 *   still resolves.
 * - `commit` imports the remainder, atomically repoints the `name` alias to
 *   the new collection, drops the collection it superseded, and releases the
 *   lock. Until commit, the live alias never points at a partial build.
 * - `abort` drops the half-built collection and releases the lock; the live
 *   index is untouched.
 *
 * The caller passes at most the logical index `name` – omitted, it is derived
 * from the {@link SearchType} ({@link deriveCollectionName}), the same
 * convention the engine reads by; the versioned collection name and the alias
 * are managed here.
 */
export class BlueGreenRebuild<
  TDocument extends { id: string },
> implements Writer<TDocument> {
  /**
   * The live Typesense alias this writer keeps pointed at its newest build:
   * the explicit `options.name`, or the name derived from the
   * {@link SearchType}. Read-only and for observability (logging, health
   * checks) – never an input, and the same name
   * {@link createTypesenseSearchEngine} reads the type from. The versioned
   * collections behind it (`${collectionName}_<timestamp>`) stay internal.
   */
  public readonly collectionName: string;
  private readonly resolved: ResolvedRebuildOptions;

  constructor(
    private readonly client: Client,
    private readonly searchType: SearchType,
    options: BlueGreenRebuildOptions = {},
  ) {
    // Rollback drops a known dataset rather than enumerating the indexed ones,
    // so a declared dataset field need not be facetable here.
    assertWritableType(searchType, { requireFacetable: false });
    this.resolved = resolveRebuildOptions(searchType, options);
    this.collectionName =
      this.resolved.definitionOptions.collectionNameFor(searchType);
  }

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const { batchSize, lockTtlMs, definitionOptions } = this.resolved;
    const name = this.collectionName;

    return openLockedRun(this.client, name, lockTtlMs, async () => {
      // Create the fresh (blue) collection up front, so a failure surfaces
      // before any dataset is processed. startedAt orders the versioned names;
      // concurrent same-name runs are excluded by the lock.
      //
      // The SAME versioning applies to every peer this type joins to, so an
      // emitted reference field names the peer’s FRESH collection rather than
      // its live one – Typesense resolves an alias to a concrete collection at
      // create time and keeps the concrete name, so referencing the alias would
      // pin the new build to the collection the peer is about to supersede. No
      // coordinator is needed: every writer in the run gets the same
      // `RunContext`, so `startedAt` – and therefore every derived name – is
      // identical across them.
      const version = Date.parse(context.startedAt);
      const versioned = (searchType: SearchType) =>
        `${definitionOptions.collectionNameFor(searchType)}_${version}`;
      const collection = versioned(this.searchType);
      const previous = await this.aliasTarget(name);
      const definition = buildCollectionDefinition(this.searchType, {
        ...definitionOptions,
        collectionNameFor: versioned,
      });
      await this.client
        .collections()
        .create(withBookkeeping(definition, this.searchType));

      const documents = openDocuments<TDocument>(this.client, collection, {
        searchType: this.searchType,
        runId: context.runId,
        startedAt: context.startedAt,
        batchSize,
      });

      // Roll a dataset back out of the not-yet-live collection (a failed
      // dataset, or a reset before the dump re-run). On a keyed collection
      // that drops its membership rather than the documents themselves, so a
      // dataset that succeeded keeps the ones it also contributed.
      const rollback = async (dataset: Dataset): Promise<void> =>
        documents.dropAll(dataset);

      return {
        write: async (dataset: Dataset, items: AsyncIterable<TDocument>) =>
          documents.add(dataset, items),

        flush: async (dataset: Dataset, outcome: DatasetOutcome) => {
          // A successful dataset keeps its streamed documents (they go live at
          // the swap); a failed one is rolled back so the swap never ships it.
          if (outcome !== 'success') {
            await rollback(dataset);
          }
        },

        reset: async (dataset: Dataset) => rollback(dataset),

        commit: async () => {
          await documents.flush();
          // The alias swap is the commit point: once it lands the new
          // collection is live. Everything after it is best-effort cleanup that
          // must NOT fail the commit – a post-swap rejection would otherwise
          // reject `commit`, and a caller that aborts on that (the pipeline
          // does) would drop the collection the alias now points at. So both
          // the superseded-collection delete and the lock release swallow
          // their errors; a lock left held is reclaimed on its TTL.
          await this.client
            .aliases()
            .upsert(name, { collection_name: collection });
          if (previous !== undefined && previous !== collection) {
            await this.client
              .collections(previous)
              .delete()
              .catch(() => undefined);
          }
          await releaseLock(this.client, name).catch(() => undefined);
        },

        abort: async () => {
          // The live alias is untouched; just drop the orphaned half-built
          // collection rather than let it accumulate.
          await this.client
            .collections(collection)
            .delete()
            .catch(() => undefined);
          await releaseLock(this.client, name);
        },

        abandon: async () => {
          // Everything `abort` does EXCEPT the drop. Asked for when a peer
          // whose documents reference this collection by concrete name has
          // already gone live: dropping it would break that live collection’s
          // joins, so the collection is kept for a later run to supersede.
          // Releasing the lock is the whole point – without it the index stays
          // locked for its full TTL and the next run cannot rebuild it.
          await releaseLock(this.client, name);
        },
      };
    });
  }

  /** The collection an alias currently points at, or `undefined` if unset. */
  private async aliasTarget(alias: string): Promise<string | undefined> {
    try {
      const { collection_name } = await this.client.aliases(alias).retrieve();
      return collection_name;
    } catch (error) {
      if (httpStatus(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }
}
