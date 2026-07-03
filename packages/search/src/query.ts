import type { FieldKind } from './schema.js';

/**
 * The engine- and protocol-neutral query IR. Every API surface parses its input
 * into this; the engine adapter consumes it. It is the shared compiler target
 * that keeps the GraphQL surface, a later REST surface and the adapter from
 * drifting.
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

/**
 * The 1-based page an `offset` falls on — the numbered-pagination presentation
 * of the IR, shared by the surfaces and the adapters. `limit: 0` (a facet-only
 * query) fetches no hits and has no meaningful page, so it pins to 1 rather
 * than dividing by zero.
 */
export function pageForOffset(offset: number, limit: number): number {
  return limit > 0 ? Math.floor(offset / limit) + 1 : 1;
}
