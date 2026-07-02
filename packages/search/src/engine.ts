import type { SearchQuery } from './query.js';
import type { SearchType } from './schema.js';

/**
 * The engine port — the boundary a concrete engine adapter (e.g.
 * `@lde/search-typesense`’s `TypesenseSearchEngine`) implements. The adapter
 * owns every engine specific (companion-field expansion, full-text field
 * selection and weights, filter compilation, sorting, result folding, faceting)
 * and returns only logical
 * documents, so a deployment can swap engines without any consumer noticing.
 * Nothing engine-specific and nothing RDF-specific leaks past this port.
 *
 * `FacetField` keys the returned facet map; it defaults to `string` so an engine
 * stays ergonomic, and a deployment can narrow it to its own facet-field union
 * (see {@link FacetFieldsOf}) for typo-safe facet access.
 */
export interface SearchEngine<
  FacetField extends string = string,
  OutputField extends string = string,
> {
  search(
    query: SearchQuery,
    searchType: SearchType,
  ): Promise<SearchResult<FacetField, OutputField>>;
}

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
 * The facet-field-name union of a search type — the keys a {@link SearchResult}’s
 * `facets` can hold. Requires the type be captured as a literal
 * (`as const satisfies SearchType`), so the `facetable: true` flags survive as
 * literals; a plain `: SearchType` annotation widens them and yields `never`.
 */
export type FacetFieldsOf<Type extends SearchType> = Extract<
  Type['fields'][number],
  { readonly facetable: true }
>['name'];

/**
 * The output-field-name union of a search type — the keys a {@link ResultDocument}
 * can hold. Like {@link FacetFieldsOf}, requires the type captured as a literal
 * (`as const satisfies SearchType`).
 */
export type OutputFieldsOf<Type extends SearchType> = Extract<
  Type['fields'][number],
  { readonly output: true }
>['name'];

/** A {@link SearchEngine} narrowed to one search type: facet keys and document
 *  keys fixed to that type’s facetable / output field names. The type must be
 *  captured as `as const satisfies SearchType`. */
export type EngineFor<Type extends SearchType> = SearchEngine<
  FacetFieldsOf<Type>,
  OutputFieldsOf<Type>
>;

/** A {@link SearchResult} narrowed to one search type (see {@link EngineFor}). */
export type ResultFor<Type extends SearchType> = SearchResult<
  FacetFieldsOf<Type>,
  OutputFieldsOf<Type>
>;

/**
 * One result row. `id` (the stable document key, an IRI) is kept *out* of
 * {@link ResultDocument}: it is always present and is the hit’s identity, a
 * different contract from the optional, typed logical field values — and it maps
 * straight onto the GraphQL output’s guaranteed `id: String!`. The document
 * holds only the selectable fields.
 */
export interface SearchHit<OutputField extends string = string> {
  readonly id: string;
  readonly document: ResultDocument<OutputField>;
}

/**
 * The logical result document at the query seam — engine- and RDF-neutral.
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
