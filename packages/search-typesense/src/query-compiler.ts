import type { SearchParams } from 'typesense/lib/Typesense/Documents.js';
import { fold } from '@lde/text-normalization';
import {
  fieldNamed,
  filterOperator,
  filterOperatorFor,
  isoToUnixSeconds,
  isRangeFacet,
  pageForOffset,
  physicalFields,
  searchableFields,
  type FacetRange,
  type Filter,
  type SearchField,
  type SearchQuery,
  type SearchType,
  type Sort,
} from '@lde/search';

/**
 * Options for {@link buildSearchParams} — the query half of the engine
 * adapter. {@link TypesenseSearchEngineOptions} extends this, so each knob is
 * declared once and the engine forwards its options wholesale.
 */
export interface BuildSearchParamsOptions {
  /**
   * Cap on the number of buckets returned per facet (`max_facet_values`). Left
   * unset, Typesense defaults to 10 — too few for high-cardinality facets
   * (publisher, keyword), so a deployment with such facets must raise it. Range
   * facets return one bucket per declared range regardless, but a value > the
   * range count is still safe.
   */
  readonly maxFacetValues?: number;
  /**
   * Called for each `where` clause that compiles to nothing and is therefore
   * skipped: an unknown field, an operator that does not match the field’s
   * kind ({@link filterOperatorFor}), an empty `in` list, or a `range` with no
   * usable bound. Skipping keeps a malformed clause from reaching the engine
   * as garbage; supply this to log it instead of losing it silently. Through
   * the engine, a structurally invalid query throws up front
   * (`assertValidQuery`), so there only the vacuous clauses reach this.
   */
  readonly onIgnoredFilter?: (filter: Filter) => void;
}

/**
 * Compile the engine-neutral {@link SearchQuery} into Typesense search
 * parameters — the query half of the engine adapter. Pure (no client, no env),
 * so the mapping is asserted directly in unit tests. Field names come from
 * {@link physicalFields}, the same convention the projection and the collection
 * schema use, so a query can never reference a field the index does not carry.
 */
export function buildSearchParams(
  query: SearchQuery,
  searchType: SearchType,
  options: BuildSearchParamsOptions = {},
): SearchParams<object> {
  const folded =
    query.text !== undefined && query.text.length > 0
      ? fold(query.text)
      : undefined;
  const { names, weights } = queryFields(searchType, query.locale);
  const filterBy = compileFilterBy(
    query.where,
    searchType,
    options.onIgnoredFilter,
  );
  const sortBy = query.orderBy
    .map((sort) => compileSort(sort, searchType, query.locale))
    .join(',');
  const params: SearchParams<object> = {
    q: folded ?? '*',
    query_by: names.join(','),
    query_by_weights: weights.join(','),
    per_page: query.limit,
    page: pageForOffset(query.offset, query.limit),
  };
  if (filterBy.length > 0) {
    params.filter_by = filterBy;
  }
  if (sortBy.length > 0) {
    params.sort_by = sortBy;
  }
  if (query.facets.length > 0) {
    params.facet_by = compileFacetBy(query.facets, searchType);
    if (options.maxFacetValues !== undefined) {
      params.max_facet_values = options.maxFacetValues;
    }
  }
  return params;
}

/**
 * The `facet_by` clause. A facet on a numeric field that declares
 * {@link SearchField.facetRanges} faceted into those fixed half-open `[min, max)`
 * bins (a histogram); every other facet is a plain per-value facet on its field
 * name. Typesense range syntax is already start-inclusive/end-exclusive, so the
 * declared bounds pass straight through with no boundary fix-up.
 */
function compileFacetBy(
  facets: readonly string[],
  searchType: SearchType,
): string {
  return facets
    .map((name) => {
      const field = fieldNamed(searchType, name);
      return field !== undefined && isRangeFacet(field)
        ? compileRangeFacet(field.name, field.facetRanges)
        : name;
    })
    .join(',');
}

/** `name(key:[min, max], …)`; a blank bound is open-ended (Typesense `[75, ]`). */
function compileRangeFacet(
  name: string,
  ranges: readonly FacetRange[],
): string {
  const bins = ranges
    .map((range) => `${range.key}:[${range.min ?? ''}, ${range.max ?? ''}]`)
    .join(', ');
  return `${name}(${bins})`;
}

/**
 * The `query_by` fields and aligned weights. Each searchable field expands to its
 * folded `*_search` companion(s); a localized field’s active-locale companion
 * keeps its full weight while the other locale is gently demoted (−1, floored at
 * 1), so a match in the user’s language ranks higher while cross-language matches
 * still surface.
 */
function queryFields(
  searchType: SearchType,
  locale: string,
): { readonly names: string[]; readonly weights: number[] } {
  const names: string[] = [];
  const weights: number[] = [];
  for (const field of searchableFields(searchType)) {
    const search = physicalFields(field).search;
    const baseWeight = field.searchable.weight;
    if (field.kind === 'text' && field.localized === true) {
      const locales = field.locales ?? [];
      search.forEach((name, index) => {
        names.push(name);
        weights.push(
          locales[index] === locale ? baseWeight : Math.max(1, baseWeight - 1),
        );
      });
    } else {
      for (const name of search) {
        names.push(name);
        weights.push(baseWeight);
      }
    }
  }
  return { names, weights };
}

/** AND-join the compiled `where` clauses; a clause that compiles to nothing is
 *  skipped and reported to `onIgnoredFilter`. */
function compileFilterBy(
  where: readonly Filter[],
  searchType: SearchType,
  onIgnoredFilter: ((filter: Filter) => void) | undefined,
): string {
  return where
    .map((filter) => {
      const clause = compileFilter(filter, searchType);
      if (clause === undefined) {
        onIgnoredFilter?.(filter);
      }
      return clause;
    })
    .filter((clause): clause is string => clause !== undefined)
    .join(' && ');
}

function compileFilter(
  filter: Filter,
  searchType: SearchType,
): string | undefined {
  const field = fieldNamed(searchType, filter.field);
  if (field === undefined) {
    return undefined;
  }
  // A clause whose operator does not match the field's kind (e.g. `range` on a
  // keyword) would reach the engine as garbage syntax — skip it instead.
  if (filterOperatorFor(field.kind) !== filterOperator(filter)) {
    return undefined;
  }
  if ('in' in filter) {
    return filter.in.length > 0
      ? compileMembership(field, filter.in)
      : undefined;
  }
  if ('range' in filter) {
    return compileRange(field, filter.range);
  }
  return `${field.name}:=${filter.is}`;
}

/**
 * A membership clause. A non-facet (tokenized) field uses the exact `:=`
 * operator so an IRI cannot partial-match on a shared path segment.
 */
function compileMembership(
  field: SearchField,
  values: readonly string[],
): string {
  const list = `[${values.map(escapeFilterValue).join(',')}]`;
  return field.facetable !== true
    ? `${field.name}:=${list}`
    : `${field.name}:${list}`;
}

/** An inclusive Typesense range clause, or `undefined` when neither bound is set. */
function compileRange(
  field: SearchField,
  range: { readonly min?: number | string; readonly max?: number | string },
): string | undefined {
  const name = field.name;
  const min = storedBound(field, range.min);
  const max = storedBound(field, range.max);
  if (min !== undefined && max !== undefined) {
    return `${name}:[${min}..${max}]`;
  }
  if (min !== undefined) {
    return `${name}:>=${min}`;
  }
  if (max !== undefined) {
    return `${name}:<=${max}`;
  }
  return undefined;
}

/** A range bound as stored: a `date` field’s ISO 8601 bound becomes the indexed
 *  Unix seconds ({@link isoToUnixSeconds}); an unparseable bound is dropped. */
function storedBound(
  field: SearchField,
  bound: number | string | undefined,
): number | string | undefined {
  return field.kind === 'date' && typeof bound === 'string'
    ? isoToUnixSeconds(bound)
    : bound;
}

/**
 * One `sort_by` term. `relevance` maps to Typesense’s `_text_match`; a localized
 * text field sorts on its active-locale folded key; any other field (including a
 * deployment tie-break like `status_rank`) sorts on its own name.
 */
function compileSort(
  sort: Sort,
  searchType: SearchType,
  locale: string,
): string {
  if (sort.field === 'relevance') {
    return `_text_match:${sort.direction}`;
  }
  const field = fieldNamed(searchType, sort.field);
  if (
    field !== undefined &&
    field.kind === 'text' &&
    field.localized === true
  ) {
    const sortName =
      physicalFields(field).sort[field.locales?.indexOf(locale) ?? -1];
    if (sortName !== undefined) {
      return `${sortName}:${sort.direction}`;
    }
  }
  return `${sort.field}:${sort.direction}`;
}

/**
 * Backtick-wrap a filter value so reserved characters in IRIs and media types
 * (`:`, `/`, `&`, `,`, …) are taken literally instead of parsed as filter syntax.
 * An embedded backtick is escaped.
 */
export function escapeFilterValue(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}
