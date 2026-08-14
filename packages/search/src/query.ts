import {
  fieldNamed,
  filterOperatorFor,
  ID_FIELD,
  type SearchSchema,
  type SearchType,
} from './schema.js';
import { MAX_JOIN_DEPTH, type JoinGraph } from './join-graph.js';

/**
 * The engine- and protocol-neutral query IR. Every API surface compiles its
 * input into this; every engine adapter compiles it into an engine query. One
 * shared representation in the middle keeps the GraphQL surface, a later REST
 * surface and the adapter from drifting.
 */
export interface SearchQuery {
  /** Free-text query; `undefined`/`''` means browse (no text ranking). */
  readonly text?: string;
  /** AND across clauses; each clause is a disjunction ({@link Filter}). */
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
  /**
   * Which `lookup` references to resolve on the hits, and how much of each
   * referent to carry. Omitted (or a field left out of it), a lookup resolves
   * its target’s label alone – what every reference carried before.
   *
   * A surface builds this from what its caller asked for (GraphQL: the
   * selection set), so the engine fetches neither less nor more. See
   * [ADR 20](../../docs/decisions/0020-resolve-a-references-fields-from-the-targets-own-collection.md).
   */
  readonly resolve?: ReferenceProjection;
}

/**
 * What every {@link Criterion} carries, whatever its operator: the field it
 * constrains, and – for a criterion that constrains a *joined* document rather
 * than this one – the path of joinable references to walk to reach it.
 */
export interface CriterionBase {
  /** The logical field name, on the type the {@link CriterionBase.on} path
   *  reaches (or on the searched type when there is none). */
  readonly field: string;
  /**
   * A **join path**: the names of the {@link ReferenceField.joinable}
   * references to follow, in order, to the type this criterion constrains.
   * `['dataset', 'publisher']` on a `CreativeWork` criterion means *the
   * publisher of the dataset this work belongs to*. Omitted (or empty) for the
   * ordinary case: the criterion constrains the searched type itself.
   *
   * A path, deliberately, and not boolean structure – so the criterion stays an
   * **atom** and `where` stays the flat conjunction of disjunctions
   * [ADR 18](../../docs/decisions/0018-filter-across-several-fields-with-one-clause.md)
   * made it. `on` sits on the criterion rather than on the {@link Filter} for
   * the same reason a criterion carries its own operator: a `Filter`-level
   * `on` would scope the whole disjunction and make
   * `“published by X, or titled Y”` inexpressible.
   *
   * Capped at {@link MAX_JOIN_DEPTH} hops and resolved by
   * {@link validateQuery} against the schema’s {@link JoinGraph}.
   */
  readonly on?: readonly string[];
}

/**
 * What to carry for each resolved reference, keyed by the reference field’s
 * name. `fields` names the referent’s own output fields; `resolve` nests, for a
 * referent whose own references are wanted in turn – an engine answers one
 * batched lookup per level, never one per document.
 *
 * Deliberately the shape of a selection set rather than a second vocabulary: a
 * per-level option (a `limit` here, a `where` there) would multiply with depth.
 */
export type ReferenceProjection = Readonly<
  Record<
    string,
    {
      readonly fields?: readonly string[];
      readonly resolve?: ReferenceProjection;
    }
  >
>;

/**
 * One criterion on one field. The operator is fixed by that field’s
 * {@link FieldKind} ({@link filterOperatorFor}): keyword/reference use `in` (OR
 * within the value list), the numeric/date kinds use an inclusive `range`,
 * boolean uses `is`. Bounds are inclusive only – no `gt`/`gte`/`lt`/`lte`.
 *
 * Criteria are the atoms a {@link Filter} is built from, so each carries its own
 * field AND its own operator: one clause may range over a `reference` and a
 * `keyword` field at once, and each field is constrained the way its kind
 * allows. Each equally carries its own {@link CriterionBase.on} join path, so
 * one clause may mix a condition on this document with one on a joined
 * document.
 */
export type Criterion =
  | (CriterionBase & { readonly in: readonly string[] })
  | (CriterionBase & {
      readonly range: {
        readonly min?: number | string;
        readonly max?: number | string;
      };
    })
  | (CriterionBase & { readonly is: boolean });

/**
 * One `where` clause: a disjunction, matching a document that satisfies **any**
 * of its criteria. An ordinary single-field filter is the one-criterion case,
 * so there is no separate cross-field variant for a consumer to overlook – an
 * adapter that iterates `or` serves one criterion and five by the same code.
 *
 * Clauses AND together ({@link SearchQuery.where}), so a query is a **flat**
 * conjunction of disjunctions. Deliberately flat rather than a boolean tree:
 * skip-own-filter (ADR 5) removes *a facet’s own clause*, which has no answer
 * once a clause can be nested inside another. A criterion is therefore an atom –
 * it can never itself be a conjunction.
 */
export interface Filter {
  readonly or: readonly Criterion[];
}

/** A single sort dimension. */
export interface Sort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

// The kind→operator table lives with the field model in schema.ts (one source
// for the query IR, the surfaces, the adapters AND declaration validation);
// re-exported here so the query-IR module stays the natural import site.
export { filterOperatorFor } from './schema.js';
export type { FilterOperator } from './schema.js';
import type { FilterOperator } from './schema.js';

/** The operator a {@link Criterion} carries, from its discriminating key. */
export function filterOperator(criterion: Criterion): FilterOperator {
  return 'in' in criterion ? 'in' : 'range' in criterion ? 'range' : 'is';
}

/** A one-criterion clause – the ordinary single-field filter, and the shape a
 *  keyed API surface compiles each of its keys into. */
export function filterOn(criterion: Criterion): Filter {
  return { or: [criterion] };
}

/**
 * Whether the query asks for nothing, so no engine can answer it with a hit.
 * True for an empty `in` on a clause naming {@link ID_FIELD} **alone** – and
 * only there, deliberately:
 *
 * An **identity** filter enumerates the documents wanted, so the empty set
 * wants none. A **value** filter constrains a dimension, so an empty set
 * constrains nothing – which is why every other vacuous clause is a no-op the
 * compilers skip (a facet UI with nothing selected sends exactly that). The
 * readings differ because the fields differ in kind, and only for `id` would
 * “no constraint” hand back the whole collection to a caller who asked for
 * specific things – the likely shape being a client mapping a possibly-empty
 * reference array (`id: { in: doc.publisher }`) into a batch lookup.
 *
 * The identity reading needs the clause to be *only* about identity, so it must
 * carry that one criterion and nothing else. A clause pairing `id` with a value
 * field (`{ or: [{ field: 'id', in: [] }, { field: 'creator', in: [] }] }`)
 * is a disjunction that happens to include identity, not an enumeration of
 * wanted documents, so it stays the vacuous no-op every other empty `in` is.
 *
 * A joined identity clause (`{ on: […], field: 'id', in: [] }`) reads the same
 * way one hop out: it enumerates the *referents* wanted, and no referent means
 * no document can match through that edge.
 *
 * An adapter MUST answer an unsatisfiable query with an empty result rather
 * than dispatching it.
 */
export function isUnsatisfiable(query: SearchQuery): boolean {
  return query.where.some((filter) => {
    const [criterion] = filter.or;
    return (
      filter.or.length === 1 &&
      criterion !== undefined &&
      criterion.field === ID_FIELD &&
      'in' in criterion &&
      criterion.in.length === 0
    );
  });
}

/**
 * One structural problem {@link validateQuery} found: the query references a
 * field the search type does not declare, or uses it in a role it does not
 * opt into. Reported per **criterion**, so a clause carrying two criteria over
 * unknown fields yields two issues, each naming its own field.
 *
 * Vacuous-but-valid clauses (an empty `in` list, a `range` with no bound, a
 * clause with no criteria) are NOT issues – a compiler skips those as no-ops.
 */
export interface QueryIssue {
  readonly part: 'where' | 'facets' | 'orderBy' | 'resolve';
  readonly field: string;
  readonly reason:
    | 'unknown-field'
    | 'not-filterable'
    | 'operator-mismatch'
    | 'not-facetable'
    /** The criterion’s `on` path is longer than {@link MAX_JOIN_DEPTH}. */
    | 'join-too-deep'
    /** The `on` path does not resolve: a name that is not a field, a reference
     *  that is not `joinable`, or no join graph to resolve it against. */
    | 'unknown-join'
    /** A projected reference is not a `lookup`, so nothing resolves it. */
    | 'not-resolvable';
}

/** The `field` a joined issue is reported under: the path and the leaf name
 *  together, so a message says which hop and which field, not just which
 *  field. `dataset.publisher.id` reads the way the criterion was written. */
function issueField(criterion: Criterion): string {
  const on = criterion.on ?? [];
  return on.length === 0 ? criterion.field : [...on, criterion.field].join('.');
}

/**
 * Structurally validate a query against its search type: **every criterion of
 * every `where` clause** names a declared, `filterable` field whose kind accepts
 * that criterion’s operator ({@link filterOperatorFor}) – or the undeclared,
 * always-filterable {@link ID_FIELD}, which takes `in`; every requested facet is
 * a declared, `facetable` field; every sort is `relevance` or a declared field.
 * Because each criterion is matched against its own field’s kind, one clause may
 * range over fields of different kinds. Sorting deliberately
 * checks declaration only, not the `sortable` flag: that flag means *publicly
 * selectable*, and a deployment policy may sort on a private tie-break field.
 *
 * A criterion carrying an {@link CriterionBase.on} join path is checked against
 * the type that path reaches instead: the path must be at most
 * {@link MAX_JOIN_DEPTH} hops (`join-too-deep`) and must resolve through
 * `joins` (`unknown-join`), and the leaf field must then be filterable on the
 * *target* type. The cap lives here, in the IR, rather than in an adapter or a
 * surface, so every surface inherits it. `joins` is optional because a query
 * with no join path needs none; a joined criterion validated without one is an
 * `unknown-join`, never a silently unchecked filter.
 *
 * A `resolve` projection is checked at every level, which is why the whole
 * `schema` is passed alongside the type being queried: each level’s fields
 * belong to the `target` the level above names, and only the schema resolves a
 * target to its type.
 *
 * This is the port’s always-on guard: every {@link SearchEngine} adapter MUST
 * reject a query with issues ({@link assertValidQuery}) instead of passing
 * garbage to its engine, so validation holds for every caller – including
 * `queryDefaults` policies and surfaces weaker than GraphQL.
 */
export function validateQuery(
  query: SearchQuery,
  searchType: SearchType,
  schema: SearchSchema,
  joins?: JoinGraph,
): readonly QueryIssue[] {
  const issues: QueryIssue[] = [];
  for (const filter of query.where) {
    // Each criterion is checked on its own, so a multi-criterion clause needs
    // no rule of its own: naming an undeclared or non-filterable field is the
    // same mistake whether the clause carries one criterion or five, and each
    // criterion is matched against ITS OWN field’s kind – so one clause may mix
    // a `reference` membership with a `date` range without either being wrong.
    for (const criterion of filter.or) {
      const name = criterion.field;
      const field = issueField(criterion);
      // A criterion may constrain a JOINED document, and then every rule below
      // is about the type its `on` path reaches, not about the searched one.
      // Resolving the path needs the schema’s join graph, so a caller that
      // supplied none cannot serve a joined criterion at all.
      const on = criterion.on ?? [];
      let constrained = searchType;
      if (on.length > 0) {
        if (on.length > MAX_JOIN_DEPTH) {
          issues.push({ part: 'where', field, reason: 'join-too-deep' });
          continue;
        }
        const target = joins?.resolve(searchType, on);
        if (target === undefined) {
          issues.push({ part: 'where', field, reason: 'unknown-join' });
          continue;
        }
        constrained = target;
      }
      // `id` is filterable on every type without being declared by any: it is
      // the document’s IRI, so the lookup exists wherever documents do.
      // Membership only – an IRI has no range and no truth value.
      if (name === ID_FIELD) {
        if (filterOperator(criterion) !== 'in') {
          issues.push({
            part: 'where',
            field,
            reason: 'operator-mismatch',
          });
        }
        continue;
      }
      const declared = fieldNamed(constrained, name);
      if (declared === undefined) {
        issues.push({ part: 'where', field, reason: 'unknown-field' });
      } else if (declared.filterable !== true) {
        issues.push({ part: 'where', field, reason: 'not-filterable' });
      } else if (
        filterOperatorFor(declared.kind) !== filterOperator(criterion)
      ) {
        issues.push({
          part: 'where',
          field,
          reason: 'operator-mismatch',
        });
      }
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
  collectProjectionIssues(query.resolve, searchType, schema, issues);
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

/**
 * Walk a projection level by level: each key names a `lookup` reference on the
 * type that level belongs to, each `fields` entry an `output` field of the
 * target it resolves against, and each nested `resolve` repeats against that
 * target. A level whose reference is unresolvable stops there – its subtree
 * belongs to a target that does not exist, so reporting it too would bury the
 * one mistake under its consequences.
 */
function collectProjectionIssues(
  projection: ReferenceProjection | undefined,
  searchType: SearchType,
  schema: SearchSchema,
  issues: QueryIssue[],
): void {
  for (const [name, level] of Object.entries(projection ?? {})) {
    const field = fieldNamed(searchType, name);
    if (field === undefined) {
      issues.push({ part: 'resolve', field: name, reason: 'unknown-field' });
      continue;
    }
    if (field.kind !== 'reference' || field.ref?.strategy !== 'lookup') {
      issues.push({ part: 'resolve', field: name, reason: 'not-resolvable' });
      continue;
    }
    const targetName = field.ref.target;
    const target = [...schema.values()].find(
      (rootType) => rootType.name === targetName,
    );
    if (target === undefined) {
      // searchSchema rejects a lookup whose target it cannot resolve, so this
      // is a query built against a different schema than the engine serves.
      issues.push({ part: 'resolve', field: name, reason: 'not-resolvable' });
      continue;
    }
    for (const wanted of level.fields ?? []) {
      const targetField = fieldNamed(target, wanted);
      if (targetField === undefined || targetField.output !== true) {
        issues.push({
          part: 'resolve',
          field: `${name}.${wanted}`,
          reason: 'unknown-field',
        });
      }
    }
    collectProjectionIssues(level.resolve, target, schema, issues);
  }
}

/** Throw on the first structurally invalid query part ({@link validateQuery}),
 *  naming every issue. The always-on entry point for engine adapters. */
export function assertValidQuery(
  query: SearchQuery,
  searchType: SearchType,
  schema: SearchSchema,
  joins?: JoinGraph,
): void {
  const issues = validateQuery(query, searchType, schema, joins);
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
 * The 1-based page an `offset` falls on – the numbered-pagination presentation
 * of the IR, shared by the surfaces and the adapters. `limit: 0` (a facet-only
 * query) fetches no hits and has no meaningful page, so it pins to 1 rather
 * than dividing by zero.
 */
export function pageForOffset(offset: number, limit: number): number {
  return limit > 0 ? Math.floor(offset / limit) + 1 : 1;
}
