// The documents a run writes into one collection, and every decision about
// which of them leave it. Owns the private bookkeeping columns, the batching,
// and the two regimes a collection can be in – a document belongs to one
// dataset, or several reference it – so a writer states *what* should go and
// never *how* it is stored.

import type { Client, CollectionCreateSchema } from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';
import type { Dataset } from '@lde/dataset';
import type { RootType, SearchSchema, SearchType } from '@lde/search';
import {
  datasetField,
  isInternalField,
  physicalFields,
} from '@lde/search/adapter';
import { escapeFilterValue } from './query-compiler.js';

/** The private field carrying the dataset IRI a document came from, in a
 *  collection whose documents each belong to one dataset. */
const SOURCE_FIELD = 'source';

/** The private field carrying the id of the run that last wrote a document,
 *  beside {@link SOURCE_FIELD}. */
const LAST_SEEN_FIELD = 'last_seen';

/** The private field carrying the datasets that reference a document, in a
 *  collection keyed on a canonical identifier: one `{ dataset, run }` element
 *  per referring dataset. */
const REFERENCED_BY_FIELD = 'referenced_by';

/** Documents read back per round-trip while retracting a dataset – the unit of
 *  work the sweep’s memory is bounded by, and Typesense’s `per_page` ceiling. */
const RETRACTION_PAGE = 250;

/** Ids per `multi_search` entry when reading membership back before a write. */
const LOOKUP_BATCH = 200;

/** Stay well under Typesense’s ~4000-char URL query-string limit per delete. */
const MAX_FILTER_VALUES_LENGTH = 3000;

/**
 * Default ceiling on the distinct datasets a collection may hold before the
 * membership sweep refuses to guess. The sweep needs the complete set to spot
 * the ones that left, so a truncated facet would silently miss deletions.
 */
export const DEFAULT_MAX_SWEEPABLE_SOURCES = 10_000;

/** What {@link openDocuments} needs to know about the run it serves. */
export interface RunDocumentsOptions {
  /** The type whose collection this is; its `key` chooses the regime. */
  readonly searchType: SearchType;
  /** The run’s id, stamped on documents of a single-dataset collection. */
  readonly runId: string;
  /** The run’s ISO 8601 start, the ordered stamp a keyed collection records –
   *  see {@link openDocuments}. */
  readonly startedAt: string;
  /** Documents per Typesense import request. */
  readonly batchSize: number;
  /** Most distinct datasets {@link RunDocuments.dropUnselected} may enumerate
   *  before it throws rather than risk missing one that left. */
  readonly maxSweepableSources?: number;
}

/**
 * One run’s writes into one collection, plus the four questions a writer can
 * ask about what should leave it. Every one is phrased about *datasets*, never
 * about filters or fields: which column carries membership, whether a document
 * is owned or shared, and what a deletion physically is, are this module’s.
 *
 * The one ordering rule a caller must hold: {@link add} buffers, so anything
 * that drops documents needs the buffer landed first. Each `drop` does that
 * itself; a caller only needs {@link flush} before it finishes the run.
 */
export interface RunDocuments<TDocument extends { id: string }> {
  /** Write a dataset’s documents, batched. */
  add(dataset: Dataset, documents: AsyncIterable<TDocument>): Promise<void>;
  /** Land whatever is still buffered. */
  flush(): Promise<void>;
  /**
   * Drop what this dataset had and this run did not rewrite – the sweep after
   * a dataset succeeds. A document another dataset still references survives,
   * having lost only this one’s membership.
   */
  dropUnwritten(dataset: Dataset): Promise<void>;
  /**
   * Drop only what this run wrote for the dataset, keeping its earlier
   * documents – the pipeline’s dump-fallback discard.
   */
  dropWrittenThisRun(dataset: Dataset): Promise<void>;
  /** Drop everything this dataset contributed, whenever it was written. */
  dropAll(dataset: Dataset): Promise<void>;
  /**
   * Drop what belongs to datasets outside the run’s selection: the registry
   * membership sweep. Enumerating what the collection holds is this module’s
   * business, and so is refusing to sweep when it cannot see all of it.
   *
   * @param selectedDatasets Every dataset IRI the run’s selector produced,
   *   including datasets skipped as unchanged – selection is membership.
   */
  dropUnselected(selectedDatasets: Iterable<string>): Promise<void>;
}

/**
 * Open a run’s documents on a collection.
 *
 * Two regimes, chosen once from the type and never surfaced again:
 *
 * - a type with no {@link RootType.key} keys every document on its own node
 *   IRI, so a document belongs to exactly one dataset. It is stamped with that
 *   dataset and the run id, and a drop is a delete.
 * - a **canonically keyed** type keys documents on an identifier several
 *   datasets can share – two datasets referencing the same GeoNames place
 *   produce one document. Membership is therefore a set: a write **adds** the
 *   dataset to `referenced_by`, a drop **removes** it, and the document is
 *   deleted when the last referring dataset goes. That is what stops one
 *   dataset’s sweep from deleting what another still points at, without any
 *   special case for a dataset skipped as unchanged – its membership simply
 *   stays, untouched by anyone else’s sweep.
 *
 * The run is recorded on a keyed collection as `Date.parse(startedAt)` rather
 * than as the run id, because *this dataset did not write it this run* has to
 * be asked of one element of a nested array, and Typesense correlates a
 * comparison within an element but **not** a negation – `run:<thisRun`
 * correlates, `run:!=thisRun` silently answers at document level and sweeps
 * nothing. See `test/membership-filters.integration.test.ts`, where both are
 * pinned against the engine.
 */
export function openDocuments<TDocument extends { id: string }>(
  client: Client,
  collection: string,
  options: RunDocumentsOptions,
): RunDocuments<TDocument> {
  return keyOf(options.searchType) === undefined
    ? ownedDocuments(client, collection, options)
    : sharedDocuments(client, collection, options);
}

/**
 * The collection definition plus the bookkeeping a writer keeps on it: the
 * private membership columns, and the nesting a keyed collection’s
 * `referenced_by` needs enabled.
 *
 * A single-dataset collection carries `source` only when the type declares no
 * dataset field of its own; when it does, that field already holds the same
 * IRI ({@link provenanceFieldOf}) and a second column would be the same value
 * twice, free to drift.
 */
export function withBookkeeping(
  definition: CollectionCreateSchema,
  searchType: SearchType,
): CollectionCreateSchema {
  const fields: CollectionFieldSchema[] = [...(definition.fields ?? [])];
  if (keyOf(searchType) !== undefined) {
    return {
      ...definition,
      enable_nested_fields: true,
      fields: [
        ...fields,
        { name: REFERENCED_BY_FIELD, type: 'object[]' },
        {
          name: `${REFERENCED_BY_FIELD}.dataset`,
          type: 'string[]',
          facet: true,
        },
        { name: `${REFERENCED_BY_FIELD}.run`, type: 'int64[]' },
      ],
    };
  }
  return {
    ...definition,
    fields: [
      ...fields,
      ...(provenanceFieldOf(searchType) === SOURCE_FIELD
        ? [{ name: SOURCE_FIELD, type: 'string', facet: true } as const]
        : []),
      { name: LAST_SEEN_FIELD, type: 'string' },
    ],
  };
}

/**
 * Reject a {@link SearchType} whose declaration cannot carry this module’s
 * bookkeeping, at writer construction – so it fails before a run touches the
 * index rather than at the sweep, after the writes.
 *
 * A **canonically keyed** type may not declare a field over the dataset. Such a
 * field asks *which dataset is this document’s*, and a document several
 * datasets share has no answer: it would hold whichever wrote last, and a user
 * filtering by one of the others would silently miss it.
 *
 * A single-dataset type declaring one makes it the collection’s provenance
 * column, so it has to answer that question the way the private `source` did:
 * not `array` (Typesense reads `field:=[a,b]` over a `string[]` as *contains
 * any*, so a departed dataset would take every document merely mentioning it);
 * no `transform` (the sweep matches the stored value against the run’s raw
 * dataset IRIs); and `facetable` on its own name where the writer enumerates
 * the indexed datasets by faceting it – a reference inheriting a facet policy
 * facets a companion holding only the admitted keys, so enumerating through it
 * would miss every dataset the policy excludes.
 *
 * @param requireFacetable Whether this writer enumerates the indexed datasets
 *   ({@link RunDocuments.dropUnselected}); a writer that only ever filters by a
 *   known IRI does not need the column facetable.
 */
export function assertWritableType(
  searchType: SearchType,
  options: {
    readonly requireFacetable: boolean;
    readonly schema?: SearchSchema;
  },
): void {
  const keyed = keyOf(searchType) !== undefined;
  const reserved = keyed
    ? [REFERENCED_BY_FIELD]
    : [SOURCE_FIELD, LAST_SEEN_FIELD];
  const clashing = searchType.fields.filter((field) =>
    reserved.includes(field.name),
  );
  if (clashing.length > 0) {
    throw new Error(
      `SearchType “${searchType.name}” declares reserved bookkeeping field(s) ${clashing
        .map((field) => `“${field.name}”`)
        .join(', ')}`,
    );
  }
  const declared = datasetField(searchType);
  if (declared === undefined || isInternalField(declared)) {
    return;
  }
  if (keyed) {
    throw new Error(
      `SearchType “${searchType.name}” is keyed on “${(searchType as RootType).key?.field}”, so several datasets can share one document, and “${declared.name}” over the indexed dataset would hold whichever of them wrote it last – a filter on any of the others would then miss the document. Drop the field: a keyed collection records every dataset that references a document.`,
    );
  }
  const problems: string[] = [];
  if (declared.array === true) {
    problems.push(
      'it is an array, and a membership sweep over one would delete every document merely mentioning a departed dataset',
    );
  }
  if (declared.transform !== undefined) {
    problems.push(
      'it declares a transform, and the sweep matches the stored value against the run’s raw dataset IRIs',
    );
  }
  if (options.requireFacetable && declared.facetable !== true) {
    problems.push(
      'it is not facetable, and the membership sweep enumerates the indexed datasets by faceting it',
    );
  } else if (
    options.requireFacetable &&
    physicalFields(declared, options.schema).facet !== declared.name
  ) {
    problems.push(
      'it inherits a facet policy from the type it names, so the engine facets only the datasets the policy admits, and the membership sweep enumerates the indexed datasets by faceting it',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `SearchType “${searchType.name}” declares “${declared.name}” over the indexed dataset, which this writer keeps its provenance bookkeeping on, but ${problems.join('; and ')}.`,
    );
  }
}

/**
 * Fail an EXISTING collection that predates its type being canonically keyed,
 * naming the two steps that fix it.
 *
 * The field cannot be added: nesting is a create-time collection setting, and
 * even where it could be it would be **empty** on every document already
 * indexed. Membership is only written by a dataset that reprocesses, and
 * skip-unchanged means most do not – so those documents would match no
 * dataset, never be retracted and never be collected, while looking perfectly
 * healthy. Dropping the collection alone has the same hole: a rebuilt
 * collection is repopulated only by datasets that changed, so the pipeline
 * version has to rotate with it to force every dataset through.
 */
export function assertBookkeepingPresent(
  searchType: SearchType,
  existing: readonly CollectionFieldSchema[],
  collection: string,
): void {
  if (keyOf(searchType) === undefined) {
    return;
  }
  const names = new Set(existing.map((field) => field.name));
  if (names.has(`${REFERENCED_BY_FIELD}.dataset`)) {
    return;
  }
  throw new Error(
    `Typesense collection “${collection}” exists without the “${REFERENCED_BY_FIELD}” field its keyed SearchType “${searchType.name}” records membership in, so nothing in it can be swept. It cannot be added to a live collection, and would be empty on every document already indexed: drop “${collection}” (and the collections that join to it) and rotate the pipeline version, so the next run reprocesses every dataset and rebuilds them.`,
  );
}

/** The dataset column a single-dataset collection carries: the type’s declared
 *  dataset field, or the private `source` when it declares none. */
function provenanceFieldOf(searchType: SearchType): string {
  const declared = datasetField(searchType);
  return declared === undefined || isInternalField(declared)
    ? SOURCE_FIELD
    : declared.name;
}

/** A type’s {@link RootType.key}, for the types that can have one. */
function keyOf(searchType: SearchType): RootType['key'] {
  return (searchType as RootType).key;
}

/** One dataset’s membership of a shared document, and when it last wrote it. */
interface Referrer {
  readonly dataset: string;
  readonly run: number;
}

/**
 * A collection whose documents each belong to one dataset: stamped with it and
 * the run, dropped by deleting them. What every collection did before keying
 * existed, and still the regime for every type that declares no `key`.
 */
function ownedDocuments<TDocument extends { id: string }>(
  client: Client,
  collection: string,
  options: RunDocumentsOptions,
): RunDocuments<TDocument> {
  const { searchType, runId, batchSize } = options;
  const field = provenanceFieldOf(searchType);
  const buffer = new Batch<Record<string, unknown>>(batchSize);
  const run = escapeFilterValue(runId);
  const of = (dataset: Dataset) =>
    `${field}:=${escapeFilterValue(dataset.iri.toString())}`;

  const land = async () => {
    const batch = buffer.take();
    if (batch.length > 0) {
      await importDocuments(client, collection, batch, 'upsert');
    }
  };
  const drop = async (filter: string) => {
    await land();
    await deleteByFilter(client, collection, filter);
  };

  return {
    // Stamping the dataset column here – rather than trusting the projection to
    // have filled a declared one – is what keeps the sweep total: a caller
    // projecting without a dataset context, or a document reaching the writer
    // any other way, still lands sweepable. Where the projection did fill it,
    // the value is the same IRI, so the stamp only reasserts it.
    //
    // It reasserts the sweep’s column only, never the physical fanout a
    // declared field also produces (the folded `${name}_search` companion of a
    // searchable one). Folding is the projection’s convention, and restating it
    // here would put it in two places. So a document that reached the writer
    // unprojected is sweepable but not full-text findable by dataset: absent,
    // never wrong.
    add: async (dataset, documents) => {
      const stamp = {
        [field]: dataset.iri.toString(),
        [LAST_SEEN_FIELD]: runId,
      };
      for await (const document of documents) {
        buffer.push({ ...document, ...stamp });
        if (buffer.full()) {
          await land();
        }
      }
    },
    flush: land,
    dropUnwritten: async (dataset) =>
      drop(`${of(dataset)} && ${LAST_SEEN_FIELD}:!=${run}`),
    dropWrittenThisRun: async (dataset) =>
      drop(`${of(dataset)} && ${LAST_SEEN_FIELD}:=${run}`),
    dropAll: async (dataset) => drop(of(dataset)),
    dropUnselected: async (selectedDatasets) => {
      await land();
      const departed = await departedDatasets(
        client,
        collection,
        field,
        selectedDatasets,
        options.maxSweepableSources ?? DEFAULT_MAX_SWEEPABLE_SOURCES,
      );
      for (const chunk of chunked(departed)) {
        await deleteByFilter(
          client,
          collection,
          `${field}:=[${chunk.join(',')}]`,
        );
      }
    },
  };
}

/**
 * A collection keyed on a canonical identifier, where one document can be
 * reached from several datasets. Membership is the set of datasets referencing
 * it; a drop retracts one dataset’s entry and deletes only what nobody is left
 * referencing.
 */
function sharedDocuments<TDocument extends { id: string }>(
  client: Client,
  collection: string,
  options: RunDocumentsOptions,
): RunDocuments<TDocument> {
  const { batchSize } = options;
  const run = Date.parse(options.startedAt);
  const facet = `${REFERENCED_BY_FIELD}.dataset`;
  const buffer = new Batch<{
    readonly document: TDocument;
    readonly dataset: string;
  }>(batchSize);
  const referencing = (datasets: readonly string[]) =>
    `${facet}:=[${datasets.map(escapeFilterValue).join(',')}]`;

  /**
   * Land a batch, adding each document’s dataset to the membership already
   * stored. Typesense replaces a whole document on upsert and has no way to
   * append to an array, so the set has to be read back first – one
   * `multi_search` per batch, against the ids the batch carries.
   */
  const land = async () => {
    const batch = buffer.take();
    if (batch.length === 0) {
      return;
    }
    // Two nodes of one dataset, or two datasets, can key onto one document
    // within a single batch. Later content wins, as a merged document always
    // does – but membership is the union, or the second would erase the first.
    const merged = new Map<
      string,
      { document: TDocument; datasets: string[] }
    >();
    for (const { document, dataset } of batch) {
      const seen = merged.get(document.id);
      merged.set(document.id, {
        document,
        datasets:
          seen === undefined
            ? [dataset]
            : seen.datasets.includes(dataset)
              ? seen.datasets
              : [...seen.datasets, dataset],
      });
    }
    const stored = await storedMembership(client, collection, [
      ...merged.keys(),
    ]);
    await importDocuments(
      client,
      collection,
      [...merged.values()].map(({ document, datasets }) => ({
        ...document,
        [REFERENCED_BY_FIELD]: [
          ...(stored.get(document.id) ?? []).filter(
            (referrer) => !datasets.includes(referrer.dataset),
          ),
          ...datasets.map((dataset) => ({ dataset, run })),
        ],
      })),
      'upsert',
    );
  };

  /**
   * Take the datasets out of every document the filter selects, deleting the
   * documents left with no referrer.
   *
   * The filter is re-asked from the first page each round rather than
   * paginated: a document this pass touches stops matching it, so the loop
   * drains, its memory is one page whatever the collection holds, and deep
   * pagination never comes into it. A round that changes nothing would spin,
   * so it throws instead.
   */
  const retract = async (filter: string, datasets: readonly string[]) => {
    await land();
    for (;;) {
      const page = await search(client, collection, {
        filter_by: filter,
        include_fields: `id,${REFERENCED_BY_FIELD}`,
        per_page: RETRACTION_PAGE,
      });
      const hits = (page.hits ?? []).map((hit) => hit.document);
      if (hits.length === 0) {
        return;
      }
      const keeping: Record<string, unknown>[] = [];
      const emptied: string[] = [];
      for (const document of hits) {
        const referrers = referrersOf(document);
        const remaining = referrers.filter(
          (referrer) => !datasets.includes(referrer.dataset),
        );
        if (remaining.length === referrers.length) {
          // Selected, yet carries none of the datasets being retracted: writing
          // it back would change nothing and it would match again next round.
          continue;
        }
        if (remaining.length === 0) {
          emptied.push(String(document.id));
        } else {
          keeping.push({
            id: document.id,
            [REFERENCED_BY_FIELD]: remaining,
          });
        }
      }
      if (keeping.length === 0 && emptied.length === 0) {
        throw new Error(
          `Retracting ${datasets.join(', ')} from “${collection}” selected ${hits.length} document(s) carrying none of them, so the sweep cannot make progress.`,
        );
      }
      if (keeping.length > 0) {
        await importDocuments(client, collection, keeping, 'update');
      }
      for (const chunk of chunked(emptied.map(escapeFilterValue))) {
        await deleteByFilter(client, collection, `id:=[${chunk.join(',')}]`);
      }
    }
  };

  return {
    add: async (dataset, documents) => {
      const iri = dataset.iri.toString();
      for await (const document of documents) {
        buffer.push({ document, dataset: iri });
        if (buffer.full()) {
          await land();
        }
      }
    },
    flush: land,
    dropUnwritten: async (dataset) => {
      const iri = dataset.iri.toString();
      await retract(
        `${REFERENCED_BY_FIELD}.{dataset:=${escapeFilterValue(iri)} && run:<${run}}`,
        [iri],
      );
    },
    dropWrittenThisRun: async (dataset) => {
      const iri = dataset.iri.toString();
      await retract(
        `${REFERENCED_BY_FIELD}.{dataset:=${escapeFilterValue(iri)} && run:=${run}}`,
        [iri],
      );
    },
    dropAll: async (dataset) => {
      const iri = dataset.iri.toString();
      await retract(referencing([iri]), [iri]);
    },
    dropUnselected: async (selectedDatasets) => {
      await land();
      const departed = await departedDatasets(
        client,
        collection,
        facet,
        selectedDatasets,
        options.maxSweepableSources ?? DEFAULT_MAX_SWEEPABLE_SOURCES,
      );
      // Every departed dataset at once: one document can be referenced by
      // several of them, and retracting them together spares it a second pass.
      for (const chunk of chunked(departed.map(escapeFilterValue))) {
        await retract(`${facet}:=[${chunk.join(',')}]`, departed);
      }
    },
  };
}

/** The membership stored for these ids, read back before a write adds to it. */
async function storedMembership(
  client: Client,
  collection: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly Referrer[]>> {
  const searches = [];
  for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
    const batch = ids.slice(start, start + LOOKUP_BATCH);
    searches.push({
      collection,
      q: '*',
      filter_by: `id:[${batch.map(escapeFilterValue).join(',')}]`,
      include_fields: `id,${REFERENCED_BY_FIELD}`,
      per_page: batch.length,
    });
  }
  const { results } = (await client.multiSearch.perform({ searches })) as {
    results: readonly {
      hits?: readonly { document: Record<string, unknown> }[];
      error?: string;
    }[];
  };
  const membership = new Map<string, readonly Referrer[]>();
  for (const result of results) {
    // multi_search reports a failed entry inline instead of rejecting. A lost
    // entry would silently drop the membership of everything it covered, so it
    // is raised rather than skipped.
    if (result.error !== undefined) {
      throw new Error(
        `Reading membership from “${collection}” failed: ${result.error}`,
      );
    }
    for (const hit of result.hits ?? []) {
      membership.set(String(hit.document.id), referrersOf(hit.document));
    }
  }
  return membership;
}

/** The referrers stored on a document, ignoring anything malformed. */
function referrersOf(document: Record<string, unknown>): readonly Referrer[] {
  const stored = document[REFERENCED_BY_FIELD];
  return (Array.isArray(stored) ? stored : []).filter(
    (referrer): referrer is Referrer =>
      typeof referrer === 'object' &&
      referrer !== null &&
      typeof (referrer as Referrer).dataset === 'string',
  );
}

/**
 * The datasets a collection holds that the run’s selection does not, via a
 * single facet over its membership column.
 *
 * Asks for one bucket beyond the ceiling so genuine truncation is
 * distinguishable from an exactly-full result: `maxDatasets` buckets are
 * returned intact, one more proves the sweep would miss some, so it throws
 * rather than delete blind.
 */
async function departedDatasets(
  client: Client,
  collection: string,
  facetField: string,
  selectedDatasets: Iterable<string>,
  maxDatasets: number,
): Promise<string[]> {
  const response = await search(client, collection, {
    per_page: 0,
    facet_by: facetField,
    max_facet_values: maxDatasets + 1,
  });
  const counts = response.facet_counts?.[0]?.counts ?? [];
  if (counts.length > maxDatasets) {
    throw new Error(
      `Membership sweep cannot see beyond ${maxDatasets} distinct datasets in “${collection}”; raise maxSweepableSources or departed datasets might be missed`,
    );
  }
  const selected = new Set(selectedDatasets);
  return counts
    .map((count) => count.value)
    .filter((dataset) => !selected.has(dataset));
}

/** Escaped values grouped into filters that fit a URL query string. */
function* chunked(values: readonly string[]): Generator<string[]> {
  let chunk: string[] = [];
  let length = 0;
  for (const value of values) {
    if (length + value.length > MAX_FILTER_VALUES_LENGTH && chunk.length > 0) {
      yield chunk;
      chunk = [];
      length = 0;
    }
    chunk.push(value);
    length += value.length + 1;
  }
  if (chunk.length > 0) {
    yield chunk;
  }
}

/** Accumulates items until a batch is full. */
class Batch<TItem> {
  private items: TItem[] = [];

  constructor(private readonly size: number) {}

  push(item: TItem): void {
    this.items.push(item);
  }

  full(): boolean {
    return this.items.length >= this.size;
  }

  /** The accumulated items, emptying the batch. */
  take(): TItem[] {
    const items = this.items;
    this.items = [];
    return items;
  }
}

/**
 * Import one batch, throwing if any individual document fails – Typesense’s
 * bulk import otherwise reports per-document failures without rejecting, which
 * would turn a rejected write into silently missing data.
 */
async function importDocuments(
  client: Client,
  collection: string,
  batch: readonly Record<string, unknown>[],
  action: 'upsert' | 'update',
): Promise<void> {
  const results = (await client
    .collections(collection)
    .documents()
    .import(batch as Record<string, unknown>[], {
      action,
      throwOnFail: false,
    })) as { success: boolean; error?: string }[];
  const failures = results.filter((result) => !result.success);
  if (failures.length > 0) {
    throw new Error(
      `Typesense ${action} into “${collection}” failed for ${failures.length}/${results.length} documents: ${failures
        .map((failure) => failure.error)
        .join('; ')}`,
    );
  }
}

/** A whole-collection search; `q: '*'` needs no field to query by. */
async function search(
  client: Client,
  collection: string,
  parameters: Record<string, unknown>,
): Promise<{
  hits?: readonly { document: Record<string, unknown> }[];
  facet_counts?: readonly { counts: readonly { value: string }[] }[];
}> {
  return (await client
    .collections(collection)
    .documents()
    .search({ q: '*', ...parameters } as never)) as never;
}

/** Delete a collection’s documents matching a Typesense filter. */
async function deleteByFilter(
  client: Client,
  collection: string,
  filterBy: string,
): Promise<void> {
  await client
    .collections(collection)
    .documents()
    .delete({ filter_by: filterBy });
}
