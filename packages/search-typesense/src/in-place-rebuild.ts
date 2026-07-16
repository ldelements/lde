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
import { buildCollectionDefinition } from './collection-definition.js';
import { BatchImporter } from './import.js';
import { ensureCollectionExists, openLockedRun, releaseLock } from './lock.js';
import {
  LAST_SEEN_FIELD,
  SOURCE_FIELD,
  departedSources,
  membershipSweepFilters,
  staleDocumentsFilter,
  thisRunDocumentsFilter,
} from './sweep.js';
import {
  assertNoReservedFields,
  deleteByFilter,
  resolveRebuildOptions,
  stampDocuments,
  type RebuildOptions,
  type ResolvedRebuildOptions,
} from './rebuild-support.js';

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

/** {@link InPlaceRebuild} options: the shared rebuild options plus the
 *  membership-sweep ceiling. */
export interface InPlaceRebuildOptions extends RebuildOptions {
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
 * - **reset** (the pipeline’s dump-fallback discard) deletes only *this run’s*
 *   writes for the dataset (`source = dataset && last_seen = runId`), so the
 *   dump re-run rebuilds it cleanly while the source’s prior-run documents are
 *   left for the success sweep to reconcile;
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
  /**
   * The Typesense collection this writer maintains: the explicit
   * `options.name`, or the name derived from the {@link SearchType}. Read-only
   * and for observability (logging, health checks) – never an input, and the
   * same name {@link createTypesenseSearchEngine} reads the type from.
   */
  public readonly collectionName: string;
  private readonly maxSweepableSources: number;
  private readonly resolved: ResolvedRebuildOptions;

  constructor(
    private readonly client: Client,
    private readonly searchType: SearchType,
    options: InPlaceRebuildOptions = {},
  ) {
    assertNoReservedFields(searchType, [SOURCE_FIELD, LAST_SEEN_FIELD]);
    const {
      maxSweepableSources = DEFAULT_MAX_SWEEPABLE_SOURCES,
      ...rebuildOptions
    } = options;
    this.maxSweepableSources = maxSweepableSources;
    this.resolved = resolveRebuildOptions(searchType, rebuildOptions);
    this.collectionName = this.resolved.definitionOptions.name;
  }

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const { batchSize, lockTtlMs, definitionOptions } = this.resolved;
    const name = this.collectionName;

    return openLockedRun(this.client, name, lockTtlMs, async () => {
      // Create the collection on demand: SearchType schema + the bookkeeping
      // fields, `source` faceted so the membership sweep can enumerate the
      // distinct sources.
      await ensureCollectionExists(this.client, name, () => {
        const definition = buildCollectionDefinition(
          this.searchType,
          definitionOptions,
        );
        const bookkeeping: CollectionFieldSchema[] = [
          { name: SOURCE_FIELD, type: 'string', facet: true },
          { name: LAST_SEEN_FIELD, type: 'string' },
        ];
        return {
          ...definition,
          fields: [...(definition.fields ?? []), ...bookkeeping],
        };
      });

      const importer = new BatchImporter<TDocument & Record<string, string>>(
        this.client,
        name,
        batchSize,
      );

      return {
        write: async (dataset: Dataset, documents: AsyncIterable<TDocument>) =>
          importer.add(
            stampDocuments(documents, {
              [SOURCE_FIELD]: dataset.iri.toString(),
              [LAST_SEEN_FIELD]: context.runId,
            }),
          ),

        flush: async (dataset: Dataset, outcome: DatasetOutcome) => {
          // Land the buffered documents first, so the sweep below never
          // deletes what this run just rewrote.
          await importer.flush();
          if (outcome !== 'success') {
            // A failed dataset’s output is incomplete: sweeping against it
            // would delete documents the run never got to rewrite. Leave the
            // stale ones for the next successful run to reconcile.
            return;
          }
          await deleteByFilter(
            this.client,
            name,
            staleDocumentsFilter(dataset.iri.toString(), context.runId),
          );
        },

        reset: async (dataset: Dataset) => {
          // Discard only this run’s partial writes for the source (the failed
          // endpoint attempt) so the dump re-run rebuilds it cleanly; the
          // source’s prior-run documents stay for the success sweep.
          await importer.flush();
          await deleteByFilter(
            this.client,
            name,
            thisRunDocumentsFilter(dataset.iri.toString(), context.runId),
          );
        },

        commit: async () => {
          await importer.flush();
          const departed = departedSources(
            await this.indexedSources(name, this.maxSweepableSources),
            context.selectedSources(),
          );
          for (const filter of membershipSweepFilters(departed)) {
            await deleteByFilter(this.client, name, filter);
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
}
