import type { SearchParams } from 'typesense/lib/Typesense/Documents.js';
import { fold } from '@lde/text-normalization';
import {
  physicalFields,
  searchableFields,
  type FacetRange,
  type Filter,
  type SearchField,
  type SearchQuery,
  type SearchSchema,
  type Sort,
} from '@lde/search';

/**
 * Compile the engine-neutral {@link SearchQuery} into Typesense search
 * parameters — the query half of the engine adapter. Pure (no client, no env),
 * so the mapping is asserted directly in unit tests. Field names come from
 * {@link physicalFields}, the same convention the projection and the collection
 * schema use, so a query can never reference a field the index does not carry.
 */
export interface CompileOptions {
  /**
   * Cap on the number of buckets returned per facet (`max_facet_values`). Left
   * unset, Typesense defaults to 10 — too few for high-cardinality facets
   * (publisher, keyword), so a deployment with such facets must raise it. Range
   * facets return one bucket per declared range regardless, but a value > the
   * range count is still safe.
   */
  readonly maxFacetValues?: number;
}

export function buildSearchParams(
  query: SearchQuery,
  schema: SearchSchema,
  options: CompileOptions = {},
): SearchParams<object> {
  const folded =
    query.text !== undefined && query.text.length > 0
      ? fold(query.text)
      : undefined;
  const { names, weights } = queryFields(schema, query.locale);
  const filterBy = compileFilterBy(query.where, schema);
  const sortBy = query.orderBy
    .map((sort) => compileSort(sort, schema, query.locale))
    .join(',');
  const params: SearchParams<object> = {
    q: folded ?? '*',
    query_by: names.join(','),
    query_by_weights: weights.join(','),
    per_page: query.limit,
    // A facet-only query (`limit: 0`) fetches no hits; page is then meaningless,
    // so pin it to 1 rather than dividing by zero.
    page: query.limit > 0 ? Math.floor(query.offset / query.limit) + 1 : 1,
  };
  if (filterBy.length > 0) {
    params.filter_by = filterBy;
  }
  if (sortBy.length > 0) {
    params.sort_by = sortBy;
  }
  if (query.facets.length > 0) {
    params.facet_by = compileFacetBy(query.facets, schema);
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
  schema: SearchSchema,
): string {
  return facets
    .map((name) => {
      const field = schema.fields.find((candidate) => candidate.name === name);
      return field?.facetRanges !== undefined && field.facetRanges.length > 0
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
  schema: SearchSchema,
  locale: string,
): { readonly names: string[]; readonly weights: number[] } {
  const names: string[] = [];
  const weights: number[] = [];
  for (const field of searchableFields(schema)) {
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

/** AND-join the compiled `where` clauses; skips unknown fields and empty clauses. */
function compileFilterBy(
  where: readonly Filter[],
  schema: SearchSchema,
): string {
  return where
    .map((filter) => compileFilter(filter, schema))
    .filter((clause): clause is string => clause !== undefined)
    .join(' && ');
}

function compileFilter(
  filter: Filter,
  schema: SearchSchema,
): string | undefined {
  const field = schema.fields.find(
    (candidate) => candidate.name === filter.field,
  );
  if (field === undefined) {
    return undefined;
  }
  if ('in' in filter) {
    return filter.in.length > 0
      ? compileMembership(field, filter.in)
      : undefined;
  }
  if ('range' in filter) {
    return compileRange(field.name, filter.range);
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
  const exact = field.facetable !== true;
  return membership(field.name, values, exact);
}

function membership(
  name: string,
  values: readonly string[],
  exact: boolean,
): string {
  const list = `[${values.map(escapeFilterValue).join(',')}]`;
  return exact ? `${name}:=${list}` : `${name}:${list}`;
}

/** An inclusive Typesense range clause, or `undefined` when neither bound is set. */
function compileRange(
  name: string,
  range: { readonly min?: number | string; readonly max?: number | string },
): string | undefined {
  const { min, max } = range;
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

/**
 * One `sort_by` term. `relevance` maps to Typesense’s `_text_match`; a localized
 * text field sorts on its active-locale folded key; any other field (including a
 * deployment tie-break like `status_rank`) sorts on its own name.
 */
function compileSort(sort: Sort, schema: SearchSchema, locale: string): string {
  if (sort.field === 'relevance') {
    return `_text_match:${sort.direction}`;
  }
  const field = schema.fields.find(
    (candidate) => candidate.name === sort.field,
  );
  if (
    field !== undefined &&
    field.kind === 'text' &&
    field.localized === true
  ) {
    return `${field.name}_sort_${locale}:${sort.direction}`;
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
