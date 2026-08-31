import type { SearchParams } from 'typesense/lib/Typesense/Documents.js';
import { fold } from '@lde/text-normalization';
import {
  type Criterion,
  type FacetRange,
  type Filter,
  type RootType,
  type SearchField,
  type SearchQuery,
  type SearchSchema,
  type SearchType,
  type CriterionBase,
  type Sort,
  type WeldedCriterion,
} from '@lde/search';
import {
  fieldNamed,
  filterOperator,
  filterOperatorFor,
  ID_FIELD,
  isoToUnixSeconds,
  isInternalField,
  isRangeFacet,
  isWelded,
  joinGraph,
  localLookupTypeOf,
  pageForOffset,
  physicalFields,
  nestedReferenceType,
  resolvePath,
  searchableFields,
} from '@lde/search/adapter';

/** One hop of a join path, resolved: the Root Type it reaches and the
 *  Typesense collection that type is stored in. */
export interface JoinTarget {
  readonly searchType: RootType;
  readonly collection: string;
}

/**
 * Options for {@link buildSearchParams} – the query half of the engine
 * adapter. {@link TypesenseSearchEngineOptions} extends this, so each knob is
 * declared once and the engine forwards its options wholesale.
 */
export interface BuildSearchParamsOptions {
  /**
   * Resolves a criterion’s {@link CriterionBase.on} join path to the collection
   * it constrains – the one thing the engine-neutral {@link JoinGraph}
   * deliberately does not answer, because collection naming is engine- and
   * deployment-specific.
   *
   * Called once per **prefix** of a path, so a two-hop
   * `['dataset', 'publisher']` yields the collection of each hop and compiles
   * to the nested `$datasets($publishers(…))`. The declaration comes back with
   * it, because the leaf term is compiled against the *target* type’s field
   * (its kind, its facet flag), not the searched one.
   *
   * Left unset – or returning `undefined` for a path – a joined criterion
   * compiles to nothing and drops out of its clause. Through the engine it can
   * never get that far: `assertValidQuery` rejects an unresolvable path up
   * front.
   */
  readonly joinTargetFor?: (
    from: SearchType,
    path: readonly string[],
  ) => JoinTarget | undefined;
  /**
   * Cap on the number of buckets returned per facet (`max_facet_values`). Left
   * unset, Typesense defaults to 10 – too few for high-cardinality facets
   * (publisher, keyword), so a deployment with such facets must raise it. Range
   * facets return one bucket per declared range regardless, but a value > the
   * range count is still safe.
   */
  readonly maxFacetValues?: number;
  /**
   * The Search Schema the searched type belongs to – what resolves the facet
   * policy a reference inherits from the type it names
   * (`physicalFields(field, schema).facet`): the `${name}_facet` companion a
   * facet on such a field reads, and the membership operator a filter on it
   * compiles to. Left unset, a facet reads the field itself – which, against a
   * collection built with the schema, is a field the engine does not facet.
   * Through the engine it is always set.
   */
  readonly schema?: SearchSchema;
  /**
   * Called for each `where` clause that does not compile as the caller wrote
   * it – either because it states no constraint (an empty `in` list, a `range`
   * with no usable bound, no criteria at all) and is skipped, or because every
   * criterion is malformed (an unknown field, an operator that does not match
   * the field’s kind – {@link filterOperatorFor}) or unsatisfiable, leaving a
   * clause no document can match. Supply this to log the clause instead of
   * losing it silently; the compiled query itself is faithful either way.
   * Through the engine, a structurally invalid query throws up front
   * (`assertValidQuery`), so there only the clauses that state no constraint
   * reach this.
   */
  readonly onIgnoredFilter?: (filter: Filter) => void;
}

/**
 * Compile the engine-neutral {@link SearchQuery} into Typesense search
 * parameters – the query half of the engine adapter. Pure (no client, no env),
 * so the mapping is asserted directly in unit tests. Field names come from
 * {@link physicalFields}, the same convention the projection and the collection
 * schema use, so a query can never reference a field the index does not carry.
 *
 * A criterion carrying a {@link CriterionBase.on} join path compiles to a
 * nested `$collection(…)` clause – one per hop – which is why the compiler
 * takes {@link BuildSearchParamsOptions.joinTargetFor}: the join graph names
 * the type, the deployment names the collection.
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
  const { names, weights } = queryFields(
    searchType,
    query.locale,
    options.schema,
  );
  const filterBy = compileFilterBy(query.where, searchType, options);
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
    params.facet_by = compileFacetBy(query.facets, searchType, options.schema);
    if (options.maxFacetValues !== undefined) {
      params.max_facet_values = options.maxFacetValues;
    }
  }
  return params;
}

/**
 * The `facet_by` clause. A facet on a numeric field that declares
 * {@link SearchField.facetRanges} faceted into those fixed half-open `[min, max)`
 * bins (a histogram); every other facet is a plain per-value facet on the
 * field the declaration facets ({@link physicalFields} – the field itself, or
 * the `${name}_facet` companion of a reference inheriting a facet policy).
 * Typesense range syntax is already start-inclusive/end-exclusive, so the
 * declared bounds pass straight through with no boundary fix-up.
 */
function compileFacetBy(
  facets: readonly string[],
  searchType: SearchType,
  schema: SearchSchema | undefined,
): string {
  return facets
    .map((name) => {
      const field = fieldNamed(searchType, name);
      if (field === undefined) {
        return name;
      }
      return isRangeFacet(field)
        ? compileRangeFacet(field.name, field.facetRanges)
        : (physicalFields(field, schema).facet ?? name);
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
  schema: SearchSchema | undefined,
): { readonly names: string[]; readonly weights: number[] } {
  const names: string[] = [];
  const weights: number[] = [];
  collectSearchable(searchType, locale, schema, '', new Set(), names, weights);
  return { names, weights };
}

/**
 * Collect the searchable physical fields of a type and of everything it nests,
 * each under the path an engine addresses it by.
 *
 * Nested fields are walked because a nested field may declare `searchable`
 * (ADR 24) – and a companion that is indexed but absent from `query_by` is the
 * worst of both: it costs the RAM of an indexed field and matches nothing, in
 * silence. So the walk here is what makes that Role mean anything.
 *
 * `onPath` guards the walk, and is scoped to the PATH rather than to the walk
 * as a whole: two fields may nest one type – `creator` and `contributor` over
 * the same edge – and each reaches it under its own prefix, so each must
 * contribute its own companions. A set shared across the walk would let the
 * first field claim the type and leave the second's companions indexed but
 * unqueried. What it does guard is a type reached from ITSELF, which a
 * {@link ReferenceStrategy.local local} lookup can do – cut at the same
 * boundary the collection's own walk cuts at, so no field is declared indexed
 * that this walk does not ask for.
 */
function collectSearchable(
  searchType: SearchType,
  locale: string,
  schema: SearchSchema | undefined,
  prefix: string,
  onPath: ReadonlySet<string>,
  names: string[],
  weights: number[],
): void {
  const walked = new Set(onPath).add(searchType.name);
  for (const field of searchableFields(searchType)) {
    const search = physicalFields(field).search;
    const baseWeight = field.searchable.weight;
    if (field.kind === 'text') {
      const locales = field.locales;
      search.forEach((name, index) => {
        names.push(qualify(prefix, name));
        // The active locale keeps full weight; `und` is language-neutral, so
        // it is never demoted (an untagged-only field would otherwise always
        // rank below its declared weight).
        weights.push(
          locales[index] === locale || locales[index] === 'und'
            ? baseWeight
            : Math.max(1, baseWeight - 1),
        );
      });
    } else {
      for (const name of search) {
        names.push(qualify(prefix, name));
        weights.push(baseWeight);
      }
    }
  }
  if (schema === undefined) {
    return;
  }
  for (const field of searchType.fields) {
    // An internal field is pruned before the writer and declared in no
    // collection, so its target's companions exist nowhere – asking `query_by`
    // for one makes the ENGINE reject every search on the collection.
    if (isInternalField(field)) {
      continue;
    }
    const nested =
      nestedReferenceType(schema, field) ?? localLookupTypeOf(field, schema);
    // Cut on the CHILD, not on entry, and against the set this level was
    // reached with – the same boundary the collection's own walk cuts at
    // (`nestedFields`). Returning on entry instead skipped the companions of
    // the level the collection HAD declared, leaving them indexed and absent
    // from `query_by` wherever a type reached itself.
    if (nested !== undefined && !onPath.has(nested.name)) {
      collectSearchable(
        nested,
        locale,
        schema,
        qualify(prefix, field.name),
        walked,
        names,
        weights,
      );
    }
  }
}

/** AND-join the compiled `where` clauses. A clause that states no constraint is
 *  skipped; one that can match nothing compiles to {@link MATCHES_NOTHING}
 *  rather than being skipped ({@link compileFilter}). Either way it did not
 *  compile as written, so it is reported to `onIgnoredFilter`. */
function compileFilterBy(
  where: readonly Filter[],
  searchType: SearchType,
  options: BuildSearchParamsOptions,
): string {
  return where
    .map((filter) => {
      const clause = compileFilter(filter, searchType, options);
      if (clause === undefined || clause === MATCHES_NOTHING) {
        options.onIgnoredFilter?.(filter);
      }
      return clause;
    })
    .filter((clause): clause is string => clause !== undefined)
    .join(' && ');
}

/**
 * One `where` clause: each of its criteria compiled and OR-joined with `||`,
 * parenthesised so the disjunction binds tighter than the `&&` between clauses.
 * A one-criterion clause – the ordinary single-field filter – compiles to a bare
 * term: the parentheses would be harmless but would make every ordinary
 * `filter_by` noisier to read and to assert on.
 *
 * A criterion that yields no term is dropped or voids the clause depending on
 * **why**, because the two readings differ under `||`:
 *
 * - a **vacuous** criterion states no constraint (an empty `in` on a value
 *   field – a facet UI with nothing selected – or a `range` with no usable
 *   bound). It is therefore *true*, and `true || X` is true, so the whole clause
 *   constrains nothing and is skipped. Dropping only the criterion would
 *   NARROW the result to its siblings, the opposite of what an unset filter
 *   means;
 * - an **unsatisfiable** or malformed criterion (an empty `id` membership, an
 *   unknown field, an operator that mismatches the field’s kind) is *false*, and
 *   `false || X` is X, so it drops out and its siblings still stand.
 *
 * Which reading applies decides what a clause left with **no terms** compiles
 * to, and the two are opposites: a vacuous clause states no constraint, so it
 * is skipped; an all-false clause states the query can have no answer, so it
 * compiles to {@link MATCHES_NOTHING}. Skipping that one instead would drop a
 * conjunct and widen the query – `false` compiled as `true`. Both are reported
 * to `onIgnoredFilter`, because neither compiles to what the caller wrote.
 *
 * The engine never meets either: `assertValidQuery` rejects every malformed
 * criterion, and `isUnsatisfiable` short-circuits the empty `id` membership
 * before a query is dispatched.
 */
function compileFilter(
  filter: Filter,
  searchType: SearchType,
  options: BuildSearchParamsOptions,
): string | undefined {
  const terms: string[] = [];
  for (const criterion of filter.or) {
    const outcome = compileCriterion(criterion, searchType, options);
    if (outcome === VACUOUS) {
      return undefined;
    }
    if (outcome !== UNUSABLE) {
      terms.push(outcome);
    }
  }
  if (terms.length === 0) {
    // Every criterion was unusable, so the clause is FALSE – and `false && X`
    // is false, however many clauses stand beside it. Leaving it out would drop
    // a conjunct, and a conjunct missing from `filter_by` constrains nothing:
    // the query would come back WIDER than the caller wrote, which is how a
    // misspelled field name used to return the whole collection.
    //
    // A clause carrying no criteria at all says nothing rather than saying
    // false, so it stays the vacuous no-op it reads as.
    return filter.or.length === 0 ? undefined : MATCHES_NOTHING;
  }
  return terms.length === 1 ? terms[0] : `(${terms.join(' || ')})`;
}

/**
 * The term for a clause that can match no document: an **empty identity
 * membership** – “the document is one of no documents”. Not a sentinel value
 * but the literal reading, and the same one {@link isUnsatisfiable} gives an
 * empty `id` membership in the IR; Typesense answers it with zero hits.
 *
 * A filter language has no keyword for `false`, so this stands in for one. It
 * must be a term the engine *applies* rather than ignores – an empty string
 * (``id:=` ` ``) is rejected outright as a filter value, and an omitted clause
 * is read as true.
 */
const MATCHES_NOTHING = `${ID_FIELD}:=[]`;

/** A criterion that states **no constraint** – true for every document. */
const VACUOUS = Symbol('vacuous');
/** A criterion that matches nothing, or cannot be compiled at all – false. */
const UNUSABLE = Symbol('unusable');

/**
 * What one criterion contributes: a Typesense term, or which of the two ways it
 * yields none. The distinction is load-bearing under `||` ({@link compileFilter})
 * and cannot be recovered from a bare `undefined`, so it is returned rather than
 * re-derived by a second pass over the same rules.
 */
function compileCriterion(
  criterion: Criterion,
  searchType: SearchType,
  options: BuildSearchParamsOptions,
): string | typeof VACUOUS | typeof UNUSABLE {
  const on = criterion.on ?? [];
  if (on.length === 0) {
    return isWelded(criterion)
      ? compileWelded(criterion, searchType, options.schema, '')
      : compileLeaf(criterion, searchType, options.schema);
  }
  // The path carries two kinds of hop, and they compile differently: a JOIN
  // crosses into another collection and wraps the leaf in `$collection(…)`; a
  // NESTING stays in this document and qualifies the leaf’s field name. The
  // schema is what tells them apart, so without one every hop is read as a
  // join – exactly the behaviour before nesting existed.
  const resolvedPath =
    options.schema === undefined
      ? undefined
      : resolvePath(searchType, on, options.schema, joinGraph(options.schema));
  if (typeof resolvedPath === 'string') {
    return UNUSABLE;
  }
  const joinHops = resolvedPath?.joinPath ?? on;
  const nestedHops = resolvedPath?.nestedPath ?? [];
  // A joined criterion constrains a document in ANOTHER collection, so the leaf
  // is compiled against the type that path reaches and then wrapped, one
  // `$collection(…)` per hop, outermost hop first:
  // `['dataset', 'publisher']` → `$datasets($publishers(id:=…))`.
  const collections: string[] = [];
  let target = searchType;
  for (let hop = 1; hop <= joinHops.length; hop++) {
    const resolved = options.joinTargetFor?.(
      searchType,
      joinHops.slice(0, hop),
    );
    if (resolved === undefined) {
      // An unresolvable path is a criterion that cannot be compiled at all –
      // false, so it drops out and its siblings still stand. Through the
      // engine, `assertValidQuery` has already rejected it.
      return UNUSABLE;
    }
    collections.push(resolved.collection);
    target = resolved.searchType;
  }
  const leafType = resolvedPath?.leafType ?? target;
  const prefix = nestedHops.join('.');
  const leaf = isWelded(criterion)
    ? compileWelded(criterion, leafType, options.schema, prefix)
    : compileLeaf(criterion, leafType, options.schema, prefix);
  // A vacuous leaf states no constraint on the referent, so the join as a whole
  // states none either – the reading, and so the outcome, passes straight
  // through the hops.
  if (leaf === VACUOUS || leaf === UNUSABLE) {
    return leaf;
  }
  return collections.reduceRight(
    (inner, collection) => `$${collection}(${inner})`,
    leaf,
  );
}

/**
 * The criterion’s own term, against the type it actually constrains – the
 * searched type, the one its join path reaches, or the reference type its
 * nesting path walks into.
 *
 * `prefix` is that nesting path, dotted: an engine addresses a stored nested
 * document by qualifying the field name, so `role` inside `creator` becomes
 * `creator.role`. Empty for every unnested criterion.
 */
function compileLeaf(
  criterion: Criterion,
  searchType: SearchType,
  schema: SearchSchema | undefined,
  prefix = '',
): string | typeof VACUOUS | typeof UNUSABLE {
  // `id` is the Typesense document key, not a declared field. Exact `:=`
  // membership, like a non-facet field ({@link compileMembership}), so an IRI
  // cannot partial-match on a shared path segment. (`fetchLabels` resolves
  // labels with the looser `id:[…]`; these are deliberately not the same
  // clause.) An empty identity membership enumerates NO document, so it is
  // unusable rather than vacuous – the one place the two readings diverge.
  if (criterion.field === ID_FIELD) {
    // `id` names the DOCUMENT key, which exists only at the top level: inside a
    // nested reference there is no document to key. Compiling it under a prefix
    // would filter the root collection's `id` instead – a different question,
    // silently answered. `assertValidQuery` rejects it first; this is the guard
    // for a hand-built query.
    return prefix === '' && 'in' in criterion && criterion.in.length > 0
      ? `${ID_FIELD}:=[${criterion.in.map(escapeFilterValue).join(',')}]`
      : UNUSABLE;
  }
  const field = fieldNamed(searchType, criterion.field);
  if (field === undefined) {
    return UNUSABLE;
  }
  // A criterion whose operator does not match the field's kind (e.g. `range` on
  // a keyword) would reach the engine as garbage syntax – skip it instead.
  if (filterOperatorFor(field.kind) !== filterOperator(criterion)) {
    return UNUSABLE;
  }
  if ('in' in criterion) {
    return criterion.in.length > 0
      ? compileMembership(field, criterion.in, schema, prefix)
      : VACUOUS;
  }
  if ('range' in criterion) {
    return compileRange(field, criterion.range, prefix) ?? VACUOUS;
  }
  // Every other shape returned above; a welded criterion never reaches here
  // (compileWelded handles it before the leaf compiler is called).
  return `${qualify(prefix, field.name)}:=${(criterion as CriterionBase & { readonly is: boolean }).is}`;
}

/** A field name under its nesting path, if any – the one place the dotted
 *  addressing an engine uses for a stored nested document is spelled. */
function qualify(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}.${name}`;
}

/**
 * A **welded** criterion: `path.{a && b}`, matching a document with ONE entry
 * that satisfies every condition – as against `path.a && path.b`, which two
 * different entries can satisfy between them.
 *
 * Each condition is compiled against the reference type with an EMPTY prefix,
 * so what goes inside the braces is always a leaf name. That is a correctness
 * requirement, not tidiness: Typesense 30.2 **hangs** on a dotted path inside a
 * group (`creator.{creator.name:=…}` never returns – no error, no result), so
 * the compiler must be structurally incapable of emitting one. A field whose
 * value is itself nested is reached through its identity companion, which is a
 * leaf ({@link physicalFields}).
 *
 * A condition that states no constraint drops out, and the weld is whatever
 * remains; a weld left with nothing is vacuous like any other empty clause.
 */
function compileWelded(
  criterion: WeldedCriterion,
  searchType: SearchType,
  schema: SearchSchema | undefined,
  prefix: string,
): string | typeof VACUOUS | typeof UNUSABLE {
  const entryType =
    schema &&
    nestedReferenceType(
      schema,
      fieldNamed(searchType, criterion.field) ?? ({} as SearchField),
    );
  if (entryType === undefined) {
    return UNUSABLE;
  }
  const conditions: string[] = [];
  for (const condition of criterion.entry) {
    const compiled = compileLeaf(condition, entryType, schema);
    if (compiled === UNUSABLE) {
      return UNUSABLE;
    }
    if (compiled !== VACUOUS) {
      conditions.push(compiled);
    }
  }
  if (conditions.length === 0) {
    return VACUOUS;
  }
  return `${qualify(prefix, criterion.field)}.{${conditions.join(' && ')}}`;
}

/**
 * A membership clause. A non-facet (tokenized) field uses the exact `:=`
 * operator so an IRI cannot partial-match on a shared path segment.
 *
 * *Non-facet* is the **engine’s** facet status, not the declaration’s: a
 * reference inheriting a facet policy is `facetable` in the schema while the
 * engine facets its companion and stores the field itself plain – and a
 * filter on such a field is exactly what the policy promises stays whole, so
 * it must compile exact, not tokenized.
 */
function compileMembership(
  field: SearchField,
  values: readonly string[],
  schema: SearchSchema | undefined,
  prefix = '',
): string {
  const list = `[${values.map(escapeFilterValue).join(',')}]`;
  const names = physicalFields(field, schema);
  // An inline reference stores a nested object, which an engine cannot filter.
  // Its identity companion is the flat id field standing in for it – so the
  // logical name a consumer writes and the physical name the engine reads
  // differ here, and only here.
  const name = qualify(prefix, names.identity ?? field.name);
  return names.facet === name ? `${name}:${list}` : `${name}:=${list}`;
}

/** An inclusive Typesense range clause, or `undefined` when neither bound is
 *  usable. Which of the two readings that is – the caller set no bounds, or the
 *  codec rejected the ones they set – is deliberately NOT decided here: a
 *  criterion dropped from a clause narrows the query while a clause dropped
 *  from the conjunction widens it, so the same reading cannot be right in both
 *  positions. `validateQuery` rejects an unreadable bound outright instead,
 *  which is the only answer that neither widens nor narrows. */
function compileRange(
  field: SearchField,
  range: { readonly min?: number | string; readonly max?: number | string },
  prefix = '',
): string | undefined {
  const name = qualify(prefix, field.name);
  // A bound a caller sent as `null` – a GraphQL variable left unfilled, which
  // the surface passes through – is a bound NOT SET, not a bound of `null`.
  // Read literally it reaches the engine as `datePosted:[null..…]`, which
  // Typesense rejects outright.
  const min = storedBound(field, range.min ?? undefined);
  const max = storedBound(field, range.max ?? undefined);
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
  if (field !== undefined && field.kind === 'text') {
    // Sort on the active locale's key, falling back to the first declared
    // locale (e.g. an und-only field sorted by a user in any language).
    const index = field.locales.indexOf(locale);
    const sortName = physicalFields(field).sort[index === -1 ? 0 : index];
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
