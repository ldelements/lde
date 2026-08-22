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
import { BatchImporter } from './import.js';
import { ensureCollectionExists, openLockedRun, releaseLock } from './lock.js';
import {
  LAST_SEEN_FIELD,
  SOURCE_FIELD,
  departedSources,
  membershipSweepFilters,
  provenanceField,
  staleDocumentsFilter,
  thisRunDocumentsFilter,
} from './sweep.js';
import {
  assertNoReservedFields,
  assertSweepableProvenanceField,
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
 * bookkeeping fields. A collection that already exists is used as it is, with
 * one exception: it must carry every reference field the declaration asks for
 * and every facet companion its facets read, or the run fails with the
 * drop-and-rebuild that fixes it
 * ({@link assertReferencesAndFacetCompanionsPresent}).
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
  /** The column this collection carries its documents’ dataset IRI in: the
   *  type’s declared dataset field, or the private `source` when it declares
   *  none. Everything below – the stamp, every sweep filter, the source
   *  enumeration – reads this one name. */
  private readonly sourceField: string;

  constructor(
    private readonly client: Client,
    private readonly searchType: SearchType,
    options: InPlaceRebuildOptions = {},
  ) {
    assertNoReservedFields(searchType, [SOURCE_FIELD, LAST_SEEN_FIELD]);
    assertSweepableProvenanceField(searchType, {
      requireFacetable: true,
      schema: options.schema,
    });
    this.sourceField = provenanceField(searchType);
    const {
      maxSweepableSources = DEFAULT_MAX_SWEEPABLE_SOURCES,
      ...rebuildOptions
    } = options;
    this.maxSweepableSources = maxSweepableSources;
    this.resolved = resolveRebuildOptions(searchType, rebuildOptions);
    this.collectionName =
      this.resolved.definitionOptions.collectionNameFor(searchType);
  }

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const { batchSize, lockTtlMs, definitionOptions } = this.resolved;
    const name = this.collectionName;
    const sourceField = this.sourceField;

    return openLockedRun(this.client, name, lockTtlMs, async () => {
      // Create the collection on demand: SearchType schema + the bookkeeping
      // fields. The private `source` – faceted so the membership sweep can
      // enumerate the distinct sources – only when the type declares no dataset
      // field of its own; when it does, that declared field already carries the
      // IRI (and its own `facet: true`), and a second column would be the same
      // value twice, free to drift.
      const definition = buildCollectionDefinition(
        this.searchType,
        definitionOptions,
      );
      const declaredFields = definition.fields ?? [];
      const created = await ensureCollectionExists(this.client, name, () => {
        const bookkeeping: CollectionFieldSchema[] = [
          ...(sourceField === SOURCE_FIELD
            ? [{ name: SOURCE_FIELD, type: 'string', facet: true } as const]
            : []),
          { name: LAST_SEEN_FIELD, type: 'string' },
        ];
        return {
          ...definition,
          fields: [...declaredFields, ...bookkeeping],
        };
      });
      // A collection this run did NOT create may predate a `joinable` being
      // declared, or a facet policy on a type this one references – and
      // neither a reference nor a facet companion can be added to it here.
      if (!created) {
        await assertReferencesAndFacetCompanionsPresent(
          this.client,
          name,
          declaredFields,
          facetCompanionsOf(this.searchType, definitionOptions.schema),
        );
      }

      const importer = new BatchImporter<TDocument & Record<string, string>>(
        this.client,
        name,
        batchSize,
      );

      return {
        // Stamping the provenance field – rather than trusting the projection
        // to have filled a declared one – is what keeps the sweep total: a
        // caller projecting without a dataset context, or a document reaching
        // the writer any other way, still lands in a swept collection. Where
        // the projection did fill it, the value is the same dataset IRI, so the
        // stamp only ever reasserts it.
        //
        // It reasserts the sweep’s column only, never the physical fanout a
        // declared field also produces (the folded `${name}_search` companion
        // of a `searchable` one). Folding is the projection’s convention, and
        // restating it here would put it in two places – the split this change
        // exists to close. So a document that reached the writer unprojected is
        // sweepable but not full-text findable by dataset: absent, never wrong.
        write: async (dataset: Dataset, documents: AsyncIterable<TDocument>) =>
          importer.add(
            stampDocuments(documents, {
              [sourceField]: dataset.iri.toString(),
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
            staleDocumentsFilter(
              sourceField,
              dataset.iri.toString(),
              context.runId,
            ),
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
            thisRunDocumentsFilter(
              sourceField,
              dataset.iri.toString(),
              context.runId,
            ),
          );
        },

        commit: async () => {
          await importer.flush();
          const departed = departedSources(
            await this.indexedSources(name, this.maxSweepableSources),
            context.selectedSources(),
          );
          for (const filter of membershipSweepFilters(sourceField, departed)) {
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
   * The distinct sources present in the collection, via a single facet over its
   * {@link provenanceField}. Requests one bucket beyond `maxSources` so genuine truncation is
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
        query_by: this.sourceField,
        per_page: 0,
        facet_by: this.sourceField,
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
async function assertReferencesAndFacetCompanionsPresent(
  client: Client,
  name: string,
  fields: readonly CollectionFieldSchema[],
  facetCompanions: readonly string[],
): Promise<void> {
  const references = fields.filter((field) => field.reference !== undefined);
  if (references.length === 0 && facetCompanions.length === 0) {
    return;
  }
  const existing = new Map(
    (await client.collections(name).retrieve()).fields.map((field) => [
      field.name,
      field,
    ]),
  );
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
