import type { SearchDocument } from './project.js';

/**
 * The engine-neutral kind of a queryable field. It drives every downstream
 * behavior: which physical fields the projection emits, the engine
 * collection-definition type, the `where`/facet/sort semantics, and the GraphQL
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
 * table), or `undefined` for `text` – which feeds the free-text `query` rather
 * than `where`. The ONE source for the surface’s `where` input type, the
 * adapter’s filter compiler and declaration validation, so they cannot drift.
 */
export function filterOperatorFor(kind: FieldKind): FilterOperator | undefined {
  return OPERATOR_BY_KIND[kind];
}

/**
 * One queryable field – the single declarative source that drives all four
 * consumers (projection, engine collection definition, query semantics, and the
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
 * `path` is a **derived field** – computed from the document projected so far
 * rather than read from the graph – yet it still carries full query/schema/output
 * behavior (e.g. `status`, the compatibility booleans). A field declaring **no**
 * role at all is an {@link isInternalField **internal field**}: projected so a
 * later derive can read it, then pruned before the writer.
 *
 * The physical field names a declaration fans out to (per-locale search/sort
 * keys) follow one convention, owned by
 * {@link physicalFields} so projection, collection-definition and query compiler
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
   * Compute this field’s value instead of projecting it from a `path` – a
   * status token, a compatibility boolean, a count over an earlier field.
   * Mutually exclusive with `path`. Runs in declaration order during
   * projection, receiving **only** the document as populated so far – never the
   * graph – so a derived field reads fields declared before it (e.g. a
   * `statusRank` reading the derived `status`, or a count reading an
   * {@link isInternalField internal} field). Return `undefined` to leave the
   * field absent. The field still carries full query/schema/output behaviour
   * like any other. Reading only the document is what keeps `path` the complete
   * statement of what the projection reads from the graph.
   */
  readonly derive?: (document: SearchDocument) => unknown;
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
 * `locales: ['und']` and mixed data `['nl', 'und']` – one mechanism, and
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
     *  `Organization`) – names the reference’s type in the API surfaces, the
     *  way {@link SearchType.name} names a root type; fields sharing it share
     *  one emitted type. A name, not a key: it need not correspond to any
     *  indexed root type (and until cross-collection references exist, it must
     *  not collide with one). */
    readonly typeName: string;
    /** How much of the referenced entity the reference carries. `labelOnly`
     *  (id + display label, resolved from a label source) and `inline` (the
     *  referent’s own projected fields, carried inline through a declared
     *  {@link ReferenceType} – see {@link isInlineReference}) are implemented;
     *  `idOnly` is a forward declaration, so that declarations (and the SHACL
     *  `search:nestedStrategy` mapping) keep their shape when it lands. */
    readonly strategy: 'labelOnly' | 'idOnly' | 'inline';
  };
}

/**
 * Range-facet bins for a numeric (`integer`/`number`/`date`) facetable field.
 * When set, the field facets into these fixed half-open `[min, max)` ranges (a
 * histogram) rather than one bucket per distinct value – the per-bucket counts
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
 * (ISO 8601 at the edges, Unix seconds in the index) – identical capabilities,
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

/** The declaration members every {@link SearchType} shares. */
export interface SearchTypeBase {
  /** Logical API name (PascalCase, e.g. `Dataset`) – names the type in the API
   *  surfaces (GraphQL type names, a REST path), the way each field’s
   *  {@link SearchField.name} names that field. Deliberately declared rather
   *  than derived from the `class` IRI, so re-modelling the vocabulary cannot
   *  silently rename the public contract. */
  readonly name: string;
  readonly fields: readonly SearchField[];
}

/**
 * A **Root Type**: a {@link SearchType} that is indexed. It declares a `class`,
 * roots are selected for it, a Writer owns a collection for it, and the
 * {@link SearchSchema} is keyed by it. A SHACL generator can emit one per
 * NodeShape (`name`←`sh:name`/local name, `class`←`sh:targetClass`,
 * `fields`←its property shapes), but that is a source, not a requirement.
 */
export interface RootType extends SearchTypeBase {
  /** The RDF class IRI its documents are instances of (`sh:targetClass`); the
   *  key a {@link SearchSchema} maps this type under. Its presence is what makes
   *  a type a Root Type – and so what gives it a collection. */
  readonly class: string;
}

/**
 * A **Reference Type**: a {@link SearchType} reached only through an
 * {@link ReferenceField.ref inline reference}. It declares **no `class`** –
 * never selected, never framed by type, never indexed; its identity is its
 * `name`, and its type comes from the edge that points at it, not from the node.
 * The absence is load-bearing, not stylistic: a `class` would put it in the
 * {@link SearchSchema} map and silently earn it a collection nobody asked for.
 * The shape an inline reference carries – see
 * [ADR 11](../../docs/decisions/0011-decouple-rdf-depth-from-the-api-surface.md).
 */
export interface ReferenceType extends SearchTypeBase {
  /** A Reference Type declares no class; declaring one makes it a
   *  {@link RootType}. Typed as `never` so the two shapes discriminate the way
   *  {@link SearchField} discriminates by `kind`: an indexed Reference Type
   *  fails to compile, not at run time. */
  readonly class?: never;
}

/**
 * One type’s complete search declaration: its logical API `name`, the queryable
 * `fields` (including {@link SearchField.derive derived} ones), and – for a
 * {@link RootType} – the RDF `class` its documents are instances of. Either a
 * Root Type or a {@link ReferenceType}; the absence of a `class` tells them
 * apart.
 */
export type SearchType = RootType | ReferenceType;

/** The Root Types among a declared tuple – the ones a {@link SearchSchema}
 *  keys and a Writer opens a collection for. Reference Types are excluded, so
 *  no consumer that iterates `schema.values()` ever meets one. */
export type RootTypeOf<Types extends readonly SearchType[]> = Extract<
  Types[number],
  { readonly class: string }
>;

/**
 * Declare a {@link SearchType}, capturing it as a literal: the `const` type
 * parameter preserves the field names and capability flags that the type-level
 * helpers (`FacetFieldsOf`, `OutputFieldsOf`) read off the type –
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
 * The complete search declaration of a deployment: every {@link RootType},
 * keyed by its `class` IRI, plus the {@link ReferenceType}s an inline reference
 * resolves against. Build one with {@link searchSchema}, which captures the
 * declared types as a literal tuple (`Types`), so schema-bound consumers (the
 * engine port) can type their per-type behaviour off it. A plain
 * `: SearchSchema` annotation widens gracefully to `SearchType`.
 *
 * `values()` yields only Root Types – Reference Types are held apart in a name
 * index ({@link referenceTypeNamed}), so a Writer that opens one collection per
 * `values()` entry can never open one for a Reference Type.
 */
/** Brand for {@link SearchSchema}: type-only, no runtime existence. Makes the
 *  schema NOMINAL – a hand-built `Map` is not assignable, so `searchSchema()`
 *  (which validates) is the only way to obtain one and downstream consumers
 *  need no defensive re-validation. */
export declare const validSearchSchema: unique symbol;

export interface SearchSchema<
  Types extends readonly SearchType[] = readonly SearchType[],
> extends ReadonlyMap<string, RootTypeOf<Types>> {
  readonly [validSearchSchema]: true;
}

/**
 * The Reference Type name index each {@link SearchSchema} carries alongside its
 * class-keyed root map, kept out of the map itself so no consumer iterating
 * `values()` ever meets a Reference Type. Held in a `WeakMap` rather than a
 * property, so the schema stays a plain branded `Map` and the index is read only
 * through {@link referenceTypeNamed}.
 */
const referenceTypesBySchema = new WeakMap<
  SearchSchema,
  ReadonlyMap<string, ReferenceType>
>();

/** Whether a declared type is a {@link RootType} (declares a `class`) rather
 *  than a {@link ReferenceType}. */
function isRootType(searchType: SearchType): searchType is RootType {
  return searchType.class !== undefined;
}

/**
 * Build a {@link SearchSchema} from type declarations. Its arguments are
 * **partitioned**: {@link RootType}s (those declaring a `class`) key the map –
 * so a Writer opens exactly one collection per Root Type – and
 * {@link ReferenceType}s (no `class`) go into a name index that an inline
 * `ref.typeName` resolves against ({@link referenceTypeNamed}).
 *
 * Every declaration is validated ({@link assertValidSearchType}) – the
 * declaration-time counterpart of the port’s `assertValidQuery` – and the
 * schema-wide invariants are enforced: no two Root Types may share a `class` IRI
 * (they would silently overwrite each other in the map) and no two types may
 * share a `name` (names key the API surfaces, across Root and Reference Types
 * alike). Every inline reference must resolve to a declared Reference Type, and
 * the inline reference graph must be acyclic – the only way its depth could be
 * unbounded. Throws on the first invalid declaration, so a bad schema fails at
 * startup, not per document at index time or per query.
 */
export function searchSchema<const Types extends readonly SearchType[]>(
  ...types: Types
): SearchSchema<Types> {
  const typeIris = new Set<string>();
  const names = new Set<string>();
  for (const searchType of types) {
    assertValidSearchType(searchType);
    if (isRootType(searchType)) {
      if (typeIris.has(searchType.class)) {
        throw new Error(
          `Duplicate search type IRI “${searchType.class}”; each Root Type must declare a distinct class.`,
        );
      }
      typeIris.add(searchType.class);
    }
    if (names.has(searchType.name)) {
      throw new Error(
        `Duplicate search type name “${searchType.name}”; each SearchType must declare a distinct name.`,
      );
    }
    names.add(searchType.name);
  }
  const referenceTypes = new Map<string, ReferenceType>(
    types
      .filter((searchType) => !isRootType(searchType))
      .map((searchType) => [searchType.name, searchType]),
  );
  assertResolvableInlineReferences(types, referenceTypes);
  assertResolvableLabelSources(types);
  // The one blessed cast: only this validated constructor mints the brand.
  const schema = new Map(
    types
      .filter(isRootType)
      .map((searchType) => [searchType.class, searchType]),
  ) as unknown as SearchSchema<Types>;
  referenceTypesBySchema.set(schema, referenceTypes);
  return schema;
}

/**
 * The {@link ReferenceType} an inline `ref.typeName` names, or `undefined` when
 * the schema declares none by that name. The read side of the name index
 * {@link searchSchema} partitions the Reference Types into – the projection
 * resolves an inline reference’s referent shape through it.
 */
export function referenceTypeNamed(
  schema: SearchSchema,
  name: string,
): ReferenceType | undefined {
  return referenceTypesBySchema.get(schema)?.get(name);
}

/** Whether a field is an inline reference – a {@link ReferenceField} whose
 *  `ref` carries its referent’s projected fields ({@link ReferenceType}). */
export function isInlineReference(
  field: SearchField,
): field is ReferenceField & {
  readonly ref: { readonly typeName: string; readonly strategy: 'inline' };
} {
  return field.kind === 'reference' && field.ref?.strategy === 'inline';
}

/**
 * The framing depth a Root Type needs: how many hops the inline reference graph
 * reaches from it (`Dataset → Subset → Measurement` is two), floored at one so
 * the existing single-hop embed for non-inline references is preserved. Depth is
 * a property of the declaration, bounded because {@link searchSchema} rejects
 * inline cycles – never a knob or a constant. Framing bounded per batch keeps
 * memory bounded by the unit of work (ADR 12), not the graph.
 */
export function inlineFramingDepth(
  schema: SearchSchema,
  searchType: SearchType,
): number {
  return Math.max(1, inlineChainLength(schema, searchType));
}

/** The longest inline reference chain reachable from `searchType`. The recursion
 *  terminates because {@link searchSchema} rejects inline cycles; a reference the
 *  given schema does not declare (e.g. a type framed against another schema)
 *  contributes no depth. */
function inlineChainLength(
  schema: SearchSchema,
  searchType: SearchType,
): number {
  let longest = 0;
  for (const field of searchType.fields) {
    if (!isInlineReference(field)) {
      continue;
    }
    const referent = referenceTypeNamed(schema, field.ref.typeName);
    if (referent === undefined) {
      continue;
    }
    longest = Math.max(longest, 1 + inlineChainLength(schema, referent));
  }
  return longest;
}

/**
 * Every inline `ref.typeName` must resolve to a **declared Reference Type**, and
 * the inline reference graph must be acyclic. Unlike a `labelOnly` reference –
 * whose `typeName` is just an API name – an inline reference carries its
 * referent’s fields, so it must know their shape, and an inline cycle is the one
 * way framing depth could be unbounded. Checked schema-wide, because a single
 * declaration cannot see its siblings.
 */
function assertResolvableInlineReferences(
  types: readonly SearchType[],
  referenceTypes: ReadonlyMap<string, ReferenceType>,
): void {
  for (const searchType of types) {
    for (const field of searchType.fields) {
      if (!isInlineReference(field)) {
        continue;
      }
      if (!referenceTypes.has(field.ref.typeName)) {
        throw new Error(
          `Inline reference “${searchType.name}.${field.name}” names “${field.ref.typeName}”, which is not a declared reference type; declare a reference type (a SearchType with no class) with that name.`,
        );
      }
    }
  }
  for (const referenceType of referenceTypes.values()) {
    assertNoInlineCycle(referenceType, referenceTypes, new Set());
  }
}

function assertNoInlineCycle(
  referenceType: ReferenceType,
  referenceTypes: ReadonlyMap<string, ReferenceType>,
  onPath: ReadonlySet<string>,
): void {
  if (onPath.has(referenceType.name)) {
    throw new Error(
      `Inline reference cycle through reference type “${referenceType.name}”; an inline reference graph must be acyclic, so its framing depth stays bounded.`,
    );
  }
  const extended = new Set([...onPath, referenceType.name]);
  for (const field of referenceType.fields) {
    if (!isInlineReference(field)) {
      continue;
    }
    // Resolvability is validated before any cycle check, so every inline
    // `typeName` here names a declared reference type.
    const referent = referenceTypes.get(field.ref.typeName) as ReferenceType;
    assertNoInlineCycle(referent, referenceTypes, extended);
  }
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
      const labelSource = (field as { readonly labelSource?: string })
        .labelSource;
      if (labelSource === undefined) {
        continue;
      }
      if (field.kind !== 'reference') {
        throw new Error(
          `Field “${searchType.name}.${field.name}” declares a label source but is a ${field.kind} field; only reference fields resolve labels from a source.`,
        );
      }
      const source = byName.get(labelSource);
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
    | 'invalid-field-name'
    | 'unknown-kind'
    | 'invalid-locale'
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
 * A safe logical field name: a GraphQL-style identifier. The name is
 * interpolated raw into physical field names AND, for a display text field,
 * into the RE2 collection pattern `${name}_[^_]+` ({@link displayFieldPattern}),
 * so it must contain no regex metacharacter – this charset (letters, digits,
 * `_`) guarantees that, and is exactly what a GraphQL field name allows anyway.
 */
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A safe declared locale: BCP-47-shaped (letters/digits, `-` between subtags),
 * never containing `_`. The `_` is the reserved separator between a text field’s
 * name and its language subtag, so a locale carrying one would collide with the
 * `${name}_search_${locale}` / display naming; incoming data tags are normalised
 * to this shape at projection time.
 */
const LOCALE_PATTERN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;

/**
 * Structurally validate one {@link SearchType} declaration – the
 * declaration-time counterpart of `validateQuery`. Rules:
 *
 * - field names are unique (a duplicate would silently shadow in every
 *   consumer, each picking a different winner) and a metacharacter-free
 *   identifier (the name is interpolated into physical field names and the
 *   display RE2 pattern);
 * - a `text` field’s declared locales are BCP-47-shaped (no `_`, which is the
 *   reserved name↔locale separator);
 * - a `reference` field that is `output` declares `ref` (the API surfaces
 *   need the reference type name); `ref` on any other kind is meaningless;
 * - a `text` field declares at least one locale (`und` = untagged; projection and
 *   result reconstruction have no representation for unlocalized text – use
 *   `keyword` for untagged strings); `locales` on any other kind is
 *   meaningless;
 * - a kind without a `where` operator (`text` – it feeds the free-text query)
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
    // The name is interpolated into physical field names and the display RE2
    // pattern, so it must be a metacharacter-free identifier.
    if (!FIELD_NAME_PATTERN.test(field.name)) {
      issue('invalid-field-name');
    }
    // Every kind-dependent rule below would silently pass for a kind outside
    // the union, so a typo’d kind in a plain-JS declaration must fail here.
    if (!Object.hasOwn(OPERATOR_BY_KIND, field.kind)) {
      issue('unknown-kind');
      continue;
    }
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
      // A locale carrying `_` would collide with the name/locale separator in
      // the physical and display field naming, so declared locales are
      // BCP-47-shaped (data tags are normalised to match at projection time).
      if (
        (field.locales ?? []).some((locale) => !LOCALE_PATTERN.test(locale))
      ) {
        issue('invalid-locale');
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

/** The union flattened to every possible member – the uniform shape runtime
 *  validation and generic iteration read; never a declaration type. */
interface FlatField extends SearchFieldBase, Searchable, RangeFacetable {
  readonly kind: FieldKind;
  readonly locales?: readonly string[];
  readonly ref?: ReferenceField['ref'];
  readonly transform?: (value: string) => string;
}

/**
 * Throw when `searchType` is not a member of `schema` – the port membership
 * guard every engine adapter applies before searching, so a query can never
 * meet an index the deployment did not declare. Identity-based: the exact
 * declaration object must be in the schema, not a lookalike.
 */
export function assertTypeInSchema(
  schema: SearchSchema,
  searchType: RootType,
): void {
  if (schema.get(searchType.class) !== searchType) {
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
 * the projection (writes them), the collection definition (declares them) and the
 * query compiler (reads them) cannot disagree.
 */
export interface PhysicalFields {
  /** Folded match fields: `${name}_search_${locale}` per locale (localized) or a
   *  single `${name}_search` (non-localized), when `searchable`. */
  readonly search: readonly string[];
  /** Per-locale folded sort keys `${name}_sort_${locale}` (localized text,
   *  `sortable`); a non-localized field sorts on its own `name` field. */
  readonly sort: readonly string[];
}

/**
 * The display fields of a localized `text` field are pattern-based, not
 * enumerated per declared locale: projection stores `${name}_${lang}` for
 * **every** language present in the data (not only those in `locales`), so a
 * label in an undeclared language or an untagged one still renders rather than
 * collapsing to a bare IRI. `locales` governs only the indexed search/sort
 * fanout ({@link PhysicalFields}); display costs nothing per language (stored
 * `index: false`), so it preserves them all. A deployment that wants fewer
 * display languages restricts them upstream (e.g. in its CONSTRUCT).
 *
 * A language subtag never contains `_`, but the `search_`/`sort_` infixes do,
 * so `${name}_${lang}` with `lang` matching `[^_]+` is unambiguously a display
 * field: `label_nl`, `label_fr`, `label_zh-hant`, `label_und` are display;
 * `label_search_nl` and `label_sort_nl` are not. This trio – the name a value
 * is written under ({@link displayFieldName}), the collection pattern that
 * accepts them all ({@link displayFieldPattern}), and the reader that recovers a
 * key’s language ({@link displayLangOf}) – is the single home of that
 * convention, so projection, collection-definition and result reconstruction
 * cannot disagree.
 */
export function displayFieldName(field: TextField, lang: string): string {
  return `${field.name}_${lang}`;
}

/**
 * The RE2 pattern a collection declares to store every present language’s
 * display value un-indexed, or `undefined` when the field is not `output` (no
 * display at all). Matches `${name}_${lang}` for any underscore-free `lang`, so
 * it never collides with the field’s `${name}_search_${locale}` /
 * `${name}_sort_${locale}` companions.
 */
export function displayFieldPattern(field: TextField): string | undefined {
  return field.output ? `${field.name}_[^_]+` : undefined;
}

/**
 * The language a stored document key carries for `field`’s display, or
 * `undefined` when the key is not one of `field`’s display fields – the inverse
 * of {@link displayFieldName}. A key qualifies when it is `${name}_` followed by
 * an underscore-free remainder, so the `${name}_search_…`/`${name}_sort_…`
 * companions (and unrelated fields) are rejected.
 */
export function displayLangOf(
  field: TextField,
  key: string,
): string | undefined {
  const prefix = `${field.name}_`;
  if (!key.startsWith(prefix)) {
    return undefined;
  }
  const lang = key.slice(prefix.length);
  return lang.length > 0 && !lang.includes('_') ? lang : undefined;
}

/**
 * Full-text searchable fields, highest `query_by` weight first – the order the
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

/**
 * Whether a field declares **no** role – none of `output`, `searchable`,
 * `filterable`, `facetable`, `sortable`. Such a field is an **internal field**:
 * the projection populates it (so a later {@link SearchFieldBase.derive} can
 * read it), then prunes it before the document reaches a writer, and the engine
 * collection definition omits it entirely – not stored, not indexed, no RAM.
 * Absence of a role declares that intent; there is no separate marker flag.
 *
 * The single predicate the projection and the collection definition share, so
 * they cannot disagree on what is internal. See the Search context’s load-bearing
 * line: *a field without a Role is an Internal Field.*
 */
export function isInternalField(field: SearchField): boolean {
  return (
    field.output !== true &&
    field.searchable === undefined &&
    field.filterable !== true &&
    field.facetable !== true &&
    field.sortable !== true
  );
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
 * The **IR Alias** predicate for a field: `urn:lde:‹SearchType.name›/‹field.name›`.
 * The extraction CONSTRUCT emits a field’s value under this minted predicate, and
 * the {@link projectDocument projection} reads it back under the same key – the
 * two sides agree by calling this one function rather than by a hand-written
 * convention that can drift (exactly the argument {@link physicalFields}’ JSDoc
 * makes for the physical fanout).
 *
 * A property path cannot be a CONSTRUCT template verb, so flattening a multi-hop
 * value onto its subject must mint a predicate for it; that predicate is a
 * mechanical function of the field name, never authored by hand and never a
 * public vocabulary. Field names are unique per type and restricted to
 * `[A-Za-z_][A-Za-z0-9_]*` ({@link validateSearchType}), so the alias needs no
 * escaping; it is qualified by the **type** name because one subject can be a
 * root of two types (`frame-by-type`), which must not collide on a shared field
 * name.
 */
export function irAlias(searchType: SearchType, field: SearchField): string {
  return `urn:lde:${searchType.name}/${field.name}`;
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

/**
 * Derive the **indexed** physical engine field names a declaration produces:
 * the per-locale `search`/`sort` fanout. A localized `text` field’s display
 * fields are pattern-based and not enumerated here – see {@link displayFieldName}
 * and its siblings.
 */
export function physicalFields(field: SearchField): PhysicalFields {
  if (field.kind === 'text') {
    const locales = field.locales;
    return {
      search: field.searchable
        ? locales.map((locale) => `${field.name}_search_${locale}`)
        : [],
      sort: field.sortable
        ? locales.map((locale) => `${field.name}_sort_${locale}`)
        : [],
    };
  }
  return {
    search: field.searchable !== undefined ? [`${field.name}_search`] : [],
    sort: [],
  };
}
