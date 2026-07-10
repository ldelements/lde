import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import type {
  DatasetOutcome,
  RunContext,
  RunWriter,
  Writer,
} from '@lde/pipeline';
import type { Dataset } from '@lde/dataset';
import { buildCollectionSchema } from './collection-schema.js';
import { BatchImporter } from './import.js';
import { httpStatus, openLockedRun, releaseLock } from './lock.js';
import { SOURCE_FIELD, sourceDocumentsFilter } from './sweep.js';
import {
  assertNoReservedFields,
  deleteByFilter,
  resolveRebuildOptions,
  stampDocuments,
  type RebuildOptions,
} from './rebuild-support.js';

/** {@link BlueGreenRebuild} options: the collection-schema options (`name` is
 *  the logical index name the alias is kept on) plus the rebuild tuning knobs. */
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
 *   calls, each stamped with its `source` (the dataset IRI).
 * - `flush` on a **failed** dataset, and `reset` (the pipeline’s dump-fallback
 *   discard), roll that dataset’s documents back out of the not-yet-live
 *   collection by `source`, so a swap never ships a half-processed dataset;
 *   a successful flush leaves the streamed documents in place.
 * - `commit` imports the remainder, atomically repoints the `name` alias to
 *   the new collection, drops the collection it superseded, and releases the
 *   lock. Until commit, the live alias never points at a partial build.
 * - `abort` drops the half-built collection and releases the lock; the live
 *   index is untouched.
 *
 * The caller passes only the logical index `name`; the versioned collection
 * name and the alias are managed here.
 */
export class BlueGreenRebuild<
  TDocument extends { id: string },
> implements Writer<TDocument> {
  constructor(
    private readonly client: Client,
    private readonly searchType: SearchType,
    private readonly options: BlueGreenRebuildOptions,
  ) {
    // `source` is stamped on every document for per-dataset rollback.
    assertNoReservedFields(searchType, [SOURCE_FIELD]);
  }

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const { name, batchSize, lockTtlMs, schemaOptions } = resolveRebuildOptions(
      this.options,
    );

    return openLockedRun(this.client, name, lockTtlMs, async () => {
      // Create the fresh (blue) collection up front, so a failure surfaces
      // before any dataset is processed. startedAt orders the versioned names;
      // concurrent same-name runs are excluded by the lock.
      const collection = `${name}_${Date.parse(context.startedAt)}`;
      const previous = await this.aliasTarget(name);
      const schema = buildCollectionSchema(this.searchType, schemaOptions);
      await this.client.collections().create({
        ...schema,
        name: collection,
        fields: [
          ...(schema.fields ?? []),
          { name: SOURCE_FIELD, type: 'string' },
        ],
      });

      const importer = new BatchImporter<TDocument & Record<string, string>>(
        this.client,
        collection,
        batchSize,
      );

      // Drop a dataset’s streamed documents back out of the not-yet-live
      // collection (a failed dataset, or a reset before the dump re-run). Any
      // still buffered must land first, so the delete filter sees them.
      const rollback = async (dataset: Dataset): Promise<void> => {
        await importer.flush();
        await deleteByFilter(
          this.client,
          collection,
          sourceDocumentsFilter(dataset.iri.toString()),
        );
      };

      return {
        write: async (dataset: Dataset, documents: AsyncIterable<TDocument>) =>
          importer.add(
            stampDocuments(documents, {
              [SOURCE_FIELD]: dataset.iri.toString(),
            }),
          ),

        flush: async (dataset: Dataset, outcome: DatasetOutcome) => {
          // A successful dataset keeps its streamed documents (they go live at
          // the swap); a failed one is rolled back so the swap never ships it.
          if (outcome !== 'success') {
            await rollback(dataset);
          }
        },

        reset: async (dataset: Dataset) => rollback(dataset),

        commit: async () => {
          await importer.flush();
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
