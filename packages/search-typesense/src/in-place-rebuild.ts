import type { Client } from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import type { SearchSchema, SearchType } from '@lde/search';
import { facetableFields, physicalFields } from '@lde/search/adapter';
import type { Dataset } from '@lde/dataset';
import type {
  DatasetOutcome,
  RunContext,
  RunWriter,
  Writer,
} from '@lde/pipeline';
import { buildCollectionDefinition } from './collection-definition.js';
import { ensureCollectionExists, openLockedRun, releaseLock } from './lock.js';
import {
  assertBookkeepingPresent,
  assertWritableType,
  openDocuments,
  withBookkeeping,
} from './documents.js';
import {
  resolveRebuildOptions,
  type RebuildOptions,
  type ResolvedRebuildOptions,
} from './rebuild-support.js';

/** {@link InPlaceRebuild} options: the shared rebuild options plus the
 *  membership-sweep ceiling. */
export interface InPlaceRebuildOptions extends RebuildOptions {
  /**
   * Most distinct datasets the membership sweep may enumerate before it throws
   * rather than risk missing departed ones (default 10 000). The sweep needs
   * the complete set to spot which datasets left, so a truncated facet would
   * silently miss deletions. Raise it (up to the engine’s `max_facet_values`
   * limit) before an index approaches it, so the ceiling is a tunable guard
   * rather than a hard wall.
   */
  readonly maxSweepableSources?: number;
}

/**
 * In-place Rebuild (update the live index directly – upsert changed sources,
 * sweep the rest – rather than swap in a fresh one) as a transactional
 * `Writer`: documents are upserted into one long-lived collection with
 * per-dataset atomicity – no swap, no staging. Deletion is a sweep, never
 * special-cased, and {@link openDocuments} decides what a deletion physically
 * is – for a canonically keyed type, dropping one dataset’s membership of a
 * document several datasets share, and the document itself only with the last
 * of them:
 *
 * - a **successful dataset flush** drops what the dataset had and this run did
 *   not rewrite. A failed dataset is not swept – its output is incomplete, and
 *   the next successful run reconciles;
 * - **reset** (the pipeline’s dump-fallback discard) drops only *this run’s*
 *   writes for the dataset, so the dump re-run rebuilds it cleanly while the
 *   dataset’s prior-run documents are left for the success sweep to reconcile;
 * - **commit** drops what belongs to datasets that left the run’s selection
 *   (registry-membership sweep over {@link RunContext.selectedSources}, which
 *   includes datasets skipped as unchanged) and releases the lock;
 * - **abort** only releases the lock: upserts are idempotent, so whatever
 *   landed stays until the next run reconciles.
 *
 * `openRun` takes the single-flight cross-pod lock (throwing
 * `RebuildAlreadyRunning` when another rebuild holds it) and creates
 * the collection on demand from the {@link SearchType} plus the bookkeeping
 * fields. A collection that already exists is used as it is, with two
 * exceptions: it must carry every reference field the declaration asks for and
 * every facet companion its facets read
 * ({@link assertReferencesAndFacetCompanionsPresent}), and the membership field
 * a keyed type records in ({@link assertBookkeepingPresent}) – each failing
 * with the rebuild that fixes it.
 *
 * Unless the type is canonically keyed, document ids must be unique per
 * (dataset, entity) – the caller keys them – or documents from different
 * datasets overwrite each other.
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
  private readonly maxSweepableSources: number | undefined;
  private readonly resolved: ResolvedRebuildOptions;

  constructor(
    private readonly client: Client,
    private readonly searchType: SearchType,
    options: InPlaceRebuildOptions = {},
  ) {
    // The membership sweep enumerates the indexed datasets by faceting the
    // column they are recorded in, so a declared one has to be facetable.
    assertWritableType(searchType, {
      requireFacetable: true,
      schema: options.schema,
    });
    const { maxSweepableSources, ...rebuildOptions } = options;
    this.maxSweepableSources = maxSweepableSources;
    this.resolved = resolveRebuildOptions(searchType, rebuildOptions);
    this.collectionName =
      this.resolved.definitionOptions.collectionNameFor(searchType);
  }

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const { batchSize, lockTtlMs, definitionOptions } = this.resolved;
    const name = this.collectionName;

    return openLockedRun(this.client, name, lockTtlMs, async () => {
      // Create the collection on demand: the SearchType’s schema plus whatever
      // bookkeeping its membership regime keeps.
      const definition = buildCollectionDefinition(
        this.searchType,
        definitionOptions,
      );
      const declaredFields = definition.fields ?? [];
      const created = await ensureCollectionExists(this.client, name, () =>
        withBookkeeping(definition, this.searchType),
      );
      // A collection this run did NOT create may predate a `joinable` being
      // declared, a facet policy on a type this one references, or the type
      // being keyed – and none of the three can be added to it here.
      if (!created) {
        const existing = (await this.client.collections(name).retrieve())
          .fields;
        assertReferencesAndFacetCompanionsPresent(
          name,
          declaredFields,
          facetCompanionsOf(this.searchType, definitionOptions.schema),
          existing,
        );
        assertBookkeepingPresent(this.searchType, existing, name);
      }

      const documents = openDocuments<TDocument>(this.client, name, {
        searchType: this.searchType,
        runId: context.runId,
        startedAt: context.startedAt,
        batchSize,
        maxSweepableSources: this.maxSweepableSources,
      });

      return {
        write: async (dataset: Dataset, items: AsyncIterable<TDocument>) =>
          documents.add(dataset, items),

        flush: async (dataset: Dataset, outcome: DatasetOutcome) => {
          if (outcome !== 'success') {
            // A failed dataset’s output is incomplete: sweeping against it
            // would delete documents the run never got to rewrite. Leave the
            // stale ones for the next successful run to reconcile. The buffered
            // documents stay buffered; the next flush lands them.
            return;
          }
          await documents.dropUnwritten(dataset);
        },

        // Discard only this run’s partial writes for the dataset (the failed
        // endpoint attempt) so the dump re-run rebuilds it cleanly; the
        // dataset’s prior-run documents stay for the success sweep.
        reset: async (dataset: Dataset) =>
          documents.dropWrittenThisRun(dataset),

        commit: async () => {
          await documents.flush();
          await documents.dropUnselected(context.selectedSources());
          await releaseLock(this.client, name);
        },

        abort: async () => {
          await releaseLock(this.client, name);
        },
      };
    });
  }
}

/**
 * Fail loudly when an EXISTING collection does not carry every reference field
 * the declaration asks for, naming the drop-and-rebuild that fixes it. Never
 * alters: an In-place rebuild creates a collection on demand and otherwise
 * leaves its shape alone, and a reference field is the one difference that is
 * not self-correcting.
 *
 * Without this a deployment that added `joinable` to an existing schema would
 * index and commit perfectly happily, and then 400 on every join query – the
 * collection has the *values*, it just has no reference to join through.
 * Failing here keeps the invariant a component-scoped rebuild rests on: a
 * component’s collections come into existence WITH their references, and never
 * acquire them later.
 *
 * The facet companion of a reference inheriting a facet policy
 * (`RootType.facetKeys` on the type it names) is the other field a live
 * collection cannot acquire: the documents carry `${name}_facet`, the
 * collection does not declare it, and every facet on the field fails with
 * *could not find a facet field* – on every type referencing the policy’s
 * type, until someone drops the collection by hand. Rotating a pipeline
 * version reprocesses datasets; it does not recreate collections. So it is
 * checked here too, with the same instruction.
 *
 * Deliberately scoped to those two. Every other schema difference is
 * self-correcting (a new plain field simply starts being written) or
 * harmless, and general drift detection is a feature of its own.
 */
function assertReferencesAndFacetCompanionsPresent(
  name: string,
  fields: readonly CollectionFieldSchema[],
  facetCompanions: readonly string[],
  existingFields: readonly CollectionFieldSchema[],
): void {
  const references = fields.filter((field) => field.reference !== undefined);
  if (references.length === 0 && facetCompanions.length === 0) {
    return;
  }
  const existing = new Map(existingFields.map((field) => [field.name, field]));
  const missingReferences = references.filter(
    (field) => existing.get(field.name)?.reference !== field.reference,
  );
  if (missingReferences.length > 0) {
    throw new Error(
      `Typesense collection “${name}” exists without the reference field(s) ${missingReferences
        .map((field) => `“${field.name}” → “${field.reference as string}”`)
        .join(
          ', ',
        )} its search type declares. A reference cannot be added to a live collection here: drop “${name}” (and the collections that join to it) and let the next run rebuild them.`,
    );
  }
  const missingCompanions = facetCompanions.filter(
    (companion) => existing.get(companion)?.facet !== true,
  );
  if (missingCompanions.length > 0) {
    throw new Error(
      `Typesense collection “${name}” exists without the facet field(s) ${missingCompanions
        .map((companion) => `“${companion}”`)
        .join(
          ', ',
        )} its search type facets on – the companion of a reference to a type that declares a facet policy (“facetKeys”). A facet field cannot be added to a live collection here: drop “${name}” (and the collections that join to it) and let the next run rebuild them.`,
    );
  }
}

/** The `${name}_facet` companions a type’s facets read instead of the fields
 *  themselves – one per facetable reference inheriting a facet policy
 *  ({@link physicalFields}). */
function facetCompanionsOf(
  searchType: SearchType,
  schema: SearchSchema | undefined,
): readonly string[] {
  return facetableFields(searchType).flatMap((field) => {
    // A facetable field always has a facet field.
    const facet = physicalFields(field, schema).facet as string;
    return facet === field.name ? [] : [facet];
  });
}
