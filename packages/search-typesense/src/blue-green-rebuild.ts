import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import type { RunContext, RunWriter, Writer } from '@lde/pipeline';
import type { Dataset } from '@lde/dataset';
import {
  buildCollectionSchema,
  type CollectionSchemaOptions,
} from './collection-schema.js';
import { BatchImporter, DEFAULT_BATCH_SIZE } from './import.js';
import {
  DEFAULT_LOCK_TTL_MS,
  httpStatus,
  openLockedRun,
  releaseLock,
} from './lock.js';

/** {@link BlueGreenRebuild} options: the collection-schema options (`name` is
 *  the logical index name the alias is kept on) plus the rebuild tuning knobs. */
export interface BlueGreenRebuildOptions extends CollectionSchemaOptions {
  /** Documents imported per Typesense request (default 1000). */
  readonly batchSize?: number;
  /** A held lock older than this (ms) is reclaimed (default 10 minutes). */
  readonly lockTtlMs?: number;
}

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
 * - `write` streams documents into it, batched across write calls.
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
  ) {}

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const {
      batchSize = DEFAULT_BATCH_SIZE,
      lockTtlMs = DEFAULT_LOCK_TTL_MS,
      ...schemaOptions
    } = this.options;
    const name = schemaOptions.name;

    return openLockedRun(this.client, name, lockTtlMs, async () => {
      // Create the fresh (blue) collection up front, so a failure surfaces
      // before any dataset is processed. startedAt orders the versioned names;
      // concurrent same-name runs are excluded by the lock.
      const collection = `${name}_${Date.parse(context.startedAt)}`;
      const previous = await this.aliasTarget(name);
      const schema = buildCollectionSchema(this.searchType, schemaOptions);
      await this.client.collections().create({ ...schema, name: collection });

      const importer = new BatchImporter<TDocument>(
        this.client,
        collection,
        batchSize,
      );

      return {
        write: async (_dataset: Dataset, documents: AsyncIterable<TDocument>) =>
          importer.add(documents),

        commit: async () => {
          await importer.flush();
          await this.client
            .aliases()
            .upsert(name, { collection_name: collection });
          if (previous !== undefined && previous !== collection) {
            await this.client
              .collections(previous)
              .delete()
              .catch(() => undefined);
          }
          await releaseLock(this.client, name);
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
