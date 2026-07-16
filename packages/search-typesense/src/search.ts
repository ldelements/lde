import type { Client } from 'typesense';
import {
  type FacetBucket,
  type FacetsOutcome,
  type LocalizedValue,
  type Reference,
  type ReferenceField,
  type ResultDocument,
  type SearchField,
  type SearchHit,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
  type SearchSchema,
  type SearchType,
  type SearchValue,
  type TextField,
} from '@lde/search';
import {
  assertTypeInSchema,
  assertValidQuery,
  displayLangOf,
  fieldNamed,
  isRangeFacet,
  labelFieldOf,
  outputFields,
  physicalFields,
  referenceFields,
} from '@lde/search/adapter';
import {
  buildSearchParams,
  escapeFilterValue,
  type BuildSearchParamsOptions,
} from './query-compiler.js';
import { deriveCollectionName } from './collection-name.js';

/** Where the engine reads documents – plus every query-compiler knob
 *  ({@link BuildSearchParamsOptions}), declared once there and forwarded
 *  wholesale into each search. Reference labels resolve per field from the
 *  collection of the SearchType its `labelSource` names – a label source is
 *  just another type, so it is named the same way. */
export interface TypesenseSearchEngineOptions<
  TypeName extends string = string,
> extends BuildSearchParamsOptions {
  /**
   * Overrides the collection (or alias) a search type reads, keyed by the
   * type’s `name`. Every type not named here reads the collection derived from
   * its own name ({@link deriveCollectionName}) – the same convention the
   * writers create, so the read side and the write side cannot drift. Supply an
   * entry only where a deployment needs another name (an env prefix, a
   * multi-tenant name, an existing collection); `TypeName` is the union of the
   * schema’s type names, so a typo is still a compile error.
   */
  readonly collections?: Partial<Readonly<Record<TypeName, string>>>;
  /**
   * Called when reference-label resolution fails; the search then degrades to
   * id-only references rather than failing. Optional – omit to swallow silently.
   */
  readonly onLabelError?: (error: unknown) => void;
  /**
   * Opt-in in-memory label cache. When set, each label-source collection is
   * loaded in FULL once via the documents export endpoint and held in a
   * process-lifetime cache for this many milliseconds; each `search` then
   * resolves its reference labels by in-memory lookup instead of a per-search
   * `multi_search` round-trip. Omit to keep the per-search
   * {@link fetchLabels} behaviour unchanged.
   */
  readonly labelCacheTtlMs?: number;
}

/**
 * A {@link SearchEngine} backed by Typesense: the port, plus the one engine
 * specific worth exposing – which collection each type actually reads.
 */
export interface TypesenseSearchEngine<
  Types extends readonly SearchType[] = readonly SearchType[],
> extends SearchEngine<Types> {
  /**
   * The collection `searchType` reads: its {@link
   * TypesenseSearchEngineOptions.collections} override, or the name derived
   * from the type. Resolved at construction and read-only – for observability
   * (logging a search’s target, a health check asserting the collection
   * exists), never an input. Throws for a type outside this engine’s schema,
   * like every other entry point.
   */
  collectionNameFor(searchType: Types[number]): string;
}

/**
 * One reference field’s resolved label source: the collection it reads, the
 * source type’s `label` declaration (for reconstructing localized labels) and
 * the comma-joined physical search fields (one per locale) a label search
 * queries.
 */
export interface LabelSource {
  readonly collection: string;
  readonly labelField: TextField;
  readonly queryBy: string;
}

/**
 * A Typesense-backed {@link SearchEngine}, bound to the whole
 * {@link SearchSchema} at construction – like every other schema consumer.
 * Each type’s collection comes from `options.collections`. `search` compiles
 * the query ({@link buildSearchParams}), runs it against the type’s
 * collection, resolves the reference labels for the page of hits – each
 * reference field from its own label source’s collection, all sources bundled
 * into one lookup – and reconstructs the engine-neutral
 * {@link SearchResult} ({@link parseSearchResponse}). `searchFacets` answers
 * a whole facet batch (e.g. a faceted listing’s skip-own-filter query variants) as a
 * single `multi_search` round-trip with one shared label lookup; a failed
 * entry is reported in place as a per-query outcome, so it never discards
 * its siblings’ facets. Every engine specific stays here; consumers see only
 * logical documents.
 *
 * With a schema built by `searchSchema` over `defineSearchType` literals,
 * `search()` accepts only the deployment’s own types and returns typo-safe
 * facet/document keys per call – no caller-side generics.
 */
export function createTypesenseSearchEngine<
  const Types extends readonly SearchType[],
>(
  client: Client,
  schema: SearchSchema<Types>,
  options: TypesenseSearchEngineOptions<Types[number]['name']> = {},
): TypesenseSearchEngine<Types> {
  // Resolve every type's collection ONCE at construction – the override when
  // the deployment named one, the derived name otherwise – so an underivable
  // name fails at startup, never on the first search that happens to hit that
  // type.
  const collections = new Map<string, string>(
    [...schema.values()].map((searchType) => [
      searchType.class,
      (options.collections as Readonly<Record<string, string>> | undefined)?.[
        searchType.name
      ] ?? deriveCollectionName(searchType),
    ]),
  );
  // Resolve every reference field's label source ONCE at construction. The
  // schema already guarantees the named type exists and serves labels
  // (`searchSchema`/`labelFieldOf`), and `collections` is exhaustive per type.
  const typesByName = new Map(
    [...schema.values()].map((searchType) => [searchType.name, searchType]),
  );
  const labelSources = new Map<string, ReadonlyMap<string, LabelSource>>(
    [...schema.values()].map((searchType) => [
      searchType.class,
      new Map(
        referenceFields(searchType)
          .filter((field) => field.labelSource !== undefined)
          .map((field) => {
            const source = typesByName.get(field.labelSource!) as SearchType;
            const labelField = labelFieldOf(source) as TextField;
            return [
              field.name,
              {
                collection: collections.get(source.class) as string,
                labelField,
                queryBy: physicalFields(labelField).search.join(','),
              },
            ];
          }),
      ),
    ]),
  );
  // The distinct source collections per type, for the cached path – fixed at
  // construction, so no per-search dedup dance.
  const distinctLabelSources = new Map<string, readonly LabelSource[]>(
    [...labelSources].map(([type, sources]) => [
      type,
      [
        ...new Map(
          [...sources.values()].map((source) => [source.collection, source]),
        ).values(),
      ],
    ]),
  );
  // The output reference fields that carry hit labels, each paired with its
  // resolved label source – fixed at construction, so labelLookupGroups need
  // not re-derive or re-resolve them on every search.
  const outputReferenceSources = new Map<
    string,
    readonly { name: string; source: LabelSource }[]
  >(
    [...schema.values()].map((searchType) => {
      const sources = labelSources.get(searchType.class);
      return [
        searchType.class,
        referenceFields(searchType)
          .filter((field) => field.output === true && sources?.has(field.name))
          .map((field) => ({
            name: field.name,
            source: sources!.get(field.name)!,
          })),
      ];
    }),
  );

  // Process-lifetime cache per label-source collection, held in the engine
  // closure. Populated lazily on the first cached search; `inFlightLoads` is
  // the single-flight promise per collection so concurrent first-loads share
  // one export each.
  const cachedLabels = new Map<
    string,
    { labels: ReadonlyMap<string, LocalizedValue>; expiresAt: number }
  >();
  const inFlightLoads = new Map<
    string,
    Promise<ReadonlyMap<string, LocalizedValue>>
  >();

  function cachedAllLabels(
    source: LabelSource,
    ttlMs: number,
  ): Promise<ReadonlyMap<string, LocalizedValue>> {
    const cached = cachedLabels.get(source.collection);
    if (cached !== undefined && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.labels);
    }
    // Single-flight: a load already running serves every concurrent caller.
    let load = inFlightLoads.get(source.collection);
    load ??= loadAllLabels(client, source)
      .then((loaded) => {
        cachedLabels.set(source.collection, {
          labels: loaded,
          expiresAt: Date.now() + ttlMs,
        });
        return loaded;
      })
      // A failed load degrades to id-only references and is NOT cached, so the
      // next search retries rather than serving an empty map for the whole TTL.
      .catch((error) => {
        options.onLabelError?.(error);
        return new Map<string, LocalizedValue>();
      })
      .finally(() => {
        inFlightLoads.delete(source.collection);
      });
    inFlightLoads.set(source.collection, load);
    return load;
  }

  // The merged per-type view over the cached per-collection maps, reused
  // until any constituent map reloads (same instances = still valid), so a
  // multi-source type does not pay an O(all labels) merge per search.
  const mergedCache = new Map<
    string,
    {
      parts: readonly ReadonlyMap<string, LocalizedValue>[];
      merged: ReadonlyMap<string, LocalizedValue>;
    }
  >();

  function mergeCachedLabels(
    typeIri: string,
    parts: readonly ReadonlyMap<string, LocalizedValue>[],
  ): ReadonlyMap<string, LocalizedValue> {
    const cached = mergedCache.get(typeIri);
    if (
      cached !== undefined &&
      cached.parts.length === parts.length &&
      cached.parts.every((part, index) => part === parts[index])
    ) {
      return cached.merged;
    }
    const merged = mergeLabels(parts);
    mergedCache.set(typeIri, { parts, merged });
    return merged;
  }

  // Cached path: the once-loaded full collections serve labels by in-memory
  // lookup (no per-search round-trip). The load does not depend on the
  // response, so it is started BEFORE awaiting the search and runs alongside
  // it; it never rejects (a failed load degrades to an empty map), so it
  // cannot leave an unhandled rejection behind if the search itself fails.
  // `undefined` when the cache is off or the type has no label sources.
  function startCachedLabels(
    searchType: SearchType,
  ): Promise<ReadonlyMap<string, LocalizedValue>> | undefined {
    const sources = distinctLabelSources.get(searchType.class);
    if (
      options.labelCacheTtlMs === undefined ||
      sources === undefined ||
      sources.length === 0
    ) {
      return undefined;
    }
    const ttlMs = options.labelCacheTtlMs;
    return Promise.all(
      sources.map((source) => cachedAllLabels(source, ttlMs)),
    ).then((maps) => mergeCachedLabels(searchType.class, maps));
  }

  // Labels are supplementary: a failed lookup (e.g. a label-source collection
  // mid-rebuild) degrades to id-only references rather than failing the whole
  // search, so the listing still renders with bare IRIs. `groups` is a thunk
  // so the cached and source-less paths never pay for collecting the IRIs.
  async function resolveLabels(
    cachedLabelsPromise:
      | Promise<ReadonlyMap<string, LocalizedValue>>
      | undefined,
    groups: () => readonly LabelLookupGroup[],
  ): Promise<ReadonlyMap<string, LocalizedValue>> {
    if (cachedLabelsPromise !== undefined) {
      return cachedLabelsPromise;
    }
    try {
      return await fetchLabels(client, groups(), options.onLabelError);
    } catch (error) {
      options.onLabelError?.(error);
      return new Map();
    }
  }

  const engine: TypesenseSearchEngine = {
    schema,
    collectionNameFor(searchType: SearchType): string {
      assertTypeInSchema(schema, searchType);
      return collections.get(searchType.class) as string;
    },
    async search(
      searchType: SearchType,
      query: SearchQuery,
    ): Promise<SearchResult> {
      // The port contract: a type outside the bound schema and a structurally
      // invalid query (unknown field, wrong operator, unknown facet) are both
      // rejected up front, for EVERY caller.
      assertTypeInSchema(schema, searchType);
      assertValidQuery(query, searchType);
      const params = buildSearchParams(query, searchType, options);
      const cachedLabelsPromise = startCachedLabels(searchType);
      const response = (await client
        .collections(collections.get(searchType.class) as string)
        .documents()
        .search(params)) as TypesenseSearchResponse;
      const labels = await resolveLabels(cachedLabelsPromise, () =>
        labelLookupGroups(
          [response],
          labelSources.get(searchType.class),
          outputReferenceSources.get(searchType.class) ?? [],
        ),
      );
      return parseSearchResponse(response, searchType, labels);
    },
    async searchFacets(
      searchType: SearchType,
      queries: readonly SearchQuery[],
    ): Promise<readonly FacetsOutcome[]> {
      assertTypeInSchema(schema, searchType);
      for (const query of queries) {
        assertValidQuery(query, searchType);
      }
      if (queries.length === 0) {
        return [];
      }
      const collection = collections.get(searchType.class) as string;
      const cachedLabelsPromise = startCachedLabels(searchType);
      // The whole batch travels as ONE multi_search round-trip. Each query
      // compiles as facet-only regardless of what it carries: no hits
      // (per_page 0) and no ordering – nothing is transferred or sorted that
      // this method cannot return.
      const { results } = (await client.multiSearch.perform({
        searches: queries.map((query) => ({
          collection,
          ...buildSearchParams(
            { ...query, orderBy: [], limit: 0, offset: 0 },
            searchType,
            options,
          ),
        })),
      })) as {
        results: readonly (TypesenseSearchResponse | TypesenseErrorEntry)[];
      };
      // One label lookup serves every successful facet result in the batch.
      const responses = results.filter(
        (result): result is TypesenseSearchResponse => !('error' in result),
      );
      const labels = await resolveLabels(cachedLabelsPromise, () =>
        labelLookupGroups(
          responses,
          labelSources.get(searchType.class),
          outputReferenceSources.get(searchType.class) ?? [],
        ),
      );
      // multi_search reports a failed entry inline instead of rejecting the
      // call; pass that through as a per-query outcome – naming the facets,
      // not the position, since the batch order is the caller's internal –
      // so one failed query never discards its siblings' facets.
      return results.map((result, index) =>
        'error' in result
          ? {
              error: new Error(
                `Typesense facet search for “${queries[index].facets.join('”, “')}” failed${
                  result.code !== undefined ? ` (${result.code})` : ''
                }: ${result.error}`,
              ),
            }
          : { facets: parseSearchResponse(result, searchType, labels).facets },
      );
    },
  };
  // The runtime object is string-keyed; the literal-schema typing narrows it.
  return engine as TypesenseSearchEngine<Types>;
}

/** One label lookup: a source and the distinct IRIs to resolve against it. */
export interface LabelLookupGroup {
  readonly source: LabelSource;
  readonly iris: readonly string[];
}

/**
 * Load a FULL label-source collection into a label map via the documents
 * export endpoint, which streams every document as JSONL (one JSON object per
 * line). Each line is reconstructed by {@link localizedValue}, exactly as the
 * per-search {@link fetchLabels} path does for its `multi_search` hits.
 */
async function loadAllLabels(
  client: Pick<Client, 'collections'>,
  source: LabelSource,
): Promise<ReadonlyMap<string, LocalizedValue>> {
  const jsonl = await client
    .collections(source.collection)
    .documents()
    .export();
  const labels = new Map<string, LocalizedValue>();
  for (const line of jsonl.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const document = JSON.parse(line) as Record<string, unknown>;
    const label = localizedValue(document, source.labelField);
    if (label !== undefined) {
      labels.set(String(document.id), label);
    }
  }
  return labels;
}

/**
 * Group every reference IRI the result will actually use by its field’s label
 * source, one group per source collection. Fields without a `labelSource`
 * stay id-only, so their IRIs never travel.
 */
function labelLookupGroups(
  responses: readonly TypesenseSearchResponse[],
  sources: ReadonlyMap<string, LabelSource> | undefined,
  outputSources: readonly { name: string; source: LabelSource }[],
): LabelLookupGroup[] {
  if (sources === undefined || sources.size === 0) {
    return [];
  }
  const irisByCollection = new Map<
    string,
    { source: LabelSource; iris: Set<string> }
  >();
  const add = (source: LabelSource, iri: string): void => {
    let group = irisByCollection.get(source.collection);
    if (group === undefined) {
      group = { source, iris: new Set() };
      irisByCollection.set(source.collection, group);
    }
    group.iris.add(iri);
  };
  for (const response of responses) {
    // Hits only carry labels for OUTPUT reference fields (reconstructDocument
    // skips non-output fields); `outputSources` pairs each with its resolved
    // source, precomputed per type.
    for (const hit of response.hits ?? []) {
      for (const { name, source } of outputSources) {
        const raw = hit.document[name];
        if (Array.isArray(raw)) {
          for (const value of raw) {
            add(source, String(value));
          }
        } else if (typeof raw === 'string') {
          add(source, raw);
        }
      }
    }
    // Reference-facet bucket values are IRIs too (incl. facet-only references
    // like `class`); resolve them in the same lookup. Skip a non-source facet
    // (e.g. a keyword facet) in one check instead of probing every bucket.
    for (const facet of response.facet_counts ?? []) {
      const source = sources.get(facet.field_name);
      if (source === undefined) {
        continue;
      }
      for (const bucket of facet.counts) {
        add(source, bucket.value);
      }
    }
  }
  return [...irisByCollection.values()].map(({ source, iris }) => ({
    source,
    iris: [...iris],
  }));
}

/**
 * Resolve labels from each group’s label-source collection. Labels are
 * reconstructed from the source type’s `label` declaration ({@link
 * localizedValue}), carrying every present language – including ones outside
 * the declared `locales` and untagged (`und`) values.
 *
 * All groups travel as ONE `multi_search` (POST) call, each group’s id-list
 * split over per-search batches: the id-list of a page or facet carrying many
 * references – e.g. a dataset with dozens of classes – would overflow
 * Typesense’s GET query-string limit (4000 chars, and IRIs URL-encode to
 * several times their length) if it travelled in the URL. POST puts it in the
 * body; each batch stays under Typesense’s `per_page` cap, and bundling the
 * batches keeps it one round-trip regardless of IRI or source count. Exported
 * for unit testing against a fake client.
 */
export async function fetchLabels(
  client: Pick<Client, 'multiSearch'>,
  groups: readonly LabelLookupGroup[],
  onError?: (error: Error) => void,
): Promise<Map<string, LocalizedValue>> {
  const labels = new Map<string, LocalizedValue>();
  const searches = [];
  const groupPerSearch: LabelLookupGroup[] = [];
  for (const group of groups) {
    for (let start = 0; start < group.iris.length; start += LABEL_BATCH_SIZE) {
      const batch = group.iris.slice(start, start + LABEL_BATCH_SIZE);
      searches.push({
        collection: group.source.collection,
        q: '*',
        query_by: group.source.queryBy,
        filter_by: `id:[${batch.map(escapeFilterValue).join(',')}]`,
        per_page: batch.length,
      });
      groupPerSearch.push(group);
    }
  }
  if (searches.length === 0) {
    return labels;
  }
  const { results } = (await client.multiSearch.perform({ searches })) as {
    results: readonly (TypesenseSearchResponse | TypesenseErrorEntry)[];
  };
  results.forEach((result, index) => {
    // multi_search reports a failed entry inline instead of rejecting. Isolate
    // it: report the failed source and skip its entry so the other sources'
    // labels still land, instead of blanking the whole page to id-only – its
    // own references fall back to id-only as their IRIs stay absent.
    if ('error' in result) {
      const failure = new Error(
        `Typesense label lookup in “${groupPerSearch[index].source.collection}” failed${
          result.code !== undefined ? ` (${result.code})` : ''
        }: ${result.error}`,
      );
      onError?.(failure);
      return;
    }
    for (const hit of result.hits ?? []) {
      const label = localizedValue(
        hit.document,
        groupPerSearch[index].source.labelField,
      );
      if (label !== undefined) {
        labels.set(String(hit.document.id), label);
      }
    }
  });
  return labels;
}

/** Typesense caps `per_page` at 250; the multi_search POST body holds the
 *  id-list comfortably, so resolve references in batches of this size. */
const LABEL_BATCH_SIZE = 200;

/** Merge per-collection label maps into one IRI-keyed map (URI identity). */
function mergeLabels(
  maps: readonly ReadonlyMap<string, LocalizedValue>[],
): ReadonlyMap<string, LocalizedValue> {
  if (maps.length === 1) {
    return maps[0];
  }
  const merged = new Map<string, LocalizedValue>();
  for (const map of maps) {
    for (const [iri, label] of map) {
      merged.set(iri, label);
    }
  }
  return merged;
}

/** A failed entry in a `multi_search` response: Typesense reports a
 *  per-search failure inline (the call itself still resolves). */
interface TypesenseErrorEntry {
  readonly error: string;
  readonly code?: number;
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
 * label-source lookup, scalars passed through). `labels` maps a reference IRI
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
  // Plain facets (tokens, free strings) carry no label – the consumer owns display.
  // Only reference facets with a label source get bucket labels; an id-only
  // reference facet stays id-only even when a cached full-collection map holds
  // its IRIs.
  const referenceFacets = new Set(
    referenceFields(searchType)
      .filter((field) => field.labelSource !== undefined)
      .map((field) => field.name),
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

/**
 * Gather every present-language display field back into a language map. Display
 * fields are pattern-based (`${name}_<lang>`, {@link displayLangOf}), so this
 * recovers languages outside the declared `locales` too – a value tagged in an
 * undeclared language, or untagged (`und`), still reconstructs rather than being
 * dropped.
 */
function localizedValue(
  flat: Record<string, unknown>,
  field: TextField,
): LocalizedValue | undefined {
  const map: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value !== 'string') {
      continue;
    }
    const lang = displayLangOf(field, key);
    if (lang !== undefined) {
      map[lang] = [value];
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/** Map stored reference IRIs to labelled references; id-only when no label. */
function referenceValue(
  flat: Record<string, unknown>,
  field: ReferenceField,
  labels: ReadonlyMap<string, LocalizedValue>,
): SearchValue | undefined {
  const raw = flat[field.name];
  if (raw === undefined) {
    return undefined;
  }
  const iris = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  const references: Reference[] = iris.map((iri) => {
    // A reference without a label source is id-only by declaration; never
    // attach a label, even if the (cached, full-collection) map happens to
    // hold this IRI from another source.
    const label = field.labelSource === undefined ? undefined : labels.get(iri);
    return label === undefined ? { id: iri } : { id: iri, label };
  });
  return field.array === true ? references : references[0];
}
