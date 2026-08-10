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
import { BatchImporter } from './import.js';
import { httpStatus, openLockedRun, releaseLock } from './lock.js';
import {
  SOURCE_FIELD,
  provenanceField,
  sourceDocumentsFilter,
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
  /** The column this collection carries its documents’ dataset IRI in: the
   *  type’s declared dataset field, or the private `source` when it declares
   *  none. Both the stamp and the per-dataset rollback filter read it. */
  private readonly sourceField: string;

  constructor(
    private readonly client: Client,
    private readonly searchType: SearchType,
    options: BlueGreenRebuildOptions = {},
  ) {
    // `source` is stamped on every document for per-dataset rollback.
    assertNoReservedFields(searchType, [SOURCE_FIELD]);
    // Rollback filters by a known dataset IRI rather than enumerating the
    // indexed ones, so a declared field need not be facetable here.
    assertSweepableProvenanceField(searchType, { requireFacetable: false });
    this.sourceField = provenanceField(searchType);
    this.resolved = resolveRebuildOptions(searchType, options);
    this.collectionName =
      this.resolved.definitionOptions.collectionNameFor(searchType);
  }

  async openRun(context: RunContext): Promise<RunWriter<TDocument>> {
    const { batchSize, lockTtlMs, definitionOptions } = this.resolved;
    const name = this.collectionName;
    const sourceField = this.sourceField;

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
      await this.client.collections().create({
        ...definition,
        // The private `source` only when the type declares no dataset field of
        // its own; a declared one is already in the definition and carries the
        // same IRI.
        fields: [
          ...(definition.fields ?? []),
          ...(sourceField === SOURCE_FIELD
            ? [{ name: SOURCE_FIELD, type: 'string' } as const]
            : []),
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
          sourceDocumentsFilter(sourceField, dataset.iri.toString()),
        );
      };

      return {
        write: async (dataset: Dataset, documents: AsyncIterable<TDocument>) =>
          importer.add(
            stampDocuments(documents, {
              [sourceField]: dataset.iri.toString(),
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
