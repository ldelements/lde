import type { SearchQuery } from './query.js';
import type {
  RootType,
  RootTypeOf,
  SearchSchema,
  SearchType,
} from './schema.js';

/**
 * The engine port: the boundary a concrete engine adapter (e.g. the engine
 * `@lde/search-typesense`’s `createTypesenseSearchEngine` returns) implements.
 * An engine is **bound to the whole {@link SearchSchema} at construction** –
 * the adapter factory takes the deployment’s declaration together with the
 * physical location of every type (its collections map), mirroring the other
 * schema consumers (`projectRoots(quads, roots, schema, type)`,
 * `buildGraphQLSchema(schema)`): everything is a function of the schema. A
 * query can never meet the wrong index, deployment-level concerns (label
 * cache, cross-type search, facet batching) have one home, and a search names
 * its type per call.
 * The adapter owns every engine specific (companion-field expansion,
 * full-text field selection and weights, filter compilation, sorting, result
 * folding, faceting) and returns only logical documents, so a deployment can
 * swap engines without any consumer noticing. Nothing engine-specific and
 * nothing RDF-specific leaks past this port.
 *
 * Port contract: an adapter ALWAYS rejects a `searchType` that is not in its
 * bound schema, and ALWAYS validates the incoming query against it
 * (`assertValidQuery`) – unknown or non-filterable fields, mismatched
 * operators, unknown facets – rather than passing garbage to its engine.
 * Validation is not the caller’s job: it must hold for every surface and for
 * injected deployment policy.
 *
 * `Types` is the literal tuple {@link searchSchema} captured: with a
 * `defineSearchType` declaration, `search()` only accepts the deployment’s
 * own types (a foreign type is a compile error) and returns facet/document
 * keys typed by the type passed. A widened `: SearchSchema` degrades
 * gracefully to string keys ({@link FacetFieldsOf}).
 */
export interface SearchEngine<
  Types extends readonly SearchType[] = readonly SearchType[],
> {
  /** The declaration this engine serves – exposed so a surface can route and
   *  a caller can enumerate the searchable types. */
  readonly schema: SearchSchema<Types>;
  search<T extends RootTypeOf<Types>>(
    searchType: T,
    query: SearchQuery,
  ): Promise<SearchResult<FacetFieldsOf<T>, OutputFieldsOf<T>>>;
  /**
   * The batch entry point: answer several facet-only queries against one type
   * in a single engine round-trip (where the engine supports one, e.g.
   * Typesense `multi_search`), returning one {@link FacetsOutcome} per query,
   * positionally aligned with `queries`. This is what keeps a faceted
   * listing – one skip-own-filter query variant per filtered facet – from
   * fanning out into per-facet engine calls. Only facet buckets come back: an
   * engine answers every query in the batch facet-only (as if `limit: 0` and
   * without ordering, whatever the query carries), so hits are never
   * transferred. Reference-facet buckets carry resolved labels exactly as in
   * {@link search}. A failure of one query is reported in place
   * (`{ error }`) rather than by rejecting, so it never discards its
   * siblings’ facets; the returned promise rejects only for batch-level
   * failures (a foreign `searchType`, a structurally invalid query, the
   * transport itself). The port contract holds for every query in the batch;
   * an empty `queries` resolves to `[]` without touching the engine.
   */
  searchFacets<T extends RootTypeOf<Types>>(
    searchType: T,
    queries: readonly SearchQuery[],
  ): Promise<readonly FacetsOutcome<FacetFieldsOf<T>>[]>;
}

/**
 * One query’s outcome in a {@link SearchEngine.searchFacets} batch – its
 * facet buckets, or the error that failed it. The `allSettled`-style shape
 * keeps one failed query (e.g. one failed `multi_search` entry) from
 * discarding its siblings’ results: a caller degrades exactly the facets of
 * the failed query. Discriminate with `'error' in outcome`.
 */
export type FacetsOutcome<FacetField extends string = string> =
  | { readonly facets: FacetMap<FacetField> }
  | { readonly error: unknown };

/** What an engine returns: logical hits, a total, and the requested facets. */
export interface SearchResult<
  FacetField extends string = string,
  OutputField extends string = string,
> {
  readonly hits: readonly SearchHit<OutputField>[];
  readonly total: number;
  readonly facets: FacetMap<FacetField>;
}

/**
 * Facet buckets keyed by facet field name. `Partial` because a result carries
 * buckets only for the fields the query asked for, not every facetable field.
 */
export type FacetMap<FacetField extends string = string> = Readonly<
  Partial<Record<FacetField, readonly FacetBucket[]>>
>;

/**
 * The facet-field-name union of a search type – the keys a {@link SearchResult}’s
 * `facets` can hold. Narrow for a declaration captured as a literal (via
 * `defineSearchType` or `as const satisfies SearchType`); a plain
 * `: SearchType` annotation degrades to `string` (its field names are not
 * statically known).
 */
export type FacetFieldsOf<Type extends SearchType> = RootType extends Type
  ? string
  : Extract<Type['fields'][number], { readonly facetable: true }>['name'];

/**
 * The output-field-name union of a search type – the keys a {@link ResultDocument}
 * can hold. Like {@link FacetFieldsOf}, degrades to `string` for a widened
 * declaration.
 */
export type OutputFieldsOf<Type extends SearchType> = RootType extends Type
  ? string
  : Extract<Type['fields'][number], { readonly output: true }>['name'];

/**
 * One result row. `id` (the stable document key, an IRI) is kept *out* of
 * {@link ResultDocument}: it is always present and is the hit’s identity, a
 * different contract from the optional, typed logical field values – and it maps
 * straight onto the GraphQL output’s guaranteed `id: String!`. The document
 * holds only the selectable fields.
 */
export interface SearchHit<OutputField extends string = string> {
  readonly id: string;
  readonly document: ResultDocument<OutputField>;
}

/**
 * The logical result document at the query seam – engine- and RDF-neutral.
 * Distinct from the flat, fanned-out projection `SearchDocument` that lives
 * index-side: this carries logical fields with language maps and references,
 * ready for a surface to shape. Keyed by output field name; `Partial` because a
 * document omits absent optional fields. `OutputField` defaults to `string`; a
 * deployment narrows it via {@link OutputFieldsOf} for typo-safe field access.
 */
export type ResultDocument<OutputField extends string = string> = Readonly<
  Partial<Record<OutputField, SearchValue>>
>;

/** A logical field value. */
export type SearchValue =
  | string
  | number
  | boolean
  | readonly string[]
  | LocalizedValue
  | Reference
  | readonly Reference[];

/**
 * A JSON-LD-style language map (`@container: @language`, `@set` arrays); the key
 * `und` carries untagged (`@none`) values. The surface flattens it to a
 * best-first `Accept-Language`-ordered list.
 */
export type LocalizedValue = Readonly<Record<string, readonly string[]>>;

/**
 * The generic internal carrier for a referenced entity. The GraphQL surface maps
 * it to a named per-shape type (e.g. `Organization`, `Term`) with `label`
 * exposed as `name`.
 */
export interface Reference {
  readonly id: string;
  readonly label?: LocalizedValue;
}

/**
 * One facet bucket: a value and how many documents carry it. `label` is the
 * engine-resolved canonical **data** label, present only for reference facets
 * (IRI-keyed); it is absent for facets whose value is a token or free string
 * whose display the consumer owns (its own i18n, or the value itself).
 */
export interface FacetBucket {
  readonly value: string;
  readonly count: number;
  readonly label?: LocalizedValue;
  /**
   * For a range-facet bucket: its half-open bounds (`min` inclusive, `max`
   * exclusive), echoing the declared {@link FacetRange} so the bucket is
   * self-describing and a consumer never hardcodes the bin formula. Both absent
   * for a value facet; either absent for an open-ended bin.
   */
  readonly min?: number;
  readonly max?: number;
}
