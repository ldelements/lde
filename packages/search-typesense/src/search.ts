import type { Client } from 'typesense';
import {
  fieldNamed,
  isRangeFacet,
  outputFields,
  physicalFields,
  referenceFields,
  type FacetBucket,
  type Filter,
  type LocalizedValue,
  type Reference,
  type ResultDocument,
  type SearchEngine,
  type SearchField,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SearchType,
  type SearchValue,
} from '@lde/search';
import { buildSearchParams, escapeFilterValue } from './query-compiler.js';

/** Where the engine reads documents and (optionally) reference labels. */
export interface TypesenseSearchEngineOptions {
  /** The dataset collection or alias to query. */
  readonly collection: string;
  /** The sidecar `labels` collection (IRI → label); omit for id-only references. */
  readonly labelsCollection?: string;
  /**
   * Buckets returned per facet (`max_facet_values`). Typesense defaults to 10;
   * raise it for high-cardinality facets (publisher, keyword) so their long
   * value lists are not truncated.
   */
  readonly maxFacetValues?: number;
  /**
   * Called when reference-label resolution fails; the search then degrades to
   * id-only references rather than failing. Optional — omit to swallow silently.
   */
  readonly onLabelError?: (error: unknown) => void;
  /**
   * Called for each `where` clause the query compiler skips instead of sending
   * to the engine (unknown field, operator not matching the field’s kind, empty
   * `in` list or `range` bounds). Optional — omit to swallow silently.
   */
  readonly onIgnoredFilter?: (filter: Filter) => void;
  /**
   * Opt-in in-memory label cache. When set (and {@link labelsCollection} is
   * set), the FULL sidecar `labels` collection is loaded once via the documents
   * export endpoint and held in a process-lifetime cache for this many
   * milliseconds; each `search` then resolves its reference labels by in-memory
   * lookup instead of a per-search `multi_search` round-trip. Omit to keep the
   * per-search {@link fetchLabels} behaviour unchanged.
   */
  readonly labelCacheTtlMs?: number;
}

/**
 * A Typesense-backed {@link SearchEngine}. `search` compiles the query
 * ({@link buildSearchParams}), runs it, resolves the reference labels for the
 * page of hits from the sidecar `labels` collection in one lookup, and
 * reconstructs the engine-neutral {@link SearchResult} ({@link parseSearchResponse}).
 * Every engine specific stays here; consumers see only logical documents.
 */
export function createTypesenseSearchEngine(
  client: Client,
  options: TypesenseSearchEngineOptions,
): SearchEngine {
  // Process-lifetime cache for the FULL `labels` collection, held in the engine
  // closure. Populated lazily on the first cached search; `loadAll` is the
  // single-flight in-flight promise so concurrent first-loads share one export.
  let cachedLabels: ReadonlyMap<string, LocalizedValue> | undefined;
  let cacheExpiresAt = 0;
  let inFlightLoad: Promise<ReadonlyMap<string, LocalizedValue>> | undefined;

  function cachedAllLabels(
    labelsCollection: string,
    ttlMs: number,
  ): Promise<ReadonlyMap<string, LocalizedValue>> {
    if (cachedLabels !== undefined && Date.now() < cacheExpiresAt) {
      return Promise.resolve(cachedLabels);
    }
    // Single-flight: a load already running serves every concurrent caller.
    inFlightLoad ??= loadAllLabels(client, labelsCollection)
      .then((loaded) => {
        cachedLabels = loaded;
        cacheExpiresAt = Date.now() + ttlMs;
        return loaded;
      })
      // A failed load degrades to id-only references and is NOT cached, so the
      // next search retries rather than serving an empty map for the whole TTL.
      .catch((error) => {
        options.onLabelError?.(error);
        return new Map<string, LocalizedValue>();
      })
      .finally(() => {
        inFlightLoad = undefined;
      });
    return inFlightLoad;
  }

  return {
    async search(
      query: SearchQuery,
      searchType: SearchType,
    ): Promise<SearchResult> {
      const params = buildSearchParams(query, searchType, {
        maxFacetValues: options.maxFacetValues,
        onIgnoredFilter: options.onIgnoredFilter,
      });
      // Cached path: the once-loaded full collection serves labels by in-memory
      // lookup (no per-search round-trip). The load does not depend on the
      // response, so it runs alongside the search; it never rejects (a failed
      // load degrades to an empty map), so it cannot leave an unhandled
      // rejection behind if the search itself fails.
      const cachedLabelsPromise =
        options.labelsCollection !== undefined &&
        options.labelCacheTtlMs !== undefined
          ? cachedAllLabels(options.labelsCollection, options.labelCacheTtlMs)
          : undefined;
      const response = (await client
        .collections(options.collection)
        .documents()
        .search(params)) as TypesenseSearchResponse;
      // Labels are supplementary: a failed lookup (e.g. the sidecar collection
      // mid-rebuild) degrades to id-only references rather than failing the whole
      // search, so the listing still renders with bare IRIs.
      let labels: ReadonlyMap<string, LocalizedValue> = new Map();
      if (cachedLabelsPromise !== undefined) {
        labels = await cachedLabelsPromise;
      } else if (options.labelsCollection !== undefined) {
        try {
          labels = await fetchLabels(
            client,
            options.labelsCollection,
            referenceIris(response, searchType),
          );
        } catch (error) {
          options.onLabelError?.(error);
        }
      }
      return parseSearchResponse(response, searchType, labels);
    },
  };
}

/**
 * Load the FULL `labels` collection into a label map via the documents export
 * endpoint, which streams every document as JSONL (one JSON object per line).
 * Each line is reconstructed by {@link labelToLocalizedValue}, exactly as the
 * per-search {@link fetchLabels} path does for its `multi_search` hits.
 */
async function loadAllLabels(
  client: Pick<Client, 'collections'>,
  collection: string,
): Promise<ReadonlyMap<string, LocalizedValue>> {
  const jsonl = await client.collections(collection).documents().export();
  const labels = new Map<string, LocalizedValue>();
  for (const line of jsonl.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const document = JSON.parse(line) as Record<string, unknown>;
    labels.set(String(document.id), labelToLocalizedValue(document));
  }
  return labels;
}

/** Every distinct reference IRI whose label the result will actually use. */
function referenceIris(
  response: TypesenseSearchResponse,
  searchType: SearchType,
): string[] {
  const referenceFieldSet = new Set(
    referenceFields(searchType).map((field) => field.name),
  );
  // Hits only carry labels for OUTPUT reference fields: reconstructDocument skips
  // non-output fields, so resolving a non-output reference's hit labels (e.g. a
  // facet-only `class` with dozens of IRIs per hit) is pure waste.
  const outputReferenceFields = referenceFields(searchType)
    .filter((field) => field.output === true)
    .map((field) => field.name);
  const iris = new Set<string>();
  for (const hit of response.hits ?? []) {
    for (const name of outputReferenceFields) {
      const raw = hit.document[name];
      if (Array.isArray(raw)) {
        for (const value of raw) {
          iris.add(String(value));
        }
      } else if (typeof raw === 'string') {
        iris.add(raw);
      }
    }
  }
  // Reference-facet bucket values are IRIs too (incl. facet-only references like
  // `class`); resolve them in the same lookup.
  for (const facet of response.facet_counts ?? []) {
    if (referenceFieldSet.has(facet.field_name)) {
      for (const bucket of facet.counts) {
        iris.add(bucket.value);
      }
    }
  }
  return [...iris];
}

/**
 * Resolve labels for `iris` from the sidecar `labels` collection. Each
 * `label_${locale}` becomes a language-map entry; the default `label` is the
 * untagged (`und`) fallback when no locale variant exists.
 *
 * Sent as one `multi_search` (POST) call, the id-list split over per-search
 * batches: the id-list of a page or facet carrying many references — e.g. a
 * dataset with dozens of classes — would overflow Typesense’s GET query-string
 * limit (4000 chars, and IRIs URL-encode to several times their length) if it
 * travelled in the URL. POST puts it in the body; each batch stays under
 * Typesense’s `per_page` cap, and bundling the batches keeps it one round-trip
 * regardless of IRI count. Exported for unit testing against a fake client.
 */
export async function fetchLabels(
  client: Pick<Client, 'multiSearch'>,
  collection: string,
  iris: readonly string[],
): Promise<Map<string, LocalizedValue>> {
  const labels = new Map<string, LocalizedValue>();
  if (iris.length === 0) {
    return labels;
  }
  const searches = [];
  for (let start = 0; start < iris.length; start += LABEL_BATCH_SIZE) {
    const batch = iris.slice(start, start + LABEL_BATCH_SIZE);
    searches.push({
      collection,
      q: '*',
      query_by: 'label',
      filter_by: `id:[${batch.map(escapeFilterValue).join(',')}]`,
      per_page: batch.length,
    });
  }
  const { results } = (await client.multiSearch.perform({ searches })) as {
    results: readonly TypesenseSearchResponse[];
  };
  for (const result of results) {
    for (const hit of result.hits ?? []) {
      labels.set(String(hit.document.id), labelToLocalizedValue(hit.document));
    }
  }
  return labels;
}

/** Typesense caps `per_page` at 250; the multi_search POST body holds the
 *  id-list comfortably, so resolve references in batches of this size. */
const LABEL_BATCH_SIZE = 200;

/** Turn a `labels` document into a language map (`label_${locale}` → locale). */
function labelToLocalizedValue(
  document: Record<string, unknown>,
): LocalizedValue {
  const map: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith('label_') && typeof value === 'string') {
      map[key.slice('label_'.length)] = [value];
    }
  }
  if (Object.keys(map).length === 0 && typeof document.label === 'string') {
    map.und = [document.label];
  }
  return map;
}

/** The subset of a Typesense search response this adapter reads. */
export interface TypesenseSearchResponse {
  readonly found: number;
  readonly hits?: readonly { readonly document: Record<string, unknown> }[];
  readonly facet_counts?: readonly {
    readonly field_name: string;
    readonly counts: readonly {
      readonly value: string;
      readonly count: number;
    }[];
  }[];
}

/**
 * Reconstruct a Typesense response into the engine-neutral {@link SearchResult}:
 * the flat, fanned-out document is turned back into a logical one (per-locale
 * display fields → a language map, reference IRIs → labelled references via the
 * sidecar `labels` lookup, scalars passed through). `labels` maps a reference IRI
 * to its resolved label; an IRI absent from it yields an id-only reference.
 */
export function parseSearchResponse(
  response: TypesenseSearchResponse,
  searchType: SearchType,
  labels: ReadonlyMap<string, LocalizedValue>,
): SearchResult {
  const hits: SearchHit[] = (response.hits ?? []).map((hit) => ({
    id: String(hit.document.id),
    document: reconstructDocument(hit.document, searchType, labels),
  }));
  // Reference facets are IRI-keyed; their buckets carry a resolved data label.
  // Plain facets (tokens, free strings) carry no label — the consumer owns display.
  const referenceFacets = new Set(
    referenceFields(searchType).map((field) => field.name),
  );
  const facets: Record<string, FacetBucket[]> = {};
  for (const facet of response.facet_counts ?? []) {
    const labelled = referenceFacets.has(facet.field_name);
    // A range facet echoes the declared range key as the bucket value; look the
    // bin's half-open bounds back up by key so the bucket is self-describing.
    const field = fieldNamed(searchType, facet.field_name);
    const rangesByKey =
      field !== undefined && isRangeFacet(field)
        ? new Map(field.facetRanges.map((range) => [range.key, range]))
        : undefined;
    facets[facet.field_name] = facet.counts.map((bucket) => {
      const label = labelled ? labels.get(bucket.value) : undefined;
      const range = rangesByKey?.get(bucket.value);
      return {
        value: bucket.value,
        count: bucket.count,
        ...(label !== undefined ? { label } : {}),
        ...(range?.min !== undefined ? { min: range.min } : {}),
        ...(range?.max !== undefined ? { max: range.max } : {}),
      };
    });
  }
  return { hits, total: response.found, facets };
}

/** Rebuild one logical document from a flat Typesense document. */
function reconstructDocument(
  flat: Record<string, unknown>,
  searchType: SearchType,
  labels: ReadonlyMap<string, LocalizedValue>,
): ResultDocument {
  const document: Record<string, SearchValue> = {};
  for (const field of outputFields(searchType)) {
    const value = logicalValue(flat, field, labels);
    if (value !== undefined) {
      document[field.name] = value;
    }
  }
  return document;
}

function logicalValue(
  flat: Record<string, unknown>,
  field: SearchField,
  labels: ReadonlyMap<string, LocalizedValue>,
): SearchValue | undefined {
  switch (field.kind) {
    case 'text':
      return localizedValue(flat, field);
    case 'reference':
      return referenceValue(flat, field, labels);
    case 'keyword': {
      const value = flat[field.name];
      return Array.isArray(value) || typeof value === 'string'
        ? (value as SearchValue)
        : undefined;
    }
    case 'integer':
    case 'number':
    case 'date': {
      const value = flat[field.name];
      return typeof value === 'number' ? value : undefined;
    }
    case 'boolean':
      // A boolean is always present; an absent value means false.
      return flat[field.name] === true;
  }
}

/** Gather the per-locale display fields back into a language map. */
function localizedValue(
  flat: Record<string, unknown>,
  field: SearchField,
): LocalizedValue | undefined {
  const map: Record<string, readonly string[]> = {};
  const display = physicalFields(field).display;
  (field.locales ?? []).forEach((locale, index) => {
    const value = flat[display[index]];
    if (typeof value === 'string') {
      map[locale] = [value];
    }
  });
  return Object.keys(map).length > 0 ? map : undefined;
}

/** Map stored reference IRIs to labelled references; id-only when no label. */
function referenceValue(
  flat: Record<string, unknown>,
  field: SearchField,
  labels: ReadonlyMap<string, LocalizedValue>,
): SearchValue | undefined {
  const raw = flat[field.name];
  if (raw === undefined) {
    return undefined;
  }
  const iris = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  const references: Reference[] = iris.map((iri) => {
    const label = labels.get(iri);
    return label === undefined ? { id: iri } : { id: iri, label };
  });
  return field.array === true ? references : references[0];
}
