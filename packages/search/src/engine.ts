import type { SearchQuery } from './query.js';
import type { SearchType } from './schema.js';

/**
 * The engine port: the boundary a concrete engine adapter (e.g.
 * `@lde/search-typesense`’s `TypesenseSearchEngine`) implements. The adapter
 * owns every engine specific (companion-field expansion, full-text field
 * selection and weights, filter compilation, sorting, result folding, faceting)
 * and returns only logical documents, so a deployment can swap engines without
 * any consumer noticing.
 * Nothing engine-specific and nothing RDF-specific leaks past this port.
 *
 * Port contract: an adapter ALWAYS validates the incoming query against the
 * search type (`assertValidQuery`) and rejects a structurally invalid one —
 * unknown or non-filterable fields, mismatched operators, unknown facets —
 * rather than passing garbage to its engine. Validation is not the caller’s
 * job: it must hold for every surface and for injected deployment policy.
 *
 * `FacetField` keys the returned facet map; it defaults to `string` so an engine
 * stays ergonomic, and a deployment can narrow it to its own facet-field union
 * (see {@link FacetFieldsOf}) for typo-safe facet access. `Type` narrows the
 * accepted `searchType` argument alongside, so an {@link EngineFor}-typed engine
 * rejects a mismatched search type at compile time.
 */
export interface SearchEngine<
  FacetField extends string = string,
  OutputField extends string = string,
  Type extends SearchType = SearchType,
> {
  search(
    query: SearchQuery,
    searchType: Type,
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
 * `facets` can hold. Requires the type be captured as a literal (via
 * `defineSearchType` or `as const satisfies SearchType`), so the
 * `facetable: true` flags survive as literals; a plain `: SearchType`
 * annotation widens them and yields `never`.
 */
export type FacetFieldsOf<Type extends SearchType> = Extract<
  Type['fields'][number],
  { readonly facetable: true }
>['name'];

/**
 * The output-field-name union of a search type — the keys a {@link ResultDocument}
 * can hold. Like {@link FacetFieldsOf}, requires the type captured as a literal
 * (via `defineSearchType` or `as const satisfies SearchType`).
 */
export type OutputFieldsOf<Type extends SearchType> = Extract<
  Type['fields'][number],
  { readonly output: true }
>['name'];

/** A {@link SearchEngine} narrowed to one search type: facet keys and document
 *  keys fixed to that type’s facetable / output field names, and `search()`
 *  accepting only that search type. The type must be captured as a literal
 *  (`defineSearchType` or `as const satisfies SearchType`); {@link engineFor}
 *  is the ergonomic way to obtain one. */
export type EngineFor<Type extends SearchType> = SearchEngine<
  FacetFieldsOf<Type>,
  OutputFieldsOf<Type>,
  Type
>;

/**
 * Narrow an engine to one search type — the ergonomic route to an
 * {@link EngineFor} view. The `const` type parameter captures the search type
 * as a literal, so facet and document keys come out typo-safe without the
 * caller writing any generics. Identity at runtime: the same engine instance
 * is returned, only its type changes.
 *
 * Parameter order follows the family-wide convention: the value being
 * operated on first, its `SearchType` right after.
 */
export function engineFor<const Type extends SearchType>(
  engine: SearchEngine,
  searchType: Type,
): EngineFor<Type> {
  void searchType; // exists only to infer `Type`; the engine is returned as-is
  return engine;
}

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
