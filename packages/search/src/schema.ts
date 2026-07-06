import type { FramedNode } from './frame-by-type.js';
import type { SearchDocument } from './project.js';

/**
 * The engine-neutral kind of a queryable field. It drives every downstream
 * behavior: which physical fields the projection emits, the engine
 * collection-schema type, the `where`/facet/sort semantics, and the GraphQL
 * output/input type. The Typesense-vocabulary types (`string`, `int32`, …) are
 * *derived* from this by the engine adapter, never declared here.
 */
export type FieldKind =
  | 'text'
  | 'keyword'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'reference';

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
 * than `where`. The ONE source for the surface’s `where` input type, the
 * adapter’s filter compiler and declaration validation, so they cannot drift.
 */
export function filterOperatorFor(kind: FieldKind): FilterOperator | undefined {
  return OPERATOR_BY_KIND[kind];
}

/**
 * One queryable field — the single declarative source that drives all four
 * consumers (projection, engine collection schema, query semantics, and the
 * GraphQL surface).
 *
 * A **discriminated union by `kind`**: each kind declares exactly the
 * properties it can honour (`ref` on references, `locales` on text,
 * `facetRanges` on numerics), so an illegal declaration fails to compile.
 * {@link validateSearchType} enforces the same rules at runtime for
 * declarations built outside TypeScript (a SHACL generator, plain JS).
 *
 * Capability flags (`searchable`/`filterable`/`facetable`/`sortable`/`output`)
 * are independent opt-ins: a field exposes exactly the roles it declares. A
 * field with a {@link SearchFieldBase.derive `derive`} function instead of a
 * `path` is a **derived field** — computed from the framed node rather than
 * projected from the IR — yet it still carries full query/schema/output
 * behavior (e.g. `status`, the compatibility booleans).
 *
 * The physical field names a declaration fans out to (per-locale search/sort
 * keys) follow one convention, owned by
 * {@link physicalFields} so projection, collection-schema and query compiler
 * cannot disagree.
 *
 * SHACL is one possible *source*, not a dependency: a generator can emit a
 * declaration from a NodeShape + `search:` annotations
 * (`kind`←`sh:datatype`/`sh:nodeKind`, `path`←`sh:path`, `array`←`sh:maxCount`,
 * `locales`←`sh:languageIn` (plus `und` where plain strings are allowed),
 * `ref`←`sh:node`/`sh:class`),
 * and a hand-written declaration is just as valid.
 */
export type SearchField =
  | TextField
  | KeywordField
  | ReferenceField
  | NumericField
  | BooleanField;

/** The declaration members every {@link SearchField} kind shares. */
export interface SearchFieldBase {
  /** Logical API name; the physical fanout derives from it. Declare camelCase
   *  where it surfaces in GraphQL. */
  readonly name: string;
  /** Framed-IR predicate IRI to project from. Omit for a field populated by
   *  {@link SearchFieldBase.derive} (or outside the projection entirely). */
  readonly path?: string;
  /** Multi-valued. */
  readonly array?: boolean;
  /** Always present: a non-null scalar in the API output and
   *  a non-optional field in the engine index. Moot for arrays/booleans/`id`,
   *  which are non-null regardless. */
  readonly required?: boolean;
  /** Appears in the API output type / carries a display label. */
  readonly output?: boolean;
  /** Usable in `where`. */
  readonly filterable?: boolean;
  /** Returned as facet buckets. */
  readonly facetable?: boolean;
  /** Publicly selectable in `orderBy`; localized text also emits a folded sort key. */
  readonly sortable?: boolean;
  /**
   * Compute this field’s value instead of projecting it from a `path` — a
   * status token, a compatibility boolean, a count over the framed node.
   * Mutually exclusive with `path`. Runs in declaration order during
   * projection, receiving the framed node and the document as populated so
   * far, so a derived field may read fields declared before it (e.g. a
   * `statusRank` reading the derived `status`). Return `undefined` to leave
   * the field absent. The field still carries full query/schema/output
   * behaviour like any other.
   */
  readonly derive?: (node: FramedNode, document: SearchDocument) => unknown;
}

/** Full-text inclusion with a `query_by` weight (folded; per-locale for
 *  localized text). Presence is what makes a field searchable. */
export interface Searchable {
  readonly searchable?: { readonly weight: number };
}

/**
 * Free-running text (prose), always multilingual in shape: projected per
 * locale into display/search/sort companions. `locales` lists the language
 * tags to emit; the reserved locale **`und`** (JSON-LD `@none`, RDF `und`)
 * buckets untagged literals, so a monolingual or untagged corpus declares
 * `locales: ['und']` and mixed data `['nl', 'und']` — one mechanism, and
 * adding a language later is additive (the API output shape never changes).
 * Declaring a real language is RECOMMENDED where the data has one: it drives
 * the engine’s per-locale stemming; `und` is folded but unstemmed (unless the
 * deployment’s `defaultLocale` opts in). Feeds the free-text query rather
 * than `where`/facets, so it is deliberately not filterable or facetable. Use
 * {@link KeywordField} only for exact-match tokens, never for prose.
 */
export interface TextField extends SearchFieldBase, Searchable {
  readonly kind: 'text';
  /** The locales to emit (per-locale fanout); at least one. `und` = untagged. */
  readonly locales: readonly string[];
  readonly filterable?: never;
  readonly facetable?: never;
  readonly facetRanges?: never;
}

/** An exact-match token or free string: filtered by membership, faceted per
 *  value, searchable folded. */
export interface KeywordField extends SearchFieldBase, Searchable {
  readonly kind: 'keyword';
  /** Projection-time value transform (e.g. strip a media-type prefix). */
  readonly transform?: (value: string) => string;
  readonly facetRanges?: never;
}

/** An IRI-valued reference to another entity, label-resolved at the surface. */
export interface ReferenceField extends SearchFieldBase, Searchable {
  readonly kind: 'reference';
  /** Projection-time value transform. */
  readonly transform?: (value: string) => string;
  readonly facetRanges?: never;
  /**
   * The `name` of the {@link SearchType} whose collection resolves this
   * reference’s labels – its ‘label source’. The named type must declare an
   * `output`, `searchable` text field called `label` (validated by
   * {@link searchSchema}), so an engine can both reconstruct the label and
   * search it (typeahead). Omit for an id-only reference: no label
   * resolution.
   */
  readonly labelSource?: string;
  /** The referenced entity’s shape and how much of it to carry. Required when
   *  the field is `output` (the API surfaces need the reference type name);
   *  optional for a facet- or filter-only reference. */
  readonly ref?: {
    /** Logical API type name of the referenced entity (PascalCase, e.g.
     *  `Organization`) — names the reference’s type in the API surfaces, the
     *  way {@link SearchType.name} names a root type; fields sharing it share
     *  one emitted type. A name, not a key: it need not correspond to any
     *  indexed root type (and until cross-collection references exist, it must
     *  not collide with one). */
    readonly typeName: string;
    /** How much of the referenced entity the reference carries. Only
     *  `labelOnly` (id + display label) is implemented; `idOnly` and `inline`
     *  are forward declarations, so that declarations (and the SHACL
     *  `search:nestedStrategy` mapping) keep their shape when those land, and
     *  `inline` can then add fields to the reference type additively. */
    readonly strategy: 'labelOnly' | 'idOnly' | 'inline';
  };
}

/**
 * Range-facet bins for a numeric (`integer`/`number`/`date`) facetable field.
 * When set, the field facets into these fixed half-open `[min, max)` ranges (a
 * histogram) rather than one bucket per distinct value — the per-bucket counts
 * a UI slider needs. Bins are query-time only (no index impact) and
 * engine-neutral: the Typesense adapter emits a `facet_by` range, an
 * OpenSearch adapter a `range` aggregation. See {@link FacetRange}.
 */
export interface RangeFacetable {
  readonly facetRanges?: readonly FacetRange[];
}

/**
 * A numeric value: range-filtered, range- or value-faceted, sortable.
 * `integer` is a whole number, `number` a float, `date` a point in time
 * (ISO 8601 at the edges, Unix seconds in the index) — identical capabilities,
 * so one interface serves all three kinds; `field.kind` still narrows.
 */
export interface NumericField extends SearchFieldBase, RangeFacetable {
  readonly kind: 'integer' | 'number' | 'date';
  readonly searchable?: never;
}

/** A boolean flag; absent in a document means `false`. */
export interface BooleanField extends SearchFieldBase {
  readonly kind: 'boolean';
  readonly searchable?: never;
  readonly facetRanges?: never;
}

/**
 * One half-open `[min, max)` range-facet bin: `min` inclusive, `max` exclusive,
 * so contiguous bins partition cleanly with no boundary double-counting. Omit
 * `min` (or `max`) for an open-ended bin (`< max`, resp. `≥ min`). `key` is the
 * bucket’s stable label, echoed back as the {@link FacetBucket} `value`.
 */
export interface FacetRange {
  readonly key: string;
  readonly min?: number;
  readonly max?: number;
}

/**
 * One root type’s complete search declaration: its logical API `name`, the
 * `type` IRI its documents are instances of, and the queryable `fields`
 * (including {@link SearchField.derive derived} ones). A SHACL generator can
 * emit one per NodeShape (`name`←`sh:name`/local name, `type`←`sh:targetClass`,
 * `fields`←its property shapes), but that is a source, not a requirement.
 */
export interface SearchType {
  /** Logical API name (PascalCase, e.g. `Dataset`) — names the type in the API
   *  surfaces (GraphQL type names, a REST path), the way each field’s
   *  {@link SearchField.name} names that field. Deliberately declared rather
   *  than derived from the `type` IRI, so re-modelling the vocabulary cannot
   *  silently rename the public contract. */
  readonly name: string;
  readonly type: string;
  readonly fields: readonly SearchField[];
}

/**
 * Declare a {@link SearchType}, capturing it as a literal: the `const` type
 * parameter preserves the field names and capability flags that the type-level
 * helpers (`FacetFieldsOf`, `OutputFieldsOf`) read off the type —
 * with none of the widening a plain `: SearchType` annotation causes and
 * without having to remember `as const satisfies SearchType`. Identity at
 * runtime.
 */
export function defineSearchType<const Type extends SearchType>(
  searchType: Type,
): Type {
  return searchType;
}

/**
 * The complete search declaration of a deployment: every root {@link SearchType},
 * keyed by its `type` IRI. Build one with {@link searchSchema}, which captures
 * the declared types as a literal tuple (`Types`), so schema-bound consumers
 * (the engine port) can type their per-type behaviour off it. A plain
 * `: SearchSchema` annotation widens gracefully to `SearchType`.
 */
/** Brand for {@link SearchSchema}: type-only, no runtime existence. Makes the
 *  schema NOMINAL — a hand-built `Map` is not assignable, so `searchSchema()`
 *  (which validates) is the only way to obtain one and downstream consumers
 *  need no defensive re-validation. */
export declare const validSearchSchema: unique symbol;

export interface SearchSchema<
  Types extends readonly SearchType[] = readonly SearchType[],
> extends ReadonlyMap<string, Types[number]> {
  readonly [validSearchSchema]: true;
}

/**
 * Build a {@link SearchSchema} from root-type declarations, keyed by `type`.
 *
 * Every declaration is validated ({@link assertValidSearchType}) — the
 * declaration-time counterpart of the port’s `assertValidQuery` — and the
 * schema-wide invariants are enforced: no two types may share a `type` IRI
 * (they would silently overwrite each other in the map) or a `name` (names
 * key the API surfaces). Throws on the first invalid declaration, so a bad
 * schema fails at startup, not per document at index time or per query.
 */
export function searchSchema<const Types extends readonly SearchType[]>(
  ...types: Types
): SearchSchema<Types> {
  const typeIris = new Set<string>();
  const names = new Set<string>();
  for (const searchType of types) {
    assertValidSearchType(searchType);
    if (typeIris.has(searchType.type)) {
      throw new Error(
        `Duplicate search type IRI “${searchType.type}”; each SearchType must declare a distinct type.`,
      );
    }
    if (names.has(searchType.name)) {
      throw new Error(
        `Duplicate search type name “${searchType.name}”; each SearchType must declare a distinct name.`,
      );
    }
    typeIris.add(searchType.type);
    names.add(searchType.name);
  }
  assertResolvableLabelSources(types);
  // The one blessed cast: only this validated constructor mints the brand.
  return new Map(
    types.map((searchType) => [searchType.type, searchType]),
  ) as unknown as SearchSchema<Types>;
}

/**
 * The text field a label source serves labels from – the ‘label’ convention
 * in one place: an `output` (something to reconstruct a label from),
 * `searchable` (something to type ahead against) text field called `label`.
 * Returns `undefined` when the type declares no such field; a schema built by
 * {@link searchSchema} guarantees it for every type named as a
 * {@link ReferenceField.labelSource}.
 */
export function labelFieldOf(searchType: SearchType): TextField | undefined {
  const field = fieldNamed(searchType, 'label');
  return field !== undefined &&
    field.kind === 'text' &&
    field.output === true &&
    field.searchable !== undefined
    ? field
    : undefined;
}

/**
 * Every {@link ReferenceField.labelSource} must name a declared type that can
 * actually serve labels ({@link labelFieldOf}). Checked schema-wide, because
 * a single declaration cannot see its siblings.
 */
function assertResolvableLabelSources(types: readonly SearchType[]): void {
  const byName = new Map(
    types.map((searchType) => [searchType.name, searchType]),
  );
  for (const searchType of types) {
    for (const field of searchType.fields) {
      if (field.kind !== 'reference' || field.labelSource === undefined) {
        continue;
      }
      const source = byName.get(field.labelSource);
      if (source === undefined) {
        throw new Error(
          `Reference “${searchType.name}.${field.name}” names unknown label source “${field.labelSource}”; declare a SearchType with that name.`,
        );
      }
      if (labelFieldOf(source) === undefined) {
        throw new Error(
          `Reference “${searchType.name}.${field.name}” uses label source “${field.labelSource}”, which must declare an output, searchable text field “label”.`,
        );
      }
    }
  }
}

/**
 * One structural problem {@link validateSearchType} found: a field declares a
 * capability or property its `kind` cannot honour, or the declaration is
 * internally inconsistent. Each reason names the field-level rule it violates;
 * the rules mirror the per-kind semantics table in the README.
 */
export interface SearchTypeIssue {
  readonly field: string;
  readonly reason:
    | 'duplicate-field-name'
    | 'missing-ref'
    | 'ref-not-allowed'
    | 'text-requires-locales'
    | 'locales-not-allowed'
    | 'facet-ranges-not-allowed'
    | 'searchable-not-allowed'
    | 'transform-not-allowed'
    | 'derive-with-path'
    | 'text-not-filterable'
    | 'text-not-facetable';
}

/** Kinds that can feed full-text search (project a folded search field). */
const SEARCHABLE_KINDS: readonly FieldKind[] = ['text', 'keyword', 'reference'];

/** Kinds whose projection applies the {@link KeywordField.transform}. */
const TRANSFORMABLE_KINDS: readonly FieldKind[] = ['keyword', 'reference'];

/**
 * Structurally validate one {@link SearchType} declaration — the
 * declaration-time counterpart of `validateQuery`. Rules:
 *
 * - field names are unique (a duplicate would silently shadow in every
 *   consumer, each picking a different winner);
 * - a `reference` field that is `output` declares `ref` (the API surfaces
 *   need the reference type name); `ref` on any other kind is meaningless;
 * - a `text` field declares at least one locale (`und` = untagged; projection and
 *   result reconstruction have no representation for unlocalized text — use
 *   `keyword` for untagged strings); `locales` on any other kind is
 *   meaningless;
 * - a kind without a `where` operator (`text` — it feeds the free-text query)
 *   is neither `filterable` nor `facetable`;
 * - `facetRanges` only on the `range`-operator kinds (`integer`/`number`/`date`);
 * - `searchable` only on `text`/`keyword`/`reference` (projection emits no
 *   folded search field for the other kinds);
 * - `transform` only on `keyword`/`reference` (the only kinds whose
 *   projection applies it);
 * - `derive` and `path` are mutually exclusive (a field is projected or
 *   computed, never both).
 *
 * Pure and total: returns every issue rather than throwing;
 * {@link assertValidSearchType} is the throwing entry point.
 */
export function validateSearchType(
  searchType: SearchType,
): readonly SearchTypeIssue[] {
  const issues: SearchTypeIssue[] = [];
  const seen = new Set<string>();
  for (const declared of searchType.fields) {
    // Validation guards declarations built OUTSIDE TypeScript (a SHACL
    // generator, plain JS), so it inspects the uniform flat shape rather
    // than trusting the discriminated union.
    const field = declared as FlatField;
    const issue = (reason: SearchTypeIssue['reason']) =>
      issues.push({ field: field.name, reason });
    if (seen.has(field.name)) {
      issue('duplicate-field-name');
    }
    seen.add(field.name);
    if (field.kind === 'reference') {
      if (field.output === true && field.ref === undefined) {
        issue('missing-ref');
      }
    } else if (field.ref !== undefined) {
      issue('ref-not-allowed');
    }
    if (field.kind === 'text') {
      if ((field.locales ?? []).length === 0) {
        issue('text-requires-locales');
      }
    } else if (field.locales !== undefined) {
      issue('locales-not-allowed');
    }
    // Derived from the kind→operator table, so validation, the surfaces and
    // the compilers cannot disagree: a kind without a `where` operator (text)
    // is neither filterable nor facetable, and only `range` kinds bin.
    if (
      field.filterable === true &&
      filterOperatorFor(field.kind) === undefined
    ) {
      issue('text-not-filterable');
    }
    if (
      field.facetable === true &&
      filterOperatorFor(field.kind) === undefined
    ) {
      issue('text-not-facetable');
    }
    if (
      field.facetRanges !== undefined &&
      filterOperatorFor(field.kind) !== 'range'
    ) {
      issue('facet-ranges-not-allowed');
    }
    if (
      field.searchable !== undefined &&
      !SEARCHABLE_KINDS.includes(field.kind)
    ) {
      issue('searchable-not-allowed');
    }
    if (
      field.transform !== undefined &&
      !TRANSFORMABLE_KINDS.includes(field.kind)
    ) {
      issue('transform-not-allowed');
    }
    if (field.derive !== undefined && field.path !== undefined) {
      issue('derive-with-path');
    }
  }
  return issues;
}

/** The union flattened to every possible member — the uniform shape runtime
 *  validation and generic iteration read; never a declaration type. */
interface FlatField extends SearchFieldBase, Searchable, RangeFacetable {
  readonly kind: FieldKind;
  readonly locales?: readonly string[];
  readonly ref?: ReferenceField['ref'];
  readonly transform?: (value: string) => string;
}

/**
 * Throw when `searchType` is not a member of `schema` — the port membership
 * guard every engine adapter applies before searching, so a query can never
 * meet an index the deployment did not declare. Identity-based: the exact
 * declaration object must be in the schema, not a lookalike.
 */
export function assertTypeInSchema(
  schema: SearchSchema,
  searchType: SearchType,
): void {
  if (schema.get(searchType.type) !== searchType) {
    throw new Error(
      `Search type “${searchType.name}” is not in this engine’s schema; it serves ${[
        ...schema.values(),
      ]
        .map((declared) => `“${declared.name}”`)
        .join(', ')}.`,
    );
  }
}

/** Throw on a structurally invalid {@link SearchType} ({@link validateSearchType}),
 *  naming every issue. Called by {@link searchSchema} for each declaration. */
export function assertValidSearchType(searchType: SearchType): void {
  const issues = validateSearchType(searchType);
  if (issues.length > 0) {
    const detail = issues
      .map((issue) => `“${issue.field}” (${issue.reason})`)
      .join(', ');
    throw new Error(`Invalid search type “${searchType.name}”: ${detail}.`);
  }
}

/**
 * The physical engine fields one {@link SearchField} fans out into, grouped by
 * the role each plays. The single source of truth for the naming convention, so
 * the projection (writes them), the collection schema (declares them) and the
 * query compiler (reads them) cannot disagree.
 */
export interface PhysicalFields {
  /** Per-locale output labels `${name}_${locale}` (localized text, `output`). */
  readonly display: readonly string[];
  /** Folded match fields: `${name}_search_${locale}` per locale (localized) or a
   *  single `${name}_search` (non-localized), when `searchable`. */
  readonly search: readonly string[];
  /** Per-locale folded sort keys `${name}_sort_${locale}` (localized text,
   *  `sortable`); a non-localized field sorts on its own `name` field. */
  readonly sort: readonly string[];
}

/**
 * Full-text searchable fields, highest `query_by` weight first — the order the
 * engine adapter weights `query_by` in. A field is searchable iff it carries a
 * `searchable` weight.
 */
export function searchableFields(
  searchType: SearchType,
): readonly (SearchField & {
  readonly searchable: { readonly weight: number };
})[] {
  return searchType.fields
    .filter(
      (field): field is SearchField & { searchable: { weight: number } } =>
        field.searchable !== undefined,
    )
    .sort((left, right) => right.searchable.weight - left.searchable.weight);
}

/** Fields returned as facet buckets, in declaration order. */
export function facetableFields(
  searchType: SearchType,
): readonly SearchField[] {
  return searchType.fields.filter((field) => field.facetable === true);
}

/** Fields usable in `where`, in declaration order. */
export function filterableFields(
  searchType: SearchType,
): readonly SearchField[] {
  return searchType.fields.filter((field) => field.filterable === true);
}

/** Fields publicly selectable in `orderBy`, in declaration order. */
export function sortableFields(searchType: SearchType): readonly SearchField[] {
  return searchType.fields.filter((field) => field.sortable === true);
}

/** Fields that appear in the API output type, in declaration order. */
export function outputFields(searchType: SearchType): readonly SearchField[] {
  return searchType.fields.filter((field) => field.output === true);
}

/** Fields of kind `reference` (IRI-valued, label-resolved), in declaration order. */
export function referenceFields(
  searchType: SearchType,
): readonly ReferenceField[] {
  return searchType.fields.filter((field) => field.kind === 'reference');
}

/** Look up a field by its logical name. */
export function fieldNamed(
  searchType: SearchType,
  name: string,
): SearchField | undefined {
  return searchType.fields.find((field) => field.name === name);
}

/**
 * Whether a facet on this field returns fixed range bins (a histogram) rather
 * than one bucket per distinct value: it declares non-empty
 * {@link RangeFacetable.facetRanges}. One predicate for the surface’s facet
 * type, the adapter’s facet clause and the bucket reconstruction, so they
 * cannot disagree.
 */
export function isRangeFacet(
  field: SearchField,
): field is NumericField & { readonly facetRanges: readonly FacetRange[] } {
  return field.facetRanges !== undefined && field.facetRanges.length > 0;
}

/**
 * The engine storage codec for `date` fields: stored as Unix seconds (a
 * sortable, range-filterable int64), ISO 8601 at the API edges. One pair for
 * the projection (writes), the query compiler (filter bounds) and the surface
 * (output), so the three cannot disagree. Returns `undefined` for an
 * unparseable value.
 */
export function isoToUnixSeconds(iso: string): number | undefined {
  const millis = new Date(iso).getTime();
  return Number.isNaN(millis) ? undefined : Math.trunc(millis / 1000);
}

/** The inverse of {@link isoToUnixSeconds}: stored Unix seconds → ISO 8601. */
export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Derive the physical engine field names a declaration produces. */
export function physicalFields(field: SearchField): PhysicalFields {
  if (field.kind === 'text') {
    const locales = field.locales;
    return {
      display: field.output
        ? locales.map((locale) => `${field.name}_${locale}`)
        : [],
      search: field.searchable
        ? locales.map((locale) => `${field.name}_search_${locale}`)
        : [],
      sort: field.sortable
        ? locales.map((locale) => `${field.name}_sort_${locale}`)
        : [],
    };
  }
  return {
    display: [],
    search: field.searchable !== undefined ? [`${field.name}_search`] : [],
    sort: [],
  };
}
