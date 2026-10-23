import type { Client } from 'typesense';
import {
  NESTED_DOCUMENT_TYPE,
  type Facet,
  type FacetsOutcome,
  type LocalizedValue,
  type NestedDocument,
  type Reference,
  type ReferenceField,
  type ResultDocument,
  type RootType,
  type RootTypeOf,
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
  facetableFields,
  facetSearches,
  fieldNamed,
  filterOn,
  inheritedFacetPolicies,
  isInlineReference,
  isBinnedRangeFacet,
  isUnsatisfiable,
  joinGraph,
  labelFieldOf,
  labelSourceNamesOf,
  labelTargetNamesOf,
  localLookupTargetsOf,
  nestedReferenceType,
  outputFields,
  physicalFields,
  referencedTargetsOf,
  referenceFields,
  storedTargetOf,
  type FacetSearch,
} from '@lde/search/adapter';
import {
  buildSearchParams,
  escapeFilterValue,
  type BuildSearchParamsOptions,
} from './query-compiler.js';
import { deriveCollectionName } from './collection-name.js';
import {
  resolveProjection,
  type ResolvedReferent,
  type ResolvedReferents,
} from './lookup.js';

/** Where the engine reads documents – plus every query-compiler knob
 *  ({@link BuildSearchParamsOptions}), declared once there and forwarded
 *  wholesale into each search. Reference labels resolve per field from the
 *  collection of the SearchType its `labelSource` names – a label source is
 *  just another type, so it is named the same way. */
export interface TypesenseSearchEngineOptions<
  TypeName extends string = string,
  // `joinTargetFor` is not a deployment knob: the engine already knows both
  // halves of it – the schema’s join graph and every type’s collection – so it
  // supplies the mapping itself rather than asking for it twice.
> extends Omit<BuildSearchParamsOptions, 'joinTargetFor'> {
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
  collectionNameFor(searchType: RootTypeOf<Types>): string;
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
 * Each type’s collection is derived from the type ({@link
 * deriveCollectionName}) unless `options.collections` overrides it. `search`
 * compiles the query ({@link buildSearchParams}), runs it against the type’s
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
  const resolved = [...schema.values()].map((searchType) => {
    const override = (
      options.collections as Readonly<Record<string, string>> | undefined
    )?.[searchType.name];
    return {
      searchType,
      collection: override ?? deriveCollectionName(searchType),
      derived: override === undefined,
    };
  });
  assertNoAccidentalSharing(resolved);
  const collections = new Map<string, string>(
    resolved.map(({ searchType, collection }) => [
      searchType.class,
      collection,
    ]),
  );
  // The schema's join graph, built once (it is cached per schema anyway), plus
  // the collection half the graph deliberately leaves to the adapter. Together
  // they are what lets a `where` criterion carry an `on` path: validation
  // resolves the path to a type, the compiler turns each hop into
  // `$collection(…)`.
  const joins = joinGraph(schema);
  const searchParamsOptions: BuildSearchParamsOptions = {
    ...options,
    schema,
    joinTargetFor: (from, path) => {
      // Both lookups always hit: `assertValidQuery` runs first and rejects
      // every path this could not resolve, and each type resolved a collection
      // above.
      const target = joins.resolve(from, path) as RootType;
      return {
        searchType: target,
        collection: collections.get(target.class) as string,
      };
    },
  };
  // Resolve every reference field's label source ONCE at construction. The
  // schema already guarantees the named type exists and serves labels
  // (`searchSchema`/`labelFieldOf`), and every type resolved a collection
  // above, so both lookups below always hit.
  const typesByName = new Map(
    [...schema.values()].map((searchType) => [searchType.name, searchType]),
  );
  // Per field, one source per target it names, in order of precedence – a
  // reference naming several targets reads labels from every one of them.
  const labelSources = new Map<
    string,
    ReadonlyMap<string, readonly LabelSource[]>
  >(
    [...schema.values()].map((searchType) => [
      searchType.class,
      new Map(
        referenceFields(searchType)
          // An INLINE reference names its label target one level in, through
          // its identity companion: the companion holds that field's ids, so
          // that field's target is what can label them.
          .filter((field) => labelTargetNamesOf(field, schema).length > 0)
          .map((field) => [
            field.name,
            labelTargetNamesOf(field, schema).map((targetName) => {
              const source = typesByName.get(targetName) as RootType;
              const labelField = labelFieldOf(source) as TextField;
              return {
                collection: collections.get(source.class) as string,
                labelField,
                queryBy: physicalFields(labelField).search.join(','),
              };
            }),
          ]),
      ),
    ]),
  );
  // Typesense reports a facet under the field it faceted, which for a reference
  // inheriting a facet policy is the `${name}_facet` companion, not the
  // declared field. Resolved back to the declared name per type ONCE, from the
  // same `physicalFields` that named it, and applied to every response at the
  // boundary – before `labelLookupGroups` (which finds a facet’s label source
  // by declared name) and `parseSearchResponse` (which files its counts under
  // it). Either consumer meeting the engine name would silently lose the
  // facet’s labels, or its counts, or both.
  const declaredFacetNames = new Map<string, ReadonlyMap<string, string>>(
    [...schema.values()].map((searchType) => [
      searchType.class,
      new Map(
        facetableFields(searchType).map((field) => [
          // A facetable field always has a facet field.
          physicalFields(field, schema).facet as string,
          field.name,
        ]),
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
          [...sources.values()]
            .flat()
            .map((source) => [source.collection, source]),
        ).values(),
      ],
    ]),
  );
  // The output reference fields that carry hit labels, each paired with its
  // resolved label source – fixed at construction, so labelLookupGroups need
  // not re-derive or re-resolve them on every search.
  const outputReferenceSources = new Map<
    string,
    readonly { name: string; sources: readonly LabelSource[] }[]
  >(
    [...schema.values()].map((searchType) => {
      const sources = labelSources.get(searchType.class);
      return [
        searchType.class,
        referenceFields(searchType)
          .filter(
            (field) =>
              field.output === true &&
              sources?.has(field.name) === true &&
              // A field storing NESTED DOCUMENTS is excluded, and must be: this
              // list drives the per-hit label lookup, which reads each stored
              // value as an id. An inline reference and a `local` lookup store
              // objects, so every entry would contribute the string
              // `"[object Object]"` to the batched `id:[…]` filter. Neither
              // needs entry labels anyway – the referent's own fields are in
              // the entry – and their FACET buckets are labelled by a separate
              // path that reads the companion.
              nestedReferenceType(schema, field) === undefined &&
              localLookupTargetsOf(field, schema).length === 0,
          )
          .map((field) => ({
            name: field.name,
            sources: (sources as Map<string, readonly LabelSource[]>).get(
              field.name,
            ) as readonly LabelSource[],
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
    searchType: RootType,
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
      Promise<ReadonlyMap<string, LocalizedValue>> | undefined,
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

  /**
   * Answer the searches each caller’s query needs and fold them back into one
   * response per caller: the hits and total of its first search, the facets
   * of all. Every search travels in ONE `multi_search` – a POST, so a long
   * `filter_by` (a batch `id` lookup, any membership over many IRIs) is
   * bounded by the caller’s request, not by Typesense’s 4000-char
   * query-string limit. A search asking for no document is answered empty
   * without being sent: its only filter would compile away and hand back the
   * whole collection ({@link isUnsatisfiable}). Each facet then reports the
   * values its search selected ({@link withSelectedValues}).
   *
   * A failed search fails exactly its caller, which gets an `Error` in its
   * place; only the transport failing rejects.
   */
  async function answer(
    searchType: RootType,
    callers: readonly (readonly PlannedSearch[])[],
  ): Promise<(TypesenseSearchResponse | Error)[]> {
    const collection = collections.get(searchType.class) as string;
    const planned = callers.flat();
    const dispatched = planned.filter(({ query }) => !isUnsatisfiable(query));
    const results = await performInChunks(
      client,
      dispatched.map(({ query }) => ({
        collection,
        ...buildSearchParams(query, searchType, searchParamsOptions),
      })),
    );
    const declaredNames = declaredFacetNames.get(
      searchType.class,
    ) as ReadonlyMap<string, string>;
    let entry = 0;
    const responses = planned.map((search) => {
      if (isUnsatisfiable(search.query)) {
        return EMPTY_RESPONSE;
      }
      const result = results[entry++];
      return result === undefined || 'error' in result
        ? searchError(collection, search, result)
        : withDeclaredFacetNames(result, declaredNames);
    });
    const completed = await withSelectedValues(
      client,
      collection,
      searchType,
      planned.map((search, index) => ({
        ...search,
        response: responses[index] as TypesenseSearchResponse | Error,
      })),
      searchParamsOptions,
    );
    let next = 0;
    return callers.map((searches) => {
      const own = completed.slice(next, (next += searches.length));
      const failed = own.find((response) => response instanceof Error);
      if (failed !== undefined) {
        return failed;
      }
      const answered = own as TypesenseSearchResponse[];
      const [first = EMPTY_RESPONSE] = answered;
      return {
        ...first,
        facet_counts: answered.flatMap(
          (response) => response.facet_counts ?? [],
        ),
      };
    });
  }

  const engine: TypesenseSearchEngine = {
    schema,
    collectionNameFor(searchType: RootType): string {
      assertTypeInSchema(schema, searchType);
      return collections.get(searchType.class) as string;
    },
    async search(
      searchType: RootType,
      query: SearchQuery,
    ): Promise<SearchResult> {
      // The port contract: a type outside the bound schema and a structurally
      // invalid query (unknown field, wrong operator, unknown facet) are both
      // rejected up front, for EVERY caller.
      assertTypeInSchema(schema, searchType);
      assertValidQuery(query, searchType, schema, joins);
      const cachedLabelsPromise = startCachedLabels(searchType);
      // The hits come from the query as asked, carrying the facets that share
      // its `where`; each own-filtered facet is counted by a search of its own
      // (`facetSearches`), in the same round-trip.
      const searches = facetSearches(query);
      const shared = searches.find((search) => search.own === undefined);
      const [response] = await answer(searchType, [
        [
          {
            query: { ...query, facets: shared?.query.facets ?? [] },
            selected: {},
            facetOnly: false,
          },
          ...searches
            .filter((search) => search !== shared)
            .map(facetOnlySearch),
        ],
      ]);
      if (response instanceof Error) {
        throw response;
      }
      const labels = await resolveLabels(cachedLabelsPromise, () =>
        labelLookupGroups(
          [response],
          labelSources.get(searchType.class),
          outputReferenceSources.get(searchType.class) ?? [],
          distinctLabelSources.get(searchType.class) ?? [],
        ),
      );
      // What the caller asked to resolve, level by level. Independent of the
      // label lookup above: that one serves facet buckets and unprojected
      // references, and stays cacheable because a label is one small value.
      const referents = await resolveProjection(
        client,
        query.resolve,
        searchType,
        schema,
        collections,
        (response.hits ?? []).map((hit) => hit.document),
        options.onLabelError,
      );
      return parseSearchResponse(
        response,
        searchType,
        labels,
        schema,
        referents,
      );
    },
    async searchFacets(
      searchType: RootType,
      queries: readonly SearchQuery[],
    ): Promise<readonly FacetsOutcome[]> {
      assertTypeInSchema(schema, searchType);
      for (const query of queries) {
        assertValidQuery(query, searchType, schema, joins);
      }
      if (queries.length === 0) {
        return [];
      }
      const cachedLabelsPromise = startCachedLabels(searchType);
      // Every search of every query travels in ONE multi_search round-trip,
      // each facet-only regardless of what its query carries: no hits
      // (per_page 0) and no ordering – nothing is transferred or sorted that
      // this method cannot return.
      const responses = await answer(
        searchType,
        queries.map((query) => facetSearches(query).map(facetOnlySearch)),
      );
      // One label lookup serves every successful facet result in the batch.
      const labels = await resolveLabels(cachedLabelsPromise, () =>
        labelLookupGroups(
          responses.filter(
            (response): response is TypesenseSearchResponse =>
              !(response instanceof Error),
          ),
          labelSources.get(searchType.class),
          outputReferenceSources.get(searchType.class) ?? [],
          distinctLabelSources.get(searchType.class) ?? [],
        ),
      );
      // A failed query is reported in place, so it never discards its
      // siblings’ facets.
      return responses.map((response) =>
        response instanceof Error
          ? { error: response }
          : {
              facets: parseSearchResponse(response, searchType, labels, schema)
                .facets,
            },
      );
    },
  };
  // The runtime object is string-keyed; the literal-schema typing narrows it.
  return engine as TypesenseSearchEngine<Types>;
}

/**
 * Reject two types landing in one collection *by accident*.
 *
 * A schema keeps type names distinct, but distinct names can still derive the
 * same collection – English collapses them (`Medium` and `Media` both give
 * `media`, `Person` and `People` both give `people`). Nothing downstream would
 * complain: both writers would build the one collection, each type’s search
 * would return the other’s documents, and the membership sweep would delete
 * across them. Exactly the drift deriving names is meant to end, so it fails at
 * construction with the override that resolves it.
 *
 * Sharing a collection *deliberately* stays allowed – several label-source
 * types served by one `labels` collection is a reasonable deployment – so this
 * fires only when at least one side was derived, i.e. when nobody chose it.
 */
function assertNoAccidentalSharing(
  resolved: readonly {
    searchType: SearchType;
    collection: string;
    derived: boolean;
  }[],
): void {
  const byCollection = new Map<string, typeof resolved>();
  for (const entry of resolved) {
    byCollection.set(entry.collection, [
      ...(byCollection.get(entry.collection) ?? []),
      entry,
    ]);
  }
  for (const [collection, entries] of byCollection) {
    if (entries.length > 1 && entries.some((entry) => entry.derived)) {
      const names = entries.map((entry) => `“${entry.searchType.name}”`);
      throw new Error(
        `Search types ${names.join(' and ')} would share the Typesense collection “${collection}”, which no deployment asked for: their names derive to it. Give ${names.join(' or ')} an explicit collections entry.`,
      );
    }
  }
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
  sources: ReadonlyMap<string, readonly LabelSource[]> | undefined,
  outputSources: readonly { name: string; sources: readonly LabelSource[] }[],
  ordered: readonly LabelSource[],
): LabelLookupGroup[] {
  if (sources === undefined || sources.size === 0) {
    return [];
  }
  // One group per collection, in the order the TYPE’s fields first name them
  // – seeded up front rather than in the order the hits happen to mention
  // them, because `fetchLabels` reads group order as precedence and a label
  // is resolved per type, not per field: an IRI two collections hold gets the
  // label of the one the type declares first, whichever field carried it.
  const irisByCollection = new Map(
    ordered.map((source) => [
      source.collection,
      { source, iris: new Set<string>() },
    ]),
  );
  // An IRI of a field naming several targets travels to EVERY one of their
  // collections: which holds it is not known until one answers.
  const add = (fieldSources: readonly LabelSource[], iri: string): void => {
    for (const source of fieldSources) {
      irisByCollection.get(source.collection)?.iris.add(iri);
    }
  };
  for (const response of responses) {
    // Hits only carry labels for OUTPUT reference fields (reconstructDocument
    // skips non-output fields); `outputSources` pairs each with its resolved
    // source, precomputed per type.
    for (const hit of response.hits ?? []) {
      for (const { name, sources: fieldSources } of outputSources) {
        const raw = hit.document[name];
        if (Array.isArray(raw)) {
          for (const value of raw) {
            add(fieldSources, String(value));
          }
        } else if (typeof raw === 'string') {
          add(fieldSources, raw);
        }
      }
    }
    // Reference-facet bucket values are IRIs too (incl. facet-only references
    // like `class`); resolve them in the same lookup. Skip a non-source facet
    // (e.g. a keyword facet) in one check instead of probing every bucket.
    for (const facet of response.facet_counts ?? []) {
      const facetSources = sources.get(facet.field_name);
      if (facetSources === undefined) {
        continue;
      }
      for (const bucket of facet.counts) {
        add(facetSources, bucket.value);
      }
    }
  }
  return [...irisByCollection.values()]
    .filter(({ iris }) => iris.size > 0)
    .map(({ source, iris }) => ({ source, iris: [...iris] }));
}

/**
 * The response with each facet filed under the declared field name its engine
 * facet field stands for – the one place an engine facet name is translated,
 * so that nothing downstream of it meets one.
 */
function withDeclaredFacetNames(
  response: TypesenseSearchResponse,
  declaredNames: ReadonlyMap<string, string>,
): TypesenseSearchResponse {
  if (response.facet_counts === undefined) {
    return response;
  }
  return {
    ...response,
    facet_counts: response.facet_counts.map((facet) => ({
      ...facet,
      // Every facet the engine reports was asked for by a declared, facetable
      // field (`assertValidQuery`), and the map holds each of those.
      field_name: declaredNames.get(facet.field_name) as string,
    })),
  };
}

/** One search a caller’s query needs: a {@link FacetSearch}, and whether it
 *  counts facets alone or also returns the caller’s hits. */
interface PlannedSearch extends FacetSearch {
  readonly facetOnly: boolean;
}

/** A planned facet search as sent: no hits, and with no hits no ordering. */
function facetOnlySearch(search: FacetSearch): PlannedSearch {
  return {
    query: { ...search.query, orderBy: [], limit: 0, offset: 0 },
    selected: search.selected,
    facetOnly: true,
  };
}

/** The error a failed or missing `multi_search` entry stands for, naming a
 *  facet search by its facets – the batch position is the adapter’s own. */
function searchError(
  collection: string,
  search: PlannedSearch,
  result: TypesenseErrorEntry | undefined,
): Error {
  return entryError(
    search.facetOnly
      ? `facet search for “${search.query.facets.join('”, “')}”`
      : `search of “${collection}”`,
    result,
  );
}

/** The error a failed or missing `multi_search` entry stands for. */
function entryError(
  subject: string,
  result: TypesenseErrorEntry | undefined,
): Error {
  return new Error(
    result === undefined
      ? `Typesense ${subject} returned no result entry.`
      : `Typesense ${subject} failed${
          result.code !== undefined ? ` (${result.code})` : ''
        }: ${result.error}`,
  );
}

/**
 * Send searches as `multi_search` requests of at most {@link
 * MULTI_SEARCH_LIMIT} each, concurrently, and return their entries in order.
 * A request that rejects rejects the whole call: the transport failed.
 */
async function performInChunks(
  client: Pick<Client, 'multiSearch'>,
  searches: readonly Record<string, unknown>[],
): Promise<(TypesenseSearchResponse | TypesenseErrorEntry)[]> {
  const chunks: (typeof searches)[] = [];
  for (let start = 0; start < searches.length; start += MULTI_SEARCH_LIMIT) {
    chunks.push(searches.slice(start, start + MULTI_SEARCH_LIMIT));
  }
  const answered = await Promise.all(
    chunks.map(
      async (chunk) =>
        (
          (await client.multiSearch.perform({ searches: [...chunk] })) as {
            results: readonly (TypesenseSearchResponse | TypesenseErrorEntry)[];
          }
        ).results,
    ),
  );
  return answered.flat();
}

/** A response with nothing in it: the answer to a search that asks for no
 *  document, which is never dispatched. */
const EMPTY_RESPONSE: TypesenseSearchResponse = { found: 0, hits: [] };

/** The bucket cap Typesense applies when `max_facet_values` is unset. */
const TYPESENSE_DEFAULT_MAX_FACET_VALUES = 10;

/** The searches Typesense accepts in one `multi_search` request by default
 *  (`limit_multi_searches`). */
const MULTI_SEARCH_LIMIT = 50;

/**
 * Each response with the values its search selected among the facet buckets,
 * after the engine’s own and in descending count order. A response that is
 * already an `Error` passes through unchanged.
 *
 * A value missing from a facet the engine reported in full matches no
 * document, so it gets count 0 without another search. A value missing from a
 * facet cut off at the bucket cap, or narrowed by a facet policy, may still
 * match documents, so it is counted by a search of its own: the search’s
 * `where` plus that value. One search per value, because a facet search
 * filtered on several values of a multi-valued field could cut off the very
 * values it was asked to count. These searches travel together, in as few
 * `multi_search` requests as Typesense accepts. The common cases (no
 * selection, a selection with hits, a facet under the cap) cost nothing.
 *
 * A failed count fails exactly the response it was for, which becomes an
 * `Error` in its place.
 */
async function withSelectedValues(
  client: Pick<Client, 'multiSearch'>,
  collection: string,
  searchType: RootType,
  entries: readonly (PlannedSearch & {
    readonly response: TypesenseSearchResponse | Error;
  })[],
  options: BuildSearchParamsOptions,
): Promise<(TypesenseSearchResponse | Error)[]> {
  const cap = options.maxFacetValues ?? TYPESENSE_DEFAULT_MAX_FACET_VALUES;
  const missing = entries.map(({ query, selected, response }) =>
    response instanceof Error
      ? []
      : Object.entries(selected).flatMap(([field, values]) => {
          const counts =
            response.facet_counts?.find((facet) => facet.field_name === field)
              ?.counts ?? [];
          const present = new Set(counts.map((bucket) => bucket.value));
          // A facet narrowed by a facet policy never reports a value the
          // policy excludes, though a filter on the field still matches it:
          // absent is no proof of 0 there either, so count it. A search that
          // asks for no document has nothing to count.
          const uncertain =
            !isUnsatisfiable(query) &&
            (counts.length >= cap ||
              narrowedByPolicy(searchType, field, options));
          return values
            .filter((value) => !present.has(value))
            .map((value) => ({ field, value, uncertain }));
        }),
  );
  const toCount = missing.flatMap((values, entry) =>
    values
      .filter(({ uncertain }) => uncertain)
      .map(({ field, value }) => ({ entry, field, value })),
  );
  const found = new Map<string, number | Error>();
  const key = (entry: number, field: string, value: string): string =>
    JSON.stringify([entry, field, value]);
  const chunks: (typeof toCount)[] = [];
  for (let start = 0; start < toCount.length; start += MULTI_SEARCH_LIMIT) {
    chunks.push(toCount.slice(start, start + MULTI_SEARCH_LIMIT));
  }
  await Promise.all(
    chunks.map(async (chunk) => {
      let results: readonly (TypesenseSearchResponse | TypesenseErrorEntry)[];
      try {
        ({ results } = (await client.multiSearch.perform({
          searches: chunk.map(({ entry, field, value }) => {
            const { query } = entries[entry] as PlannedSearch;
            return {
              collection,
              ...buildSearchParams(
                {
                  ...query,
                  where: [...query.where, selecting(searchType, field, value)],
                  facets: [],
                  orderBy: [],
                  limit: 0,
                  offset: 0,
                },
                searchType,
                options,
              ),
            };
          }),
        })) as {
          results: readonly (TypesenseSearchResponse | TypesenseErrorEntry)[];
        });
      } catch (error) {
        // The request as a whole failed: so did every count it carried, and
        // nothing else.
        for (const { entry, field, value } of chunk) {
          // The Typesense client rejects with an Error.
          found.set(key(entry, field, value), error as Error);
        }
        return;
      }
      chunk.forEach(({ entry, field, value }, index) => {
        const result = results[index];
        found.set(
          key(entry, field, value),
          result === undefined || 'error' in result
            ? entryError(
                `count of facet value “${value}” on “${field}”`,
                result,
              )
            : result.found,
        );
      });
    }),
  );
  return entries.map(({ response }, entry) => {
    const values = missing[entry] as (typeof missing)[number];
    if (response instanceof Error || values.length === 0) {
      return response;
    }
    const added = new Map<string, { value: string; count: number }[]>();
    for (const { field, value, uncertain } of values) {
      // Every uncertain value was counted above.
      const count = uncertain
        ? (found.get(key(entry, field, value)) as number | Error)
        : 0;
      if (count instanceof Error) {
        return count;
      }
      added.set(field, [...(added.get(field) ?? []), { value, count }]);
    }
    const facetCounts = response.facet_counts ?? [];
    return {
      ...response,
      facet_counts: [
        ...facetCounts.map((facet) => ({
          ...facet,
          counts: [
            ...facet.counts,
            ...[...(added.get(facet.field_name) ?? [])].sort(byCount),
          ],
        })),
        // A facet the response does not carry at all: an unanswered search’s.
        ...[...added]
          .filter(
            ([field]) =>
              !facetCounts.some((facet) => facet.field_name === field),
          )
          .map(([field, counts]) => ({
            field_name: field,
            counts: counts.sort(byCount),
          })),
      ],
    };
  });
}

/** The clause that selects one facet value: `is` on a boolean, `in` on
 *  anything else. */
function selecting(searchType: RootType, field: string, value: string) {
  return filterOn(
    fieldNamed(searchType, field)?.kind === 'boolean'
      ? { field, is: value === 'true' }
      : { field, in: [value] },
  );
}

/** Orders buckets by descending count, as the engine orders its own. */
function byCount(
  first: { readonly count: number },
  second: { readonly count: number },
): number {
  return second.count - first.count;
}

/** Whether a facet policy narrows the facet on `name` ({@link
 *  inheritedFacetPolicies}), so its buckets leave out values its field holds. */
function narrowedByPolicy(
  searchType: RootType,
  name: string,
  options: BuildSearchParamsOptions,
): boolean {
  const field = fieldNamed(searchType, name);
  return (
    field !== undefined &&
    inheritedFacetPolicies(field, options.schema).size > 0
  );
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
      const id = String(hit.document.id);
      // First group wins: the groups arrive in the order a field declares its
      // targets, so an IRI two collections hold is labelled by the target
      // declared first – the same precedence the lookup and the projection
      // apply.
      if (labels.has(id)) {
        continue;
      }
      const label = localizedValue(
        hit.document,
        groupPerSearch[index].source.labelField,
      );
      if (label !== undefined) {
        labels.set(id, label);
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
      // First source wins, as it does for a fetched lookup (`fetchLabels`).
      if (!merged.has(iri)) {
        merged.set(iri, label);
      }
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
    /** The field faceted – by the time a response reaches
     *  {@link parseSearchResponse}, the **declared** field name: the engine
     *  maps a facet companion’s name back at the response boundary. */
    readonly field_name: string;
    readonly counts: readonly {
      readonly value: string;
      readonly count: number;
    }[];
    /** A numeric facet’s value statistics over the matching documents, binned
     *  or not and whatever the bucket cap; `min`/`max` are absent when none
     *  holds a value. (Its `sum` and `avg` overflow on large values; unused.) */
    readonly stats?:
      | { readonly min: number; readonly max: number }
      | { readonly min?: never; readonly max?: never };
  }[];
}

/**
 * Reconstruct a Typesense response into the engine-neutral {@link SearchResult}:
 * the flat, fanned-out document is turned back into a logical one (per-locale
 * display fields → a language map, reference IRIs → labelled references via the
 * label-source lookup, nested objects → nested Search Documents, scalars passed
 * through). `labels` maps a reference IRI to its resolved label; an IRI absent
 * from it yields an id-only reference. `schema` resolves the Reference Type a
 * surfaced inline reference nests – required, not optional: reconstruction is a
 * function of the whole schema exactly as the engine is, and a caller that
 * omitted it would silently serve nothing for every nested field. A schema that
 * does not declare a field’s reference type reconstructs nothing for it rather
 * than the wrong shape, the same call the projection makes.
 */
export function parseSearchResponse(
  response: TypesenseSearchResponse,
  searchType: SearchType,
  labels: ReadonlyMap<string, LocalizedValue>,
  schema: SearchSchema,
  referents?: ReadonlyMap<string, ResolvedReferents>,
): SearchResult {
  const hits: SearchHit[] = (response.hits ?? []).map((hit) => ({
    id: String(hit.document.id),
    document: reconstructDocument(
      hit.document,
      searchType,
      labels,
      schema,
      referents,
    ),
  }));
  // Reference facets are IRI-keyed; their buckets carry a resolved data label.
  // Plain facets (tokens, free strings) carry no label – the consumer owns display.
  // Only reference facets with a label source get bucket labels; an id-only
  // reference facet stays id-only even when a cached full-collection map holds
  // its IRIs.
  const referenceFacets = new Set(
    referenceFields(searchType)
      .filter((field) => labelTargetNamesOf(field, schema).length > 0)
      .map((field) => field.name),
  );
  const facets: Record<string, Facet> = {};
  for (const facet of response.facet_counts ?? []) {
    const labelled = referenceFacets.has(facet.field_name);
    // A binned facet echoes the declared range key as the bucket value; look
    // the bin’s half-open bounds back up by key so the bucket is
    // self-describing.
    const field = fieldNamed(searchType, facet.field_name);
    const rangesByKey =
      field !== undefined && isBinnedRangeFacet(field)
        ? new Map(field.facetRanges.map((range) => [range.key, range]))
        : undefined;
    // A boolean facet is reported with the values stringified; recover the
    // boolean so the bucket carries the term the `is` filter expects.
    const booleanFacet = field?.kind === 'boolean';
    const buckets = facet.counts.map((bucket) => {
      const label = labelled ? labels.get(bucket.value) : undefined;
      const range = rangesByKey?.get(bucket.value);
      return {
        value: bucket.value,
        count: bucket.count,
        ...(label !== undefined ? { label } : {}),
        ...(range?.min !== undefined ? { min: range.min } : {}),
        ...(range?.max !== undefined ? { max: range.max } : {}),
        ...(booleanFacet ? { is: bucket.value === 'true' } : {}),
      };
    });
    // Only a numeric facet’s stats carry a min and max.
    const stats = facet.stats;
    facets[facet.field_name] =
      stats?.min === undefined
        ? { buckets }
        : { buckets, extent: { min: stats.min, max: stats.max } };
  }
  return { hits, total: response.found, facets };
}

/** Rebuild one logical document from a flat Typesense document. */
function reconstructDocument(
  flat: Record<string, unknown>,
  searchType: SearchType,
  labels: ReadonlyMap<string, LocalizedValue>,
  schema: SearchSchema,
  referents?: ReadonlyMap<string, ResolvedReferents>,
): ResultDocument {
  const document: Record<string, SearchValue> = {};
  for (const field of outputFields(searchType)) {
    const value = logicalValue(flat, field, labels, schema, referents);
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
  schema: SearchSchema,
  referents?: ReadonlyMap<string, ResolvedReferents>,
): SearchValue | undefined {
  switch (field.kind) {
    case 'text':
      return localizedValue(flat, field);
    case 'reference': {
      // A surfaced inline reference carries its referent’s own fields, so it
      // reconstructs as a nested Search Document rather than as an IRI plus a
      // label. Nesting is rebuilt HERE, below every surface, so a second
      // surface inherits it instead of reimplementing it (ADR 11).
      const resolved = referents?.get(field.name);
      const nested = nestedReferenceType(schema, field);
      if (nested !== undefined) {
        // A nested level resolves nothing itself; what it carries are the
        // levels below it, which the entries are reconstructed against.
        return nestedValue(
          flat[field.name],
          field,
          nested,
          labels,
          schema,
          resolved?.via === 'nested' ? resolved.children : undefined,
        );
      }
      // Checked BEFORE the plain lookup below, because a `local` lookup
      // resolves through the same kind of level while storing a different
      // shape: its stored value is the endpoint's own document, not an id, so
      // reading it as one would stringify the object into a bogus `id`.
      const localTargets = localLookupTargetsOf(field, schema);
      if (localTargets.length > 0) {
        return localLookupValue(
          flat[field.name],
          field,
          localTargets,
          resolved,
          labels,
          schema,
        );
      }
      // A resolved lookup carries the referent's own fields, fetched from the
      // target's collection. It reconstructs through the SAME path a hit does,
      // so a consumer cannot tell a projected referent from an inline one.
      if (resolved !== undefined && resolved.via === 'lookup') {
        return lookupValue(flat[field.name], field, resolved, labels, schema);
      }
      // A surfaced inline reference stores nested documents, not IRIs, so a
      // schema that does not declare its reference type (a type parsed against
      // a foreign schema) reconstructs nothing rather than the wrong shape –
      // the same call the projection makes. Only output fields are
      // reconstructed, and `searchSchema` allows an inline reference no Role
      // but `output`, so every inline reference reaching this point is a
      // surfaced one.
      return isInlineReference(field)
        ? undefined
        : referenceValue(flat, field, labels);
    }
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
 *
 * A display field holds one string for a plain field, or a list of them for an
 * `array` field.
 */
function localizedValue(
  flat: Record<string, unknown>,
  field: TextField,
): LocalizedValue | undefined {
  const map: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(flat)) {
    const lang = displayLangOf(field, key);
    if (lang === undefined) {
      continue;
    }
    const values = (Array.isArray(value) ? value : [value]).filter(
      (entry): entry is string => typeof entry === 'string',
    );
    if (values.length > 0) {
      map[lang] = values;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Rebuild a surfaced inline reference from the nested object(s) the engine
 * stored: one {@link NestedDocument} per referent, each carrying its Reference
 * Type’s own output fields – so a multi-valued reference keeps every referent’s
 * values grouped rather than smeared across parallel arrays. An entry of a
 * Reference Type carries no `id` – a nested document is read, not addressed –
 * so the one read back here belongs to a {@link ReferenceStrategy.local local}
 * lookup's Root Type, whose collection files it under that key. A nested
 * reference type may itself
 * surface an inline reference, which recurses through {@link reconstructDocument}.
 */
function nestedValue(
  raw: unknown,
  field: ReferenceField,
  referenceType: SearchType,
  labels: ReadonlyMap<string, LocalizedValue>,
  schema: SearchSchema,
  children?: ReadonlyMap<string, ResolvedReferents>,
): SearchValue | undefined {
  const referents = (Array.isArray(raw) ? raw : [raw]).filter(
    (referent): referent is Record<string, unknown> =>
      typeof referent === 'object' && referent !== null,
  );
  const documents: NestedDocument[] = referents.map((referent) =>
    nestedDocument(referent, referenceType, labels, schema, children),
  );
  if (documents.length === 0) {
    return undefined;
  }
  return field.array === true ? documents : documents[0];
}

/**
 * Rebuild a {@link ReferenceStrategy.local local} lookup: the endpoint’s own
 * document as this document stated it, **replaced** by the resolved document
 * where the lookup found one.
 *
 * Replaced rather than merged, because both sides are the target type’s flat
 * physical shape and a logical field fans out into several physical ones: a
 * name this document stated in one language would survive beside the target’s
 * name in another, and a field the target’s record does not carry would
 * survive after the target dropped it. The resolved document carries what the
 * projection asked for, and a resolved entry says exactly that – what a plain
 * lookup says too. Three cases fall out of one expression, which is the point
 * of storing local fields unconditionally:
 *
 * - identified and indexed → the target’s own record;
 * - identified but not indexed → what was stated here, plus the `id`, rather
 *   than a bare IRI;
 * - not identified → what was stated here, with no `id` at all.
 */
function localLookupValue(
  raw: unknown,
  field: ReferenceField,
  targets: readonly RootType[],
  resolved: ResolvedReferents | undefined,
  labels: ReadonlyMap<string, LocalizedValue>,
  schema: SearchSchema,
): SearchValue | undefined {
  const fetched =
    resolved?.via === 'lookup'
      ? resolved.documents
      : new Map<string, ResolvedReferent>();
  const documents = (Array.isArray(raw) ? raw : [raw])
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null,
    )
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : undefined;
      const authoritative = id === undefined ? undefined : fetched.get(id);
      // An entry no collection answered for is read through the declaration
      // it was stored under – which it says itself where there were several
      // to choose from, and the only one otherwise.
      if (authoritative !== undefined) {
        return typedDocument(
          targets.length > 1,
          authoritative.target,
          nestedDocument(
            authoritative.document,
            authoritative.target,
            labels,
            schema,
            authoritative.children,
          ),
        );
      }
      // Its own lookups resolve against the level its target’s fetch carried
      // down, so a nested IRI it shares with a fetched referent still nests.
      const target = storedTargetOf(entry, targets);
      return typedDocument(
        targets.length > 1,
        target,
        nestedDocument(
          entry,
          target,
          labels,
          schema,
          resolved?.via === 'lookup'
            ? resolved.childrenByTarget.get(target.name)
            : undefined,
        ),
      );
    });
  if (documents.length === 0) {
    return undefined;
  }
  return field.array === true ? documents : documents[0];
}

/**
 * A nested document read through one of a lookup’s **several** targets, marked
 * with that type’s name ({@link NESTED_DOCUMENT_TYPE}) so a surface can tell
 * which it is – the marker is a symbol, so it never surfaces as a field. A
 * single-target lookup marks nothing: there is nothing to tell apart.
 */
function typedDocument(
  polymorphic: boolean,
  target: RootType,
  document: NestedDocument,
): NestedDocument {
  return polymorphic
    ? { ...document, [NESTED_DOCUMENT_TYPE]: target.name }
    : document;
}

/** One nested document rebuilt from a flat referent, carrying its `id` where
 *  it has one – the shared body of every nesting that reads a referent. */
function nestedDocument(
  referent: Record<string, unknown>,
  searchType: SearchType,
  labels: ReadonlyMap<string, LocalizedValue>,
  schema: SearchSchema,
  children: ReadonlyMap<string, ResolvedReferents> | undefined,
): NestedDocument {
  const document = reconstructDocument(
    referent,
    searchType,
    labels,
    schema,
    children,
  );
  return typeof referent.id === 'string'
    ? { id: referent.id, ...document }
    : document;
}

/**
 * Rebuild a resolved `lookup` reference: each stored IRI becomes the referent’s
 * own document, read through the **target’s** declaration and carrying whatever
 * the projection asked for. A referent the lookup did not return – an IRI with
 * no document in the target’s collection, or a level whose round-trip failed –
 * degrades to its bare `id` rather than dropping out, so a dangling reference
 * still says which IRI it pointed at.
 */
function lookupValue(
  raw: unknown,
  field: ReferenceField,
  resolved: Extract<ResolvedReferents, { readonly via: 'lookup' }>,
  labels: ReadonlyMap<string, LocalizedValue>,
  schema: SearchSchema,
): SearchValue | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const iris = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  const polymorphic = referencedTargetsOf(field, schema).length > 1;
  const documents: NestedDocument[] = iris.map((iri) => {
    const referent = resolved.documents.get(iri);
    return referent === undefined
      ? { id: iri }
      : typedDocument(polymorphic, referent.target, {
          id: iri,
          ...reconstructDocument(
            referent.document,
            referent.target,
            labels,
            schema,
            referent.children,
          ),
        });
  });
  return field.array === true ? documents : documents[0];
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
    // A reference that resolves nothing is id-only by declaration; never attach
    // a label, even if the (cached, full-collection) map happens to hold this
    // IRI from another source.
    const label =
      labelSourceNamesOf(field).length === 0 ? undefined : labels.get(iri);
    return label === undefined ? { id: iri } : { id: iri, label };
  });
  return field.array === true ? references : references[0];
}
