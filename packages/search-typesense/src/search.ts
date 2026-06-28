import type { Client } from 'typesense';
import {
  outputFields,
  type FacetBucket,
  type LocalizedValue,
  type Reference,
  type ResultDocument,
  type SearchEngine,
  type SearchField,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SearchSchema,
  type SearchValue,
} from '@lde/search';
import { buildSearchParams } from './query-compiler.js';

/** Where the engine reads documents and (optionally) reference labels. */
export interface TypesenseSearchEngineOptions {
  /** The dataset collection or alias to query. */
  readonly collection: string;
  /** The sidecar `labels` collection (IRI → label); omit for id-only references. */
  readonly labelsCollection?: string;
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
  return {
    async search(
      query: SearchQuery,
      schema: SearchSchema,
    ): Promise<SearchResult> {
      const params = buildSearchParams(query, schema);
      const response = (await client
        .collections(options.collection)
        .documents()
        .search(params)) as TypesenseSearchResponse;
      const labels =
        options.labelsCollection !== undefined
          ? await fetchLabels(
              client,
              options.labelsCollection,
              referenceIris(response, schema),
            )
          : new Map<string, LocalizedValue>();
      return parseSearchResponse(response, schema, labels);
    },
  };
}

/** Every distinct reference IRI across the page of hits. */
function referenceIris(
  response: TypesenseSearchResponse,
  schema: SearchSchema,
): string[] {
  const referenceFields = schema.fields
    .filter((field) => field.kind === 'reference')
    .map((field) => field.name);
  const referenceFieldSet = new Set(referenceFields);
  const iris = new Set<string>();
  for (const hit of response.hits ?? []) {
    for (const name of referenceFields) {
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
  // Reference-facet bucket values are IRIs too; resolve them in the same lookup.
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
 * Resolve labels for `iris` from the sidecar `labels` collection in a single
 * `filter_by: id:[…]` lookup. Each `label_${locale}` becomes a language-map
 * entry; the default `label` is the untagged (`und`) fallback when no locale
 * variant exists.
 */
async function fetchLabels(
  client: Client,
  collection: string,
  iris: readonly string[],
): Promise<Map<string, LocalizedValue>> {
  const labels = new Map<string, LocalizedValue>();
  if (iris.length === 0) {
    return labels;
  }
  const filter = `id:[${iris.map((iri) => `\`${iri.replace(/`/g, '\\`')}\``).join(',')}]`;
  const response = (await client.collections(collection).documents().search({
    q: '*',
    query_by: 'label',
    filter_by: filter,
    per_page: iris.length,
  })) as TypesenseSearchResponse;
  for (const hit of response.hits ?? []) {
    labels.set(String(hit.document.id), labelToLocalizedValue(hit.document));
  }
  return labels;
}

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
  schema: SearchSchema,
  labels: ReadonlyMap<string, LocalizedValue>,
): SearchResult {
  const hits: SearchHit[] = (response.hits ?? []).map((hit) => ({
    id: String(hit.document.id),
    document: reconstructDocument(hit.document, schema, labels),
  }));
  // Reference facets are IRI-keyed; their buckets carry a resolved data label.
  // Plain facets (tokens, free strings) carry no label — the consumer owns display.
  const referenceFacets = new Set(
    schema.fields
      .filter((field) => field.kind === 'reference')
      .map((field) => field.name),
  );
  const facets: Record<string, FacetBucket[]> = {};
  for (const facet of response.facet_counts ?? []) {
    const labelled = referenceFacets.has(facet.field_name);
    facets[facet.field_name] = facet.counts.map((bucket) => {
      const label = labelled ? labels.get(bucket.value) : undefined;
      return label === undefined
        ? { value: bucket.value, count: bucket.count }
        : { value: bucket.value, count: bucket.count, label };
    });
  }
  return { hits, total: response.found, facets };
}

/** Rebuild one logical document from a flat Typesense document. */
function reconstructDocument(
  flat: Record<string, unknown>,
  schema: SearchSchema,
  labels: ReadonlyMap<string, LocalizedValue>,
): ResultDocument {
  const document: Record<string, SearchValue> = {};
  for (const field of outputFields(schema)) {
    if (field.kind === 'boolean') {
      // A boolean is always present; an absent value means false.
      document[field.name] = flat[field.name] === true;
      continue;
    }
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
      return flat[field.name] === true;
  }
}

/** Gather the per-locale display fields back into a language map. */
function localizedValue(
  flat: Record<string, unknown>,
  field: SearchField,
): LocalizedValue | undefined {
  const map: Record<string, readonly string[]> = {};
  for (const locale of field.locales ?? []) {
    const value = flat[`${field.name}_${locale}`];
    if (typeof value === 'string') {
      map[locale] = [value];
    }
  }
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
