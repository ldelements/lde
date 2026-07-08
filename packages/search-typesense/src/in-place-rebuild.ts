import type { Client } from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import type { SearchType } from '@lde/search';
import type { Dataset } from '@lde/dataset';
import type {
  DatasetOutcome,
  RunContext,
  RunWriter,
  Writer,
} from '@lde/pipeline';
import {
  buildCollectionSchema,
  type CollectionSchemaOptions,
} from './collection-schema.js';
import { BatchImporter, DEFAULT_BATCH_SIZE } from './import.js';
import {
  DEFAULT_LOCK_TTL_MS,
  ensureCollectionExists,
  openLockedRun,
  releaseLock,
} from './lock.js';
import {
  LAST_SEEN_FIELD,
  SOURCE_FIELD,
  departedSources,
  membershipSweepFilters,
  staleDocumentsFilter,
} from './sweep.js';

/**
 * Default ceiling on the distinct sources the membership sweep enumerates via
 * a single `source` facet. The sweep needs the complete source set to spot
 * departed ones, so a truncated facet would silently miss deletions;
 * {@link InPlaceRebuild} throws instead. Raise it (up to the engine’s
 * `max_facet_values` limit) with {@link InPlaceRebuildOptions.maxSweepableSources}
 * before an index approaches it, so the ceiling is a tunable guard rather than
 * a hard wall.
 */
const DEFAULT_MAX_SWEEPABLE_SOURCES = 10_000;

/** {@link InPlaceRebuild} options: the collection-schema options (`name` is
 *  the collection the writer maintains in place) plus tuning knobs. */
export interface InPlaceRebuildOptions extends CollectionSchemaOptions {
  /** Documents imported per Typesense request (default 1000). */
  readonly batchSize?: number;
  /** A held lock older than this (ms) is reclaimed (default 10 minutes). */
  readonly lockTtlMs?: number;
  /** Most distinct sources the membership sweep may enumerate before it throws
   *  rather than risk missing departed sources (default 10 000). */
  readonly maxSweepableSources?: number;
}

/**
 * In-place Rebuild (update the live index directly – upsert changed sources,
 * sweep the rest – rather than swap in a fresh one) as a transactional
 * `Writer`: documents are upserted into one long-lived collection with
 * per-source atomicity – no swap, no staging. Every document is stamped with
 * its `source` (the dataset IRI) and `last_seen` (the run id); deletion is a
 * sweep, never special-cased:
 *
 * - a **successful dataset flush** deletes the source’s documents the run did
 *   not rewrite (`source = dataset && last_seen != runId`). A failed dataset
 *   is not swept – its output is incomplete, and the next successful run
 *   reconciles;
 * - **commit** deletes every document whose source left the run’s selection
 *   (registry-membership sweep over {@link RunContext.selectedSources}, which
 *   includes datasets skipped as unchanged) and releases the lock;
 * - **abort** only releases the lock: upserts are idempotent, so whatever
 *   landed stays until the next run reconciles.
 *
 * `openRun` takes the single-flight cross-pod lock (throwing
 * `RebuildAlreadyRunning` when another rebuild holds it) and creates
 * the collection on demand from the {@link SearchType} plus the two
 * bookkeeping fields.
 *
 * Document ids must be unique per (source, entity) – the caller keys them –
 * or documents from different sources overwrite each other.
 *
 * The name is the NDE Stack’s pattern
 * ({@link https://docs.nde.nl/stack/patterns | Stack patterns}).
 */
export class InPlaceRebuild<
  TDocument extends { id: string },
> implements Writer<TDocument> {
  constructor(
    private readonly client: Client,
    private readonly searchType: SearchType,
    private readonly options: InPlaceRebuildOptions,
  ) {
    const reserved = searchType.fields.filter(
      (field) => field.name === SOURCE_FIELD || field.name === LAST_SEEN_FIELD,
    );
    if (reserved.length > 0) {
      throw new Error(
        `SearchType “${searchType.name}” declares reserved bookkeeping field(s) ${reserved
          .map((field) => `“${field.name}”`)
          .join(', ')}`,
      );
    }
  }

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const {
      batchSize = DEFAULT_BATCH_SIZE,
      lockTtlMs = DEFAULT_LOCK_TTL_MS,
      maxSweepableSources = DEFAULT_MAX_SWEEPABLE_SOURCES,
      ...schemaOptions
    } = this.options;
    const name = schemaOptions.name;

    return openLockedRun(this.client, name, lockTtlMs, async () => {
      // Create the collection on demand: SearchType schema + the bookkeeping
      // fields, `source` faceted so the membership sweep can enumerate the
      // distinct sources.
      await ensureCollectionExists(this.client, name, () => {
        const schema = buildCollectionSchema(this.searchType, schemaOptions);
        const bookkeeping: CollectionFieldSchema[] = [
          { name: SOURCE_FIELD, type: 'string', facet: true },
          { name: LAST_SEEN_FIELD, type: 'string' },
        ];
        return {
          ...schema,
          fields: [...(schema.fields ?? []), ...bookkeeping],
        };
      });

      const importer = new BatchImporter<TDocument & StampedFields>(
        this.client,
        name,
        batchSize,
      );

      const stamp = (
        dataset: Dataset,
        documents: AsyncIterable<TDocument>,
      ): AsyncIterable<TDocument & StampedFields> => {
        const source = dataset.iri.toString();
        const runId = context.runId;
        return (async function* () {
          for await (const document of documents) {
            yield { ...document, source, last_seen: runId };
          }
        })();
      };

      return {
        write: async (dataset, documents) =>
          importer.add(stamp(dataset, documents)),

        flush: async (dataset: Dataset, outcome?: DatasetOutcome) => {
          // Land the buffered documents first, so the sweep below never
          // deletes what this run just rewrote.
          await importer.flush();
          if (outcome !== 'success') {
            // A failed dataset’s output is incomplete: sweeping against it
            // would delete documents the run never got to rewrite. Leave the
            // stale ones for the next successful run to reconcile.
            return;
          }
          await this.deleteByFilter(
            name,
            staleDocumentsFilter(dataset.iri.toString(), context.runId),
          );
        },

        commit: async () => {
          await importer.flush();
          const departed = departedSources(
            await this.indexedSources(name, maxSweepableSources),
            context.selectedSources(),
          );
          for (const filter of membershipSweepFilters(departed)) {
            await this.deleteByFilter(name, filter);
          }
          await releaseLock(this.client, name);
        },

        abort: async () => {
          await releaseLock(this.client, name);
        },
      };
    });
  }

  /**
   * The distinct sources present in the collection, via a single `source`
   * facet. Requests one bucket beyond `maxSources` so genuine truncation is
   * distinguishable from an exactly-full result: `maxSources` buckets are
   * returned intact, `maxSources + 1` proves more exist and the sweep would
   * miss some, so it throws rather than delete blind.
   */
  private async indexedSources(
    name: string,
    maxSources: number,
  ): Promise<string[]> {
    const response = await this.client
      .collections(name)
      .documents()
      .search({
        q: '*',
        query_by: SOURCE_FIELD,
        per_page: 0,
        facet_by: SOURCE_FIELD,
        max_facet_values: maxSources + 1,
      });
    const counts = response.facet_counts?.[0]?.counts ?? [];
    if (counts.length > maxSources) {
      throw new Error(
        `Membership sweep cannot see beyond ${maxSources} distinct sources in “${name}”; raise maxSweepableSources or departed sources might be missed`,
      );
    }
    return counts.map((count) => count.value);
  }

  private async deleteByFilter(name: string, filterBy: string): Promise<void> {
    await this.client
      .collections(name)
      .documents()
      .delete({ filter_by: filterBy });
  }
}

/** The bookkeeping fields stamped on every document – the literal keys of
 *  {@link SOURCE_FIELD} and {@link LAST_SEEN_FIELD}, spelled out because an
 *  interface cannot derive its keys from constants. */
interface StampedFields {
  source: string;
  last_seen: string;
}
