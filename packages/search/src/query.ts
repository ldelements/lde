import { fieldNamed, type FieldKind, type SearchType } from './schema.js';

/**
 * The engine- and protocol-neutral query IR. Every API surface compiles its
 * input into this; every engine adapter compiles it into an engine query. One
 * shared representation in the middle keeps the GraphQL surface, a later REST
 * surface and the adapter from drifting.
 */
export interface SearchQuery {
  /** Free-text query; `undefined`/`''` means browse (no text ranking). */
  readonly text?: string;
  /** AND across fields. */
  readonly where: readonly Filter[];
  /** Primary public sort plus any server tie-breaks, in precedence order. */
  readonly orderBy: readonly Sort[];
  /** Numbered pagination. */
  readonly limit: number;
  readonly offset: number;
  /** Logical field names to return facet buckets for. */
  readonly facets: readonly string[];
  /** Selects the per-locale fields to query/sort on (from `Accept-Language`). */
  readonly locale: string;
}

/**
 * One `where` clause. The operator is fixed by the target field’s {@link FieldKind}
 * ({@link filterOperatorFor}): keyword/reference use `in` (OR within the field),
 * the numeric/date kinds use an inclusive `range`, boolean uses `is`. Bounds are
 * inclusive only — no `gt`/`gte`/`lt`/`lte`.
 */
export type Filter =
  | { readonly field: string; readonly in: readonly string[] }
  | {
      readonly field: string;
      readonly range: {
        readonly min?: number | string;
        readonly max?: number | string;
      };
    }
  | { readonly field: string; readonly is: boolean };

/** A single sort dimension. */
export interface Sort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** The `where` operator a kind accepts, or `undefined` when it is not filterable
 *  through `where` (`text` feeds the free-text `query` instead). */
export type FilterOperator = 'in' | 'range' | 'is';

const OPERATOR_BY_KIND: Readonly<
  Record<FieldKind, FilterOperator | undefined>
> = {
  text: undefined,
  keyword: 'in',
  reference: 'in',
  integer: 'range',
  number: 'range',
  date: 'range',
  boolean: 'is',
};

/**
 * The `where` operator a field of this kind accepts (per the ADR filter-semantics
 * table), or `undefined` for `text` — which feeds the free-text `query` rather
 * than `where`. Drives both the surface’s `where` input type and the adapter’s
 * filter compiler from one rule.
 */
export function filterOperatorFor(kind: FieldKind): FilterOperator | undefined {
  return OPERATOR_BY_KIND[kind];
}

/** The operator a {@link Filter} value carries, from its discriminating key. */
export function filterOperator(filter: Filter): FilterOperator {
  return 'in' in filter ? 'in' : 'range' in filter ? 'range' : 'is';
}

/**
 * One structural problem {@link validateQuery} found: the query references a
 * field the search type does not declare, or uses it in a role it does not
 * opt into. Vacuous-but-valid clauses (an empty `in` list, a `range` with no
 * bound) are NOT issues — a compiler skips those as no-ops.
 */
export interface QueryIssue {
  readonly part: 'where' | 'facets' | 'orderBy';
  readonly field: string;
  readonly reason:
    | 'unknown-field'
    | 'not-filterable'
    | 'operator-mismatch'
    | 'not-facetable';
}

/**
 * Structurally validate a query against its search type: every `where` clause
 * targets a declared, `filterable` field with the operator its kind accepts
 * ({@link filterOperatorFor}); every requested facet is a declared, `facetable`
 * field; every sort is `relevance` or a declared field. Sorting deliberately
 * checks declaration only, not the `sortable` flag: that flag means *publicly
 * selectable*, and a deployment policy may sort on a private tie-break field.
 *
 * This is the port’s always-on guard: every {@link SearchEngine} adapter MUST
 * reject a query with issues ({@link assertValidQuery}) instead of passing
 * garbage to its engine, so validation holds for every caller — including
 * `queryDefaults` policies and surfaces weaker than GraphQL.
 */
export function validateQuery(
  query: SearchQuery,
  searchType: SearchType,
): readonly QueryIssue[] {
  const issues: QueryIssue[] = [];
  for (const filter of query.where) {
    const field = fieldNamed(searchType, filter.field);
    if (field === undefined) {
      issues.push({
        part: 'where',
        field: filter.field,
        reason: 'unknown-field',
      });
    } else if (field.filterable !== true) {
      issues.push({
        part: 'where',
        field: filter.field,
        reason: 'not-filterable',
      });
    } else if (filterOperatorFor(field.kind) !== filterOperator(filter)) {
      issues.push({
        part: 'where',
        field: filter.field,
        reason: 'operator-mismatch',
      });
    }
  }
  for (const name of query.facets) {
    const field = fieldNamed(searchType, name);
    if (field === undefined) {
      issues.push({ part: 'facets', field: name, reason: 'unknown-field' });
    } else if (field.facetable !== true) {
      issues.push({ part: 'facets', field: name, reason: 'not-facetable' });
    }
  }
  for (const sort of query.orderBy) {
    if (
      sort.field !== 'relevance' &&
      fieldNamed(searchType, sort.field) === undefined
    ) {
      issues.push({
        part: 'orderBy',
        field: sort.field,
        reason: 'unknown-field',
      });
    }
  }
  return issues;
}

/** Throw on the first structurally invalid query part ({@link validateQuery}),
 *  naming every issue. The always-on entry point for engine adapters. */
export function assertValidQuery(
  query: SearchQuery,
  searchType: SearchType,
): void {
  const issues = validateQuery(query, searchType);
  if (issues.length > 0) {
    const detail = issues
      .map((issue) => `${issue.part}: “${issue.field}” (${issue.reason})`)
      .join(', ');
    throw new Error(
      `Invalid search query for “${searchType.name}”: ${detail}.`,
    );
  }
}

/**
 * The 1-based page an `offset` falls on — the numbered-pagination presentation
 * of the IR, shared by the surfaces and the adapters. `limit: 0` (a facet-only
 * query) fetches no hits and has no meaningful page, so it pins to 1 rather
 * than dividing by zero.
 */
export function pageForOffset(offset: number, limit: number): number {
  return limit > 0 ? Math.floor(offset / limit) + 1 : 1;
}
