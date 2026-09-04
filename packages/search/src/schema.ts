import type { ProjectedNode, ProjectionContext } from './project.js';
import { joinGraph } from './join-graph.js';

/**
 * The engine-neutral kind of a queryable field. It drives every downstream
 * behavior: which physical fields the projection emits, the engine
 * collection-definition type, the `where`/facet/sort semantics, and the GraphQL
 * output/input type. The Typesense-vocabulary types (`string`, `int32`, …) are
 * *derived* from this by the engine adapter, never declared here.
 */
export type FieldKind =
  'text' | 'keyword' | 'integer' | 'number' | 'boolean' | 'date' | 'reference';

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
 * behavior (e.g. `status`, the compatibility booleans). A `keyword`/`reference`
 * field may instead declare {@link KeywordField.from `from`}, populating it from
 * a {@link ProjectionValue} – something the run knows and the graph does not.
 * `path`, `derive` and `from` are the three mutually exclusive value sources. A
 * field declaring **no** role at all is an {@link isInternalField **internal
 * field**}: projected so a later derive can read it, then pruned before the
 * writer.
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
  TextField | KeywordField | ReferenceField | NumericField | BooleanField;

/** The declaration members every {@link SearchField} kind shares. */
export interface SearchFieldBase {
  /** Logical API name; the physical fanout derives from it. Declare camelCase
   *  where it surfaces in GraphQL. */
  readonly name: string;
  /**
   * What this field means, for whoever queries it. Carried to every API surface
   * with somewhere to put it – GraphQL renders it as the field’s description, so
   * it reaches a consumer in the playground, in introspection and in an editor,
   * rather than in documentation they would have to know to look for.
   *
   * Worth declaring wherever the name is not the whole story: two fields over
   * one property that differ in what they can see, a value that is not what its
   * name suggests, a facet that covers only part of a corpus. Prose, not a type
   * – the shape is already in the declaration.
   */
  readonly description?: string;
  /** Framed-IR predicate IRI to project from. Omit for a field populated by
   *  {@link SearchFieldBase.derive} (or outside the projection entirely). */
  readonly path?: string;
  /** Multi-valued: the field stores a list. Single-valued (the default) stores
   *  the FIRST value the graph carries, whatever their number – for every kind
   *  alike – so one declaration cannot mean a list to the projection and a
   *  scalar to the collection definition and the API. */
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
   * statement of what the projection reads from the graph. The node it receives
   * is the search document for a root type, and the referent’s own
   * projected fields for a Reference Type – which carry an `id` only when the
   * referent is a named node, never for a blank-node one.
   *
   * The second argument is the {@link ProjectionContext} – the run’s
   * projection-time values, which are about the *indexing*, not the graph (the
   * dataset being indexed). It is what lets a derive relate a projected value
   * to its provenance: dropping a polymorphic `isPartOf` value that merely
   * points back at the containing dataset, say.
   *
   * The returned value goes through the same storage conversion a read one
   * does, so a derive states its value in the field’s own terms: a `date`
   * derive may return an ISO 8601 string ({@link isoToUnixSeconds} is applied
   * for it) or the stored Unix seconds directly, and a `reference` derive is
   * held to absolute IRIs.
   */
  readonly derive?: (
    document: ProjectedNode,
    context: ProjectionContext,
  ) => unknown;
}

/**
 * A projection-time value a field can be declared **over** – something the run
 * knows that the graph does not say. `dataset` is the IRI of the dataset being
 * indexed: every indexed document comes from exactly one, and for the many
 * entity types that carry no containing-collection property (`Person`,
 * `Organization`, `Place`, …) it is the only available answer to *which dataset
 * does this come from*.
 *
 * A field declaring one is populated by the projection, like a `path`-bearing
 * or `derive`d field, and carries the full range of behaviour: `output`,
 * `filterable`, `facetable`, and – for a `reference` – a
 * {@link ReferenceField.labelSource `labelSource`} that resolves the IRI to a
 * readable label at query time.
 */
export type ProjectionValue = 'dataset';

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
  /** Populate from a {@link ProjectionValue} instead of the graph. Mutually
   *  exclusive with `path` and `derive`. */
  readonly from?: ProjectionValue;
}

/**
 * Where a reference’s fields come from – the one axis the three shapes sit on:
 *
 * - `idOnly` carries the bare IRI and nothing else. It emits no type, so it
 *   names none; a {@link ReferenceField.labelSource} still labels its facet
 *   buckets.
 * - `lookup` carries fields read from the **target’s own indexed document**,
 *   resolved at query time from that Root Type’s collection. `target` names it
 *   once – the collection to read and the emitted type name alike (GraphQL:
 *   `‹Target›Reference`, since type names must be unique).
 * - `inline` carries fields denormalised from the **parent’s** RDF framing at
 *   index time, shaped by the declared {@link ReferenceType} `typeName` names –
 *   so its typeName can never name a root type. Pointed at a node the graph put
 *   *between* subject and endpoint, the nested node is the **edge**, and
 *   {@link ReferenceStrategy.identity `identity`} names the nested reference
 *   that carries the endpoint.
 */
export type ReferenceStrategy =
  | {
      readonly strategy: 'idOnly';
      /** Optional, unlike the other strategies – including when the field is
       *  `output`: an `idOnly` reference surfaces as its bare IRI, so there is
       *  no object type to name. It names the reference’s *filter* target
       *  instead, so declare it where the referent’s IRIs form a nameable set a
       *  consumer should be able to tell from IRIs at large; omit it for IRIs
       *  that belong to no such set. */
      readonly typeName?: string;
      readonly target?: never;
      readonly identity?: never;
    }
  | {
      readonly strategy: 'lookup';
      readonly target: string;
      /**
       * Also project the target’s **own fields from this document’s frame**, so
       * the reference stores what the referring document states about the
       * referent alongside the id – and the resolved document replaces it at
       * query time rather than being the only source of it.
       *
       * What it buys is one field where there were two. A referent the graph
       * names inline – a literal, a blank node – has no id, so a plain
       * reference stores nothing for it and a deployment needs a second, text
       * field beside this one to show it at all; the two are then parallel
       * arrays that cannot be paired. With `local`, an unidentified referent is
       * an entry like any other, minus its `id`.
       *
       * Stored **unconditionally**, not only where there is no id, because the
       * two failures differ: at index time the question is *is this referent
       * identified*, at query time it is *is that document indexed*. A referent
       * whose document is missing from the target’s collection therefore still
       * carries what this document said about it, instead of degrading to a
       * bare IRI.
       *
       * Opt-in, because it changes what the field stores – a nested object
       * rather than an id – and because framing must reach one step further to
       * read the target’s fields off the referent
       * ({@link inlineFramingDepth}). A schema that declares none pays neither.
       */
      readonly local?: boolean;
      readonly identity?: never;
    }
  | {
      readonly strategy: 'inline';
      readonly typeName: string;
      /**
       * The `name` of a **nested reference field** of this reference type whose
       * ids identify each entry’s endpoint – required to declare `filterable`
       * or `facetable` on the inline reference itself, and meaningless without
       * one ({@link searchSchema} enforces both directions).
       *
       * A nested object is not something an engine can filter or facet, so an
       * inline reference that opts into either fans out an **identity
       * companion**: a flat physical field holding the ids its entries
       * reference ({@link physicalFields}), which the engine filters and facets
       * in the nested object’s place. The same mechanism `${name}_facet`
       * already uses – one logical field, two physical fields, one holding a
       * derived subset of the other.
       *
       * Declared rather than inferred, because a reference type may carry more
       * than one nested reference and only the schema author knows which one
       * identifies the edge. Naming it is also what gives the companion a
       * **target**: the named field’s own `target` is the Root Type whose keys
       * these ids are, which is what a facet policy is inherited through
       * ({@link inheritedFacetKeys}) and what types the filter at the surface.
       *
       * The companion holds ids only, so a facet over it is exact and
       * identity-keyed: an entry whose endpoint the graph named inline – a
       * literal, a blank node – contributes no bucket rather than a bucket
       * keyed on a label, so two endpoints that share a label are never merged.
       */
      readonly identity?: string;
    };

/** An IRI-valued reference to another entity, resolved at the surface. */
export interface ReferenceField extends SearchFieldBase, Searchable {
  readonly kind: 'reference';
  /** Projection-time value transform. */
  readonly transform?: (value: string) => string;
  readonly facetRanges?: never;
  /** Populate from a {@link ProjectionValue} instead of the graph – a
   *  `dataset` reference is how a type declares the dataset it was indexed
   *  from, resolvable to a label like any other reference. Mutually exclusive
   *  with `path` and `derive`. */
  readonly from?: ProjectionValue;
  /**
   * The `name` of the Root Type whose collection labels this reference’s facet
   * buckets. Only an `idOnly` reference declares one: a `lookup` reads its
   * labels from the `target` it already names, and an `inline` reference
   * carries the referent’s own fields. The named type must declare an `output`,
   * `searchable` text field under its {@link SearchTypeBase.labelField} name
   * (`label` by default; validated by {@link searchSchema}), so an engine can
   * both reconstruct the label and search it (typeahead).
   */
  readonly labelSource?: string;
  /**
   * Turn this reference into an **engine-level join**, so a query can filter
   * this type by a condition on the referent – `“every object published by
   * institution X”` in one round-trip instead of two. Valid only where the
   * reference names the type it resolves against – a `lookup`’s `target` or an
   * `idOnly`’s {@link ReferenceField.labelSource} ({@link labelSourceNameOf}) –
   * which already asserts that this field’s values are ids of documents in that
   * type’s collection, exactly the fact a join needs.
   *
   * A capability flag in the vocabulary of `filterable`/`facetable`/`sortable`,
   * and deliberately not derived from `labelSource`: an engine may refuse to
   * index a mutual reference, so auto-deriving would make an existing schema
   * silently lose a field. A `labelSource` added for display therefore costs
   * nothing it does not cost today; only a `joinable` edge pays the
   * component-scoped rebuild coupling.
   *
   * Never on an `inline` reference: that carries its referent as a nested
   * object rather than as an id an engine can point a reference field at.
   *
   * At most ONE joinable field per (type, label source) – see
   * {@link joinGraph}.
   */
  readonly joinable?: boolean;
  /**
   * The referenced entity’s shape and where its fields come from. Required when
   * the field is `output` – the strategy is what decides the output shape, so a
   * surfaced reference must state it; optional for a facet- or filter-only
   * reference.
   *
   * A **discriminated union by `strategy`** ({@link ReferenceStrategy}), because
   * what names the referent differs per strategy and is meaningless for the
   * others: a `lookup` names the Root Type it reads from, an `inline` one names
   * a declared {@link ReferenceType}, and an `idOnly` one carries a bare IRI
   * that may belong to no declared type at all (`sameAs` points at a vocabulary
   * nobody indexes). See
   * [ADR 20](../../docs/decisions/0020-resolve-a-references-fields-from-the-targets-own-collection.md).
   */
  readonly ref?: ReferenceStrategy;
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
  /** The `name` of this type’s display field, when it serves as a
   *  {@link ReferenceField.labelSource} – the word the API surfaces a resolved
   *  label under. Defaults to `label`; declare another (e.g. `name`, for a
   *  profile that models display names as `schema:name`) so the surface word is
   *  the profile’s, not a role the type happens to play internally. The named
   *  field must be an `output`, `searchable` text field ({@link labelFieldOf}).
   *  Ignored for a type nothing resolves labels from. */
  readonly labelField?: string;
  readonly fields: readonly SearchField[];
}

/**
 * Which declared field of a {@link RootType} holds its **document key**, when
 * that key is not the node’s own IRI. It has the shape of
 * {@link SearchTypeBase.labelField} – *which field is the label* – and says
 * *which field holds the key*: a statement about the search document, never
 * about the world, so the words a deployment reaches for (identity, alignment,
 * canonical, authority) stay in the deployment’s own schema comments.
 *
 * Two things that already hold of keys then hold here too, without a new rule:
 * several nodes sharing a key are **one document** (the writer upserts by `id`,
 * so a deployment that wants particular content on the merged document attaches
 * a transform, and one that does not gets last-writer-wins), and a reference
 * into a keyed type stores the **target’s key** – a `lookup`/`labelSource`
 * already means *this field holds ids of documents in that collection*
 * (ADR 20), which storing the node IRI would break.
 *
 * See [ADR 22](../../docs/decisions/0022-key-a-root-type-on-a-declared-field.md).
 */
export interface KeyField {
  /**
   * The `name` of a declared field of this type whose values are the key
   * candidates: a path-bearing, `array` {@link ReferenceField} that is not
   * `inline` ({@link searchSchema} validates all four). Being an ordinary field
   * is the point – its extraction branch already exists, a reader transform
   * that repairs reference values covers it the day it is declared, and its own
   * {@link ReferenceField.transform} is where IRI normalisation lives, so two
   * spellings of one IRI become one candidate before anything chooses among
   * them.
   *
   * A transform that **replaces** a root’s quads must re-emit this field, the
   * existing rule that *a field the document needs must be in the stream*
   * applied to one more field; a transform that only adds never meets it.
   */
  readonly field: string;
  /**
   * Choose the key among the candidates – the key field’s values after its
   * `transform`, IRI-filtered, deduplicated and sorted, so the default is
   * deterministic whatever order the CONSTRUCT returned them in. Return one of
   * them, or `undefined` to keep the node’s own IRI; anything else throws at
   * projection. Not consulted for a node whose key field is empty.
   *
   * Must be **pure**: the same function keys the document and every reference
   * to it, so a `pick` that consulted the network or the clock could key the
   * two differently and leave a reference dangling. LDE never inspects an
   * IRI’s shape – it asks.
   *
   * @default the first candidate
   */
  readonly pick?: (candidates: readonly string[]) => string | undefined;
}

/**
 * A {@link RootType}’s **facet policy**: which of its documents get a facet
 * bucket, as a predicate over the document key. Declared once, on the type,
 * and inherited by every facetable reference that *names* the type – a
 * `lookup`’s `target`, an `idOnly`’s `labelSource` ({@link labelSourceNameOf})
 * – because *which of a type’s ids deserve a bucket* is a fact about the type,
 * not about each field that points at it. A per-field policy would be one rule
 * declared N times, and forgetting one would silently reintroduce the buckets
 * on that facet alone.
 *
 * Only the facet narrows. The referring field keeps **every** value: a
 * document still displays the excluded referent, and a `where` filter on its
 * IRI still matches exactly. *Facets are discovery, filters are exact.*
 *
 * The mechanism is a second physical field per inheriting facet –
 * `${name}_facet`, holding the admitted subset ({@link physicalFields}) – which
 * the engine facets instead of the field itself, so the facet is exact under
 * any bucket cap: the engine never sees an excluded value. Declaring a policy
 * therefore changes the collection definition of every type that references
 * this one; an engine adapter that reuses a live collection must notice.
 *
 * **The failure mode is silence.** A predicate that admits none of a type’s
 * keys – a type whose alignments are not what it tests for, or stored values
 * that are still node IRIs because the type was keyed after its references
 * were indexed – empties every facet referencing the type without an error.
 * Give each type its own predicate rather than reuse another’s, and key a type
 * ({@link RootType.key}) before declaring a policy over its keys.
 */
export interface FacetKeys {
  /** Whether a document key gets a bucket. Must be **pure**: it is applied per
   *  document at projection time, so an impure one would bucket one document
   *  and not its twin. */
  readonly only: (id: string) => boolean;
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
  /** Which declared field holds this type’s document key, when it is not the
   *  node’s own IRI ({@link KeyField}, {@link documentKeyOf}). */
  readonly key?: KeyField;
  /** Which of this type’s documents get a facet bucket, on every facetable
   *  reference that names this type ({@link FacetKeys}). Unset, every
   *  document does. */
  readonly facetKeys?: FacetKeys;
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
  /** A Reference Type has no document key to declare: it is nested inside its
   *  referrer rather than keyed in a collection of its own. `never` for the
   *  same reason `class` is. */
  readonly key?: never;
  /** Nothing references a Reference Type by id, so there is no facet for a
   *  policy to narrow. `never` for the same reason `key` is. */
  readonly facetKeys?: never;
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

/**
 * The Root Type name index each {@link SearchSchema} carries alongside its
 * class-keyed map. A schema is keyed by `class` because that is what a selector
 * and a Writer address it by, while every declaration that points at another
 * type – a `lookup`’s `target`, an `idOnly`’s `labelSource`, a join edge –
 * names it. Kept beside the map rather than rebuilt per consumer, so the
 * projection, the label-source validation and an adapter’s lookup resolve a
 * target the same way ({@link rootTypeNamed}) instead of each maintaining a
 * by-name map of its own.
 */
const rootTypesBySchema = new WeakMap<
  SearchSchema,
  ReadonlyMap<string, RootType>
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
 * schema-wide invariants are enforced – including the join rules, by building
 * the {@link joinGraph} eagerly: no two Root Types may share a `class` IRI
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
  assertServiceableNestedFields(referenceTypes);
  // The one blessed cast: only this validated constructor mints the brand. Built
  // BEFORE the schema-wide assertions that resolve a type by name, so they can
  // use `rootTypeNamed` – the same reading the projection and an adapter's
  // lookup use – rather than a by-name map of their own. The schema stays local
  // until every assertion has passed, so an invalid one is never observable.
  const rootTypes = types.filter(isRootType);
  const schema = new Map(
    rootTypes.map((searchType) => [searchType.class, searchType]),
  ) as unknown as SearchSchema<Types>;
  referenceTypesBySchema.set(schema, referenceTypes);
  rootTypesBySchema.set(
    schema,
    new Map(rootTypes.map((searchType) => [searchType.name, searchType])),
  );
  assertResolvableLabelSources(types, schema);
  // Build the join graph eagerly and discard it: it is cached per schema, and
  // building it is what enforces the schema-wide join rules (one joinable
  // reference per target, every target an indexed Root Type, no cycles). A
  // schema whose joins do not hold up therefore fails HERE, not on the first
  // query or – worse – halfway through the first rebuild.
  joinGraph(schema);
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

/**
 * The {@link RootType} a declaration names – a `lookup`’s `target`, an
 * `idOnly`’s {@link ReferenceField.labelSource} ({@link labelSourceNameOf}), a
 * join edge – or `undefined` when the schema declares no Root Type by that
 * name. The one reading of *which type does this point at*, so the projection
 * (which re-keys a reference through its target’s {@link KeyField}), the
 * label-source validation and an adapter’s lookup cannot resolve a target
 * differently.
 *
 * Complements {@link referenceTypeNamed}: the two name indexes are disjoint,
 * because {@link searchSchema} rejects a name declared twice.
 */
export function rootTypeNamed(
  schema: SearchSchema,
  name: string,
): RootType | undefined {
  return rootTypesBySchema.get(schema)?.get(name);
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
 * The {@link ReferenceType} an inline reference **stores entries of**, or
 * `undefined` for every other field. The one predicate the collection
 * definition, result reconstruction and the API surfaces share, so they cannot
 * disagree about which fields carry nested Search Documents and which carry a
 * bare IRI: a `labelOnly`/`idOnly` reference stays an id (plus a resolved
 * label).
 *
 * The line is *any Role at all*, not `output`: an inline reference declaring no
 * Role is a reading device, pruned before the writer
 * ({@link isInternalField}), while one that is `filterable` or `facetable`
 * without being `output` still has its entries stored – they are what a nested
 * filter constrains and what the
 * {@link ReferenceStrategy.identity identity companion} is harvested from. Only
 * `output` decides whether they are *surfaced*, which is the surfaces’ own
 * question ({@link outputFields}).
 *
 * A schema built by {@link searchSchema} always resolves the reference type of
 * its own types; `undefined` for a type declared against another schema.
 */
export function nestedReferenceType(
  schema: SearchSchema,
  field: SearchField,
): ReferenceType | undefined {
  return isInlineReference(field) && !isInternalField(field)
    ? referenceTypeNamed(schema, field.ref.typeName)
    : undefined;
}

/**
 * The Physical Field name a nested field carries in the engine: the surfaced
 * inline reference’s own name, then the referent’s physical name –
 * `media.contentUrl`, `media.label_nl`, and `media.thumbnail.contentUrl` one
 * hop deeper. The nested counterpart of {@link physicalFields}, and equally the
 * single home of its convention: the collection definition declares these
 * names, so a second consumer (a nested filter compiler) reads them from here
 * rather than restating the separator.
 *
 * The nested Search Document itself is keyed by the referent’s own field names
 * ({@link ProjectedNode}) – the qualification is how an engine that stores
 * nested documents flat addresses them, never what the projection writes.
 */
export function nestedFieldName(parent: string, name: string): string {
  return `${parent}.${name}`;
}

/**
 * The framing depth a Root Type needs: how far the **furthest value it declares**
 * lies from it, in hops. Depth is a property of the declaration, bounded because
 * {@link searchSchema} rejects inline cycles – never a knob or a constant.
 * Framing bounded per batch keeps memory bounded by the unit of work (ADR 12),
 * not the graph.
 *
 * Reach is measured in hops and depth in *intermediate* nodes, so depth is one
 * less: reading `<a>/<b>` off a root needs the root’s own triples plus those of
 * the node `<a>` reaches, which is depth 1. Floored at one, preserving the
 * single-hop embed a non-inline reference has always had.
 *
 * Four things add hops, and counting only the first is what let a value fall
 * outside the frame and be stored as absent, in silence:
 *
 * - **a property path**, which may traverse (`<a>/<b>` is two hops);
 * - **an inline reference**, whose referent’s own fields reach on from wherever
 *   its path landed;
 * - **a {@link ReferenceStrategy.local local} lookup**, whose target’s own
 *   fields reach on from the endpoint in the same way, through a Root Type;
 * - **a reference naming a keyed target**, whose document key is read one hop
 *   past the referent (ADR 22) – so a reference reached through an inline
 *   chain needs its key hop inside the frame too, or it stores an un-keyed id
 *   that matches nothing in the target’s collection. This one is also what a
 *   cut local expansion falls back to, so it is counted there as well.
 */
export function inlineFramingDepth(
  schema: SearchSchema,
  searchType: SearchType,
): number {
  return Math.max(1, framingReach(schema, searchType) - 1);
}

/**
 * The furthest a declared value lies from a node of `searchType`, in hops. A
 * reference the given schema does not declare (e.g. a type framed against
 * another schema) contributes no reach.
 *
 * `visiting` is what makes the walk terminate. {@link searchSchema} rejects
 * *inline* cycles, but a {@link ReferenceStrategy.local local} lookup can reach
 * a Root Type that reaches back – `Work → Person → Work` is a perfectly
 * reasonable schema – and nothing forbids it. A type already on the path
 * contributes no further reach, so a cycle stops rather than being rejected:
 * the depth it would ask for is unbounded, and the useful depth is the acyclic
 * one.
 *
 * The cut is made **where the field is read**, not on entry, because the
 * extraction cuts there too and still emits the key hop it falls back to. A
 * guard on entry would count the cut as reach 0 and nothing else, framing that
 * hop out – and the innermost referent would store a node IRI keying nothing.
 */
function framingReach(
  schema: SearchSchema,
  searchType: SearchType,
  visiting: ReadonlySet<string> = new Set(),
): number {
  const onPath = new Set(visiting).add(searchType.name);
  let furthest = 0;
  for (const field of searchType.fields) {
    if (field.path === undefined) {
      continue;
    }
    const hops = pathHopCount(field.path);
    if (isInlineReference(field)) {
      const referent = referenceTypeNamed(schema, field.ref.typeName);
      furthest = Math.max(
        furthest,
        hops +
          (referent === undefined ? 0 : framingReach(schema, referent, onPath)),
      );
      continue;
    }
    // A `local` lookup reads the target’s OWN fields off the referent, so the
    // target’s reach continues from wherever this field’s path landed – the
    // same accumulation an inline reference makes, through a Root Type.
    //
    // Cut at a type already on the path, exactly where the extraction cuts:
    // there the local expansion contributes nothing and the extraction falls
    // back to the key hop, whose own traversal still has to be framed. Reading
    // the cut as “reach 0, and nothing else to count” left the innermost
    // referent’s key one hop outside the frame, so it stored a node IRI that
    // matches nothing in the target’s collection.
    const local = localLookupTypeOf(field, schema);
    if (local !== undefined && !onPath.has(local.name)) {
      furthest = Math.max(furthest, hops + framingReach(schema, local, onPath));
      continue;
    }
    // A keyed target’s key field is itself path-bearing, so its own traversal
    // counts too – the extraction reads it off the referent with that path.
    const keyPath = keyedTargetKeyPath(field, schema);
    furthest = Math.max(
      furthest,
      hops + (keyPath === undefined ? 0 : pathHopCount(keyPath)),
    );
  }
  return furthest;
}

/** The `path` of the key field of the keyed Root Type a reference names, when
 *  it names one that declares a {@link RootType.key}. */
function keyedTargetKeyPath(
  field: SearchField,
  schema: SearchSchema,
): string | undefined {
  if (field.kind !== 'reference') {
    return undefined;
  }
  const targetName = labelSourceNameOf(field);
  const target =
    targetName === undefined ? undefined : rootTypeNamed(schema, targetName);
  if (target?.key === undefined) {
    return undefined;
  }
  // `searchSchema` guarantees a key field that is declared and path-bearing –
  // the same guarantee the extraction’s key hop is built on.
  return (
    fieldNamed(target, target.key.field) as SearchField & { path: string }
  ).path;
}

/**
 * How many hops a `path` traverses: the number of top-level sequence steps.
 * `<a>/<b>` is two; alternation and inverse do not add a hop, and a `/` inside
 * an IRI or a group is not a step.
 *
 * A path that carries no `<` is a **single term** – one IRI – however many `/`
 * its IRI happens to contain (`<https://schema.org/name>` is one hop, not
 * four). That is not a special case but the grammar: a sequence is only
 * expressible with each IRI delimited, since `?s a/b ?o` does not parse.
 * Reading the delimiters is therefore what tells a path apart from an IRI, and
 * it is the whole reason this is safe to scan rather than parse.
 *
 * Deliberately a scanner: the grammar belongs to the reader adapter (which
 * parses it for real), and only the *shape* of the sequence matters here. It is
 * also the safe direction to be approximate in – an over-count frames one hop
 * too wide, which costs a little; an under-count leaves a declared value
 * outside the frame, which is silent.
 */
function pathHopCount(path: string): number {
  if (!path.includes('<')) {
    return 1;
  }
  let steps = 1;
  let nesting = 0;
  for (const character of path) {
    if (character === '<' || character === '(') {
      nesting++;
    } else if (character === '>' || character === ')') {
      nesting--;
    } else if (character === '/' && nesting === 0) {
      steps++;
    }
  }
  return steps;
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
      // An inline reference’s stored value is a nested object, which an engine
      // can neither tokenize for free text nor order by. `filterable` and
      // `facetable` it CAN serve – through the identity companion below – so
      // only the roles no companion could answer are refused here.
      const extraRoles = unserviceableInlineRoles(field);
      if (extraRoles.length > 0) {
        throw new Error(
          `Inline reference “${searchType.name}.${field.name}” declares ${extraRoles
            .map((role) => `“${role}”`)
            .join(
              ', ',
            )}, which it cannot serve: its value is a nested object, not a token an engine can search, sort or join on.`,
        );
      }
      assertIdentityCompanion(searchType, field, referenceTypes);
    }
  }
  for (const searchType of types) {
    for (const field of searchType.fields) {
      assertServiceableLocalLookup(searchType, field);
    }
  }
  assertConsistentIdentities(types);
  for (const referenceType of referenceTypes.values()) {
    assertNoInlineCycle(referenceType, referenceTypes, new Set());
  }
}

/**
 * An inline reference’s {@link ReferenceStrategy.identity identity companion}
 * holds together in both directions: `filterable`/`facetable` need an
 * `identity` to point the engine at, and an `identity` with neither Role is a
 * companion nothing reads.
 *
 * The named field must be a nested **reference that names a target** – a
 * `lookup`’s `target` or an `idOnly`’s `labelSource` – because naming one is
 * exactly the claim the companion rests on: *these values are ids of documents
 * in that collection* (ADR 20). That the target resolves to a declared Root
 * Type needs no rule here: {@link assertResolvableLabelSources} walks Reference
 * Types too, so the nested reference this names is resolved with every other.
 */
function assertIdentityCompanion(
  searchType: SearchType,
  field: ReferenceField & { readonly ref: { readonly typeName: string } },
  referenceTypes: ReadonlyMap<string, ReferenceType>,
): void {
  const where = `Inline reference “${searchType.name}.${field.name}”`;
  const identity = field.ref.identity;
  const filters = field.filterable === true || field.facetable === true;
  if (identity === undefined) {
    if (filters) {
      throw new Error(
        `${where} declares “filterable”/“facetable” without an “identity”: a nested object is not a value an engine filters or facets, so it needs a nested reference to name the ids to filter and facet in its place.`,
      );
    }
    return;
  }
  if (!filters) {
    throw new Error(
      `${where} declares an “identity” but neither “filterable” nor “facetable”: the companion it names would be indexed and never read. Declare a Role for it, or drop the “identity”.`,
    );
  }
  // A companion is a FLAT field beside the reference, and only a Root Type has
  // somewhere flat to put one: inside a Reference Type it would be written into
  // each entry and declared nowhere, so a filter on it would name a field the
  // collection does not carry. An edge nested inside another edge is not a
  // shape anything has needed; refusing it is better than serving it wrong.
  if (searchType.class === undefined) {
    throw new Error(
      `${where} declares an “identity”, but “${searchType.name}” is a reference type: an identity companion is a flat field beside the reference, and a nested one has nowhere to live. Declare the companion on the reference that carries this type.`,
    );
  }
  // Resolvable by construction: the typeName was checked just above.
  const referenceType = referenceTypes.get(field.ref.typeName);
  const identityField = referenceType && fieldNamed(referenceType, identity);
  if (identityField === undefined) {
    throw new Error(
      `${where} names identity “${identity}”, which “${field.ref.typeName}” does not declare.`,
    );
  }
  if (
    identityField.kind !== 'reference' ||
    labelSourceNameOf(identityField) === undefined
  ) {
    throw new Error(
      `${where} names identity “${identity}”, which names no target: an identity companion holds ids of documents in a collection, so the field it harvests must be a reference declaring a “lookup” target or a label source.`,
    );
  }
}

/**
 * A {@link ReferenceStrategy.local local} lookup stores a nested object rather
 * than an id, so it is held to the same Roles an inline reference is: an engine
 * can neither tokenize an object for free text, order by it, facet it, nor
 * point a reference field at it.
 *
 * Without this the failures are all silent-ish and all different: a `joinable`
 * one emits an engine reference over a field holding objects, a `facetable` one
 * has `physicalFields` name a facet field the collection never declares, and a
 * `filterable` one compiles a membership clause against an object. Refusing the
 * declaration is the only place these are one mistake.
 *
 * `filterable` it CAN serve, and does so the same way an inline reference does:
 * through a flat `${name}_id` companion beside the stored object
 * ({@link physicalFields}). That is what lets a condition on the endpoint's
 * identity be welded to a condition on the edge's own value – an engine can
 * only weld conditions on an entry's own **leaf** fields, and the endpoint's id
 * is otherwise one level further in.
 */
function assertServiceableLocalLookup(
  searchType: SearchType,
  field: SearchField,
): void {
  if (
    field.kind !== 'reference' ||
    field.ref?.strategy !== 'lookup' ||
    field.ref.local !== true
  ) {
    return;
  }
  const unserviceable = unserviceableInlineRoles(field);
  if (
    unserviceable.length > 0 ||
    field.facetable === true ||
    field.joinable === true
  ) {
    const roles = [
      ...unserviceable,
      ...(field.facetable === true ? (['facetable'] as const) : []),
      // `validateSearchType` refuses `joinable` on an INLINE reference, not on
      // a lookup, so a `local` one would otherwise pass: `joinGraph` builds the
      // edge, the collection builder takes the nesting branch and emits no
      // engine reference, and the join fails at query time against a field the
      // collection never declared.
      ...(field.joinable === true ? (['joinable'] as const) : []),
    ];
    throw new Error(
      `Local lookup “${searchType.name}.${field.name}” declares ${roles
        .map((role) => `“${role}”`)
        .join(
          ', ',
        )}, which it cannot serve: a “local” lookup stores the referent’s own document, not an id an engine can search, sort, facet or join on.`,
    );
  }
}

/**
 * Every field nesting one Reference Type must agree about whether it declares
 * an {@link ReferenceStrategy.identity identity}.
 *
 * One reference type yields ONE emitted filter type, shared by every field that
 * nests it, and whether that filter offers an “ids it holds” arm is exactly
 * whether an identity was declared. Left to disagree, the arm would be decided
 * by whichever field a surface happened to build the type from: the
 * identity-bearing field silently loses the ability to filter by id, or the
 * identity-less one gains an arm that filters a nested object an engine cannot
 * read. Both are silent, and which one you get depends on declaration order.
 *
 * The rule is therefore about the *edge type*, not about each field reaching
 * it, and it fails at startup naming both fields.
 */
function assertConsistentIdentities(types: readonly SearchType[]): void {
  const declaredBy = new Map<string, { field: string; identity: boolean }>();
  for (const searchType of types) {
    for (const field of searchType.fields) {
      if (!isInlineReference(field) || isInternalField(field)) {
        continue;
      }
      const identity = field.ref.identity !== undefined;
      const where = `${searchType.name}.${field.name}`;
      const first = declaredBy.get(field.ref.typeName);
      if (first === undefined) {
        declaredBy.set(field.ref.typeName, { field: where, identity });
        continue;
      }
      if (first.identity !== identity) {
        const [with_, without] = first.identity
          ? [first.field, where]
          : [where, first.field];
        throw new Error(
          `References “${with_}” and “${without}” both nest “${field.ref.typeName}” but disagree about “identity”: they share one emitted filter type, so one of them would silently lose the ability to filter by id – or gain one that filters a nested object. Declare an identity on both, or on neither.`,
        );
      }
    }
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
 * Every field of a {@link ReferenceType} must be one the nesting can actually
 * serve. A nested field carries `output`, `filterable` and `searchable`; it may
 * also be a `lookup`, resolved by descending its entries rather than by a
 * round-trip of its own. `facetable` and `sortable` are refused, and for
 * measured reasons rather than for want of a compiler:
 *
 * - **`facetable`** – an engine’s facet counts over a nested field are
 *   *document-level*. A filter scoped to one entry does not scope the facet, so
 *   a bucket counts every entry of every matching document, including the
 *   entries that did not satisfy the filter. The count is therefore wrong in a
 *   way no work on our side recovers. Facet a qualified edge through its
 *   {@link ReferenceStrategy.identity identity companion}, which is a flat
 *   field an engine facets exactly.
 * - **`sortable`** – there is no such thing as sorting *into* an element of an
 *   array; a document holds many entries and a sort key is one value.
 *
 * A `labelSource` stays refused: it would need a label lookup no reconstruction
 * runs, and a nested reference that wants its referent’s fields declares a
 * `lookup` instead. A Role-less field stays an {@link isInternalField Internal
 * Field}, the reading device that is the other half of an inline reference’s
 * job.
 *
 * Checked schema-wide, like the label sources and for the same reason: a single
 * declaration cannot see whether it is a Reference Type at all.
 *
 * See [ADR 24](../../docs/decisions/0024-carry-data-on-a-reference-edge.md).
 */
function assertServiceableNestedFields(
  referenceTypes: ReadonlyMap<string, ReferenceType>,
): void {
  for (const referenceType of referenceTypes.values()) {
    for (const field of referenceType.fields) {
      const unserviceable = unserviceableNestedRoles(field);
      if (unserviceable.length > 0) {
        throw new Error(
          `Nested field “${referenceType.name}.${field.name}” declares ${unserviceable
            .map((role) => `“${role}”`)
            .join(
              ', ',
            )}, which nesting cannot serve: an engine facets a nested field per document rather than per entry, sorts on one value rather than into an array, and has no collection to join to from inside an entry. Facet the edge through the inline reference’s “identity” companion instead.`,
        );
      }
      if (
        (field as { readonly labelSource?: string }).labelSource !== undefined
      ) {
        throw new Error(
          `Nested field “${referenceType.name}.${field.name}” declares a label source, which an inline reference cannot serve; declare a “lookup” on the nested reference instead of resolving a label for it.`,
        );
      }
    }
  }
}

/** The Roles a **nested** field declares that nesting cannot serve, in
 *  declaration order, so a message names them all at once. */
function unserviceableNestedRoles(
  field: SearchField,
): readonly (typeof UNSERVICEABLE_NESTED_ROLES)[number][] {
  return UNSERVICEABLE_NESTED_ROLES.filter(
    (role) => (field as unknown as Record<string, unknown>)[role] === true,
  );
}

/**
 * The Roles a nested field cannot carry. An engine facets a nested field per
 * document rather than per entry, and cannot sort into an array element.
 *
 * `joinable` is refused for a different reason: a join is a clause about
 * another COLLECTION, and there is none to address from inside an entry.
 * `buildJoinGraph` walks Root Types, so a nested one builds no edge and the
 * collection emits no engine reference – while the surface still offers the
 * filter, whose criterion then degrades to a vacuous `in: []` and matches
 * EVERYTHING. Refusing the declaration is the only place that is one mistake.
 */
const UNSERVICEABLE_NESTED_ROLES = [
  'facetable',
  'sortable',
  'joinable',
] as const;

/** The Roles the **inline reference itself** declares that it cannot serve, in
 *  declaration order. Its value is a nested object, which an engine can neither
 *  tokenize for free text nor order by; `filterable` and `facetable` it serves
 *  through its {@link ReferenceStrategy.identity identity companion}. */
function unserviceableInlineRoles(
  field: ReferenceField,
): readonly (typeof UNSERVICEABLE_INLINE_ROLES)[number][] {
  return UNSERVICEABLE_INLINE_ROLES.filter((role) =>
    role === 'searchable'
      ? field.searchable !== undefined
      : field[role] === true,
  );
}

/** The Roles an inline reference cannot carry. `joinable` is absent because
 *  {@link validateSearchType} already refuses it on an inline reference, with a
 *  reason of its own; refusing it twice would only make which message appears
 *  depend on validation order. */
const UNSERVICEABLE_INLINE_ROLES = ['searchable', 'sortable'] as const;

/** The label field name a type falls back to when it declares no
 *  {@link SearchTypeBase.labelField}. */
export const DEFAULT_LABEL_FIELD = 'label';

/** The `name` the type serves its label under: its declared
 *  {@link SearchTypeBase.labelField}, else `label`. */
export function labelFieldNameOf(searchType: SearchType): string {
  return searchType.labelField ?? DEFAULT_LABEL_FIELD;
}

/**
 * The text field a label source serves labels from – the label convention in
 * one place: an `output` (something to reconstruct a label from), `searchable`
 * (something to type ahead against) text field named by
 * {@link labelFieldNameOf}. Returns `undefined` when the type declares no such
 * field; a schema built by {@link searchSchema} guarantees it for every type
 * named as a {@link ReferenceField.labelSource}.
 */
export function labelFieldOf(searchType: SearchType): TextField | undefined {
  const field = fieldNamed(searchType, labelFieldNameOf(searchType));
  return field !== undefined &&
    field.kind === 'text' &&
    field.output === true &&
    field.searchable !== undefined
    ? field
    : undefined;
}

/**
 * The Root Type a reference resolves labels from, by name: a `lookup`’s
 * `target`, an `idOnly`’s {@link ReferenceField.labelSource}, or `undefined`
 * when it resolves none. One reading for the two declarations, so a consumer
 * never branches on the strategy to find the collection.
 */
export function labelSourceNameOf(field: ReferenceField): string | undefined {
  return field.ref?.strategy === 'lookup'
    ? field.ref.target
    : field.labelSource;
}

/**
 * Every name a reference resolves labels from – a `lookup`’s `target` or an
 * `idOnly`’s {@link ReferenceField.labelSource} – must be a declared type that
 * can actually serve labels ({@link labelFieldOf}). Checked schema-wide,
 * because a single declaration cannot see its siblings.
 *
 * Resolved through {@link rootTypeNamed}, which is exactly the set that has a
 * collection to serve labels from – a Reference Type is nested inside its
 * referrer and has none, so naming one here fails to resolve rather than
 * resolving to something unreadable.
 *
 * Reference Types are walked too, so a **nested** `lookup` has its `target`
 * resolved by the same pass a top-level one does. That is also what validates
 * the target behind an inline reference’s
 * {@link ReferenceStrategy.identity identity companion}, since the companion
 * harvests a nested reference that names one.
 */
function assertResolvableLabelSources(
  types: readonly SearchType[],
  schema: SearchSchema,
): void {
  for (const searchType of types) {
    for (const field of searchType.fields) {
      const labelSource = (field as { readonly labelSource?: string })
        .labelSource;
      if (labelSource !== undefined) {
        if (field.kind !== 'reference') {
          throw new Error(
            `Field “${searchType.name}.${field.name}” declares a label source but is a ${field.kind} field; only reference fields resolve labels from a source.`,
          );
        }
        // A lookup reads its labels from the `target` it already names, and an
        // inline reference carries the referent’s own fields – so a second name
        // for the same thing could only disagree with the first.
        if (field.ref !== undefined && field.ref.strategy !== 'idOnly') {
          throw new Error(
            `Reference “${searchType.name}.${field.name}” declares a label source on a ${field.ref.strategy} reference; only an idOnly reference does, for its facet buckets.`,
          );
        }
      }
      const sourceName =
        field.kind === 'reference' && field.ref?.strategy === 'lookup'
          ? field.ref.target
          : labelSource;
      if (sourceName === undefined) {
        continue;
      }
      const source = rootTypeNamed(schema, sourceName);
      if (source === undefined) {
        // A name that IS declared, just not as a Root Type, is the confusing
        // case: telling the author to declare a type they already declared
        // would send them looking in the wrong place. Only a Root Type has a
        // collection to resolve against, so name that instead.
        throw new Error(
          referenceTypeNamed(schema, sourceName) === undefined
            ? `Reference “${searchType.name}.${field.name}” names unknown label source “${sourceName}”; declare a SearchType with that name.`
            : `Reference “${searchType.name}.${field.name}” names label source “${sourceName}”, which is a Reference Type; a label source must be a Root Type, since a resolved label is read from that type’s own collection.`,
        );
      }
      if (labelFieldOf(source) === undefined) {
        throw new Error(
          `Reference “${searchType.name}.${field.name}” uses label source “${sourceName}”, which must declare an output, searchable text field “${labelFieldNameOf(source)}”.`,
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
    | 'missing-ref-type-name'
    | 'ref-not-allowed'
    | 'text-requires-locales'
    | 'locales-not-allowed'
    | 'facet-ranges-not-allowed'
    | 'searchable-not-allowed'
    | 'transform-not-allowed'
    | 'derive-with-path'
    | 'from-not-allowed'
    | 'from-with-path'
    | 'from-with-derive'
    | 'from-with-inline-ref'
    | 'unknown-projection-value'
    | 'duplicate-projection-value'
    | 'text-not-filterable'
    | 'text-not-facetable'
    | 'joinable-not-allowed'
    | 'joinable-without-label-source'
    | 'joinable-with-inline-ref'
    | 'reserved-field-name'
    | 'key-field-unknown'
    | 'key-field-not-reference'
    | 'key-field-without-path'
    | 'key-field-not-array'
    | 'key-field-inline'
    | 'key-pick-not-a-function'
    | 'key-not-allowed'
    | 'facet-keys-only-not-a-function'
    | 'facet-keys-not-allowed';
}

/**
 * The reserved logical name of a document’s IRI – the one field every indexed
 * thing carries, and the only one no {@link SearchType} declares. It is the
 * hit’s identity ({@link SearchHit.id}), not a value in its
 * {@link ResultDocument}, so it is surfaced and filtered by name alone.
 *
 * `id` answers *what the thing is*; a domain field like `schema:identifier`
 * answers *what a source system calls it* (a catalogue or record number). Those
 * are different questions, so a declaration may still carry an `identifier`
 * field of its own – but never an `id` one, which
 * {@link validateSearchType} rejects as `reserved-field-name`.
 */
export const ID_FIELD = 'id';

/**
 * The reserved `where` keys that name a **combinator** rather than a field.
 * Sibling keys in a `where` object already AND, so `or` is what makes a
 * disjunction expressible at all, and `and` is what lets a query carry more
 * than one of them.
 *
 * They live in the same namespace a declaration draws from, so a field called
 * `and` or `or` would shadow the combinator in `where` and silently answer a
 * different question – exactly as a declared `id` would.
 * {@link validateSearchType} rejects all three as `reserved-field-name`.
 * Neither is plausible as an RDF property name; a deployment that needs one
 * anyway can declare it under a different logical name, since the logical name
 * is deliberately not derived from the predicate IRI.
 */
export const AND_KEY = 'and';
export const OR_KEY = 'or';

/** The logical field names no {@link SearchType} may declare, each because a
 *  surface already gives that name a meaning of its own. */
const RESERVED_FIELD_NAMES: readonly string[] = [ID_FIELD, AND_KEY, OR_KEY];

/** Kinds that can feed full-text search (project a folded search field). */
const SEARCHABLE_KINDS: readonly FieldKind[] = ['text', 'keyword', 'reference'];

/** Kinds whose projection applies the {@link KeywordField.transform}. */
const TRANSFORMABLE_KINDS: readonly FieldKind[] = ['keyword', 'reference'];

/**
 * Kinds a {@link ProjectionValue} can populate: every projection value is an
 * IRI or a token, so only the two string-shaped kinds can hold one. `reference`
 * is what carries a {@link ReferenceField.labelSource}, and so the kind a
 * facet over the dataset wants.
 */
const FROM_KINDS: readonly FieldKind[] = ['keyword', 'reference'];

/** The {@link ProjectionValue}s a declaration may name. */
const PROJECTION_VALUES: readonly string[] = ['dataset'];

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
 *   display RE2 pattern), and is not the reserved {@link ID_FIELD};
 * - a `text` field’s declared locales are BCP-47-shaped (no `_`, which is the
 *   reserved name↔locale separator);
 * - a `reference` field that is `output` declares `ref` (the API surfaces
 *   need the reference type name), and – unless its strategy is `idOnly`, which
 *   emits no type of its own – that `ref` declares a `typeName`; `ref` on any
 *   other kind is meaningless;
 * - `joinable` only on a `reference` field, and only alongside a `labelSource`
 *   – the join addresses the referent’s collection, which is the one the label
 *   source names, so without it the flag states an edge to nowhere – and never
 *   on an `inline` reference, which is stored as a nested object rather than as
 *   an id a reference field can point at. The schema-wide half of the rule (at
 *   most one joinable field per (type, label source), no cycles) is
 *   {@link joinGraph}’s;
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
 *   computed, never both);
 * - `from` names a known {@link ProjectionValue}, sits on a `keyword`/`reference`
 *   field, excludes `path` and `derive` (the three are the value sources, and a
 *   field has exactly one), is not an `inline` reference (a projection value is
 *   a bare IRI, with no referent to carry fields from), and no two fields
 *   declare the same projection value – which would leave a consumer reading
 *   the dataset off a declaration no rule picks between;
 * - a {@link RootType.key} names a declared, `path`-bearing, `array`,
 *   non-`inline` `reference` field of this type, and its `pick` is a function
 *   ({@link keyIssues}); a {@link ReferenceType} declares no key at all;
 * - a {@link RootType.facetKeys} policy’s `only` is a function
 *   ({@link facetKeysIssues}); a {@link ReferenceType} declares no policy at
 *   all.
 *
 * Pure and total: returns every issue rather than throwing;
 * {@link assertValidSearchType} is the throwing entry point.
 */
export function validateSearchType(
  searchType: SearchType,
): readonly SearchTypeIssue[] {
  const issues: SearchTypeIssue[] = [];
  const seen = new Set<string>();
  const seenProjectionValues = new Set<string>();
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
    // `id` is the document’s IRI, surfaced and filtered for every type, and
    // `and`/`or` are the `where` combinators; a declared field of any of those
    // names would shadow it in the API output or in `where`, silently
    // answering a different question.
    if (RESERVED_FIELD_NAMES.includes(field.name)) {
      issue('reserved-field-name');
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
      // `typeName` names the emitted type, and only an `inline` reference
      // must declare one: a `lookup` derives its name from the `target` it
      // already names, and an `idOnly` surfaces as a bare IRI, emitting no
      // type at all. Without a name where one is needed, an API surface has
      // nothing to emit – the GraphQL one silently prints `undefined` as the
      // field's type, publishing a contract that is not a schema.
      if (
        field.output === true &&
        ((field.ref?.strategy === 'inline' &&
          field.ref.typeName === undefined) ||
          (field.ref?.strategy === 'lookup' && field.ref.target === undefined))
      ) {
        issue('missing-ref-type-name');
      }
      // A join addresses the referent's collection – the one a lookup's
      // `target` or an idOnly's `labelSource` names. With neither, the flag
      // states an edge to nowhere.
      if (
        field.joinable === true &&
        labelSourceNameOf(field as ReferenceField) === undefined
      ) {
        issue('joinable-without-label-source');
      }
      // An inline reference is stored as a NESTED OBJECT, not as an id an
      // engine can point a reference field at, so the two cannot both hold:
      // the collection definition would emit the nesting and silently drop the
      // reference, leaving a schema whose joins validate, compile and then fail
      // at the engine. Carry the referent inline or join to it, not both.
      if (field.joinable === true && field.ref?.strategy === 'inline') {
        issue('joinable-with-inline-ref');
      }
    } else {
      if (field.ref !== undefined) {
        issue('ref-not-allowed');
      }
      if (field.joinable === true) {
        issue('joinable-not-allowed');
      }
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
    if (field.from !== undefined) {
      if (!PROJECTION_VALUES.includes(field.from)) {
        issue('unknown-projection-value');
      } else if (seenProjectionValues.has(field.from)) {
        // Two fields over one projection value leaves every consumer that
        // resolves the value back to a declaration – the writer’s provenance
        // field, above all – with no rule to pick between them.
        issue('duplicate-projection-value');
      }
      seenProjectionValues.add(field.from);
      if (!FROM_KINDS.includes(field.kind)) {
        issue('from-not-allowed');
      }
      if (field.path !== undefined) {
        issue('from-with-path');
      }
      if (field.derive !== undefined) {
        issue('from-with-derive');
      }
      // An inline reference carries a referent’s projected fields, and the
      // collection definition declares it as a nested object. A projection
      // value has no referent – it is a bare IRI – so the two together would
      // declare an object field the projection fills with a string, and every
      // document import would fail.
      if (field.ref?.strategy === 'inline') {
        issue('from-with-inline-ref');
      }
    }
  }
  issues.push(...keyIssues(searchType), ...facetKeysIssues(searchType));
  return issues;
}

/**
 * The issues a type’s {@link RootType.key} declaration carries, each filed
 * under the field name the declaration names – so a message reads like every
 * other one, naming the field the rule is about rather than a member.
 *
 * The key field must be an ordinary declared field the extraction already
 * reads and the projection already applies a `transform` to: a `reference`
 * (candidates are IRIs), with a `path` (a key read from the graph, not one
 * derived from a document that is keyed already), `array` (a node may offer
 * several candidates, and a single-valued field would drop all but the first
 * before `pick` ever saw them), and not `inline` (which carries the referent’s
 * fields rather than its IRI, so it offers no candidate at all).
 */
function keyIssues(searchType: SearchType): readonly SearchTypeIssue[] {
  const key = (searchType as RootType).key;
  if (key === undefined) {
    return [];
  }
  const issue = (reason: SearchTypeIssue['reason']) => ({
    field: key.field,
    reason,
  });
  // A Reference Type is nested inside its referrer, never keyed in a collection
  // of its own – so a key on one states a rule nothing could apply.
  if (searchType.class === undefined) {
    return [issue('key-not-allowed')];
  }
  const issues: SearchTypeIssue[] = [];
  if (key.pick !== undefined && typeof key.pick !== 'function') {
    issues.push(issue('key-pick-not-a-function'));
  }
  const field = fieldNamed(searchType, key.field);
  if (field === undefined) {
    issues.push(issue('key-field-unknown'));
    return issues;
  }
  if (field.kind !== 'reference') {
    issues.push(issue('key-field-not-reference'));
    return issues;
  }
  if (field.path === undefined) {
    issues.push(issue('key-field-without-path'));
  }
  if (field.array !== true) {
    issues.push(issue('key-field-not-array'));
  }
  if (field.ref?.strategy === 'inline') {
    issues.push(issue('key-field-inline'));
  }
  return issues;
}

/**
 * The issues a type’s {@link RootType.facetKeys} declaration carries, filed
 * under the member’s name: the policy names no field – it is a rule about the
 * type’s own keys, applied through other types’ fields – so there is no field
 * name to file it under.
 */
function facetKeysIssues(searchType: SearchType): readonly SearchTypeIssue[] {
  const facetKeys = (searchType as RootType).facetKeys;
  if (facetKeys === undefined) {
    return [];
  }
  const issue = (reason: SearchTypeIssue['reason']) => ({
    field: 'facetKeys',
    reason,
  });
  // Nothing references a Reference Type by id, so a policy on one narrows no
  // facet – it states a rule nothing could apply.
  if (searchType.class === undefined) {
    return [issue('facet-keys-not-allowed')];
  }
  return typeof facetKeys.only === 'function'
    ? []
    : [issue('facet-keys-only-not-a-function')];
}

/** The union flattened to every possible member – the uniform shape runtime
 *  validation and generic iteration read; never a declaration type. */
interface FlatField extends SearchFieldBase, Searchable, RangeFacetable {
  readonly kind: FieldKind;
  readonly locales?: readonly string[];
  readonly ref?: ReferenceField['ref'];
  readonly transform?: (value: string) => string;
  readonly from?: ProjectionValue;
  readonly labelSource?: string;
  readonly joinable?: boolean;
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
  /** The field a facet on this field reads, when `facetable`: the field’s own
   *  `name`, or the `${name}_facet` companion holding the subset its target’s
   *  {@link FacetKeys facet policy} admits. `undefined` for a field that is
   *  not facetable. */
  readonly facet: string | undefined;
  /**
   * The **identity companion** an inline reference filters and facets through:
   * `${name}_id`, holding the ids its entries reference
   * ({@link ReferenceStrategy.identity}). `undefined` for every other field –
   * an ordinary field filters on its own `name`.
   *
   * A nested object is not a value an engine filters or facets, so this is the
   * flat field it filters and facets in its place. The logical field keeps one
   * name at the surface; only the physical fanout knows there are two.
   */
  readonly identity: string | undefined;
}

/** The physical name of an inline reference’s
 *  {@link ReferenceStrategy.identity identity companion}. */
export function identityFieldName(name: string): string {
  return `${name}_id`;
}

/**
 * The Root Type whose labels a reference’s **facet buckets** read – its own
 * label source, or, for an inline reference, the one its
 * {@link ReferenceStrategy.identity identity companion} points at.
 *
 * The same one-level-in reading {@link inheritedFacetKeys} makes, and for the
 * same reason: the companion holds that field’s ids, so the type that names
 * those ids is the type that can label them. Kept together with it so a facet
 * cannot inherit a policy from one type and its labels from another – or, as
 * happened first, inherit the policy and no labels at all.
 */
export function labelTargetNameOf(
  field: SearchField,
  schema: SearchSchema | undefined,
): string | undefined {
  if (field.kind !== 'reference') {
    return undefined;
  }
  return labelSourceNameOf(identityFieldOf(field, schema) ?? field);
}

/**
 * The Root Type a {@link ReferenceStrategy.local local} lookup projects its
 * referents through, or `undefined` for every other field. Such a reference
 * stores nested documents shaped by the **target’s own declaration** – so it
 * needs no reference type of its own, and reconstructs through the same path a
 * resolved referent does.
 */
export function localLookupTypeOf(
  field: SearchField,
  schema: SearchSchema | undefined,
): RootType | undefined {
  if (
    schema === undefined ||
    field.kind !== 'reference' ||
    field.ref?.strategy !== 'lookup' ||
    field.ref.local !== true
  ) {
    return undefined;
  }
  return rootTypeNamed(schema, field.ref.target);
}

/**
 * The nested reference an inline reference’s
 * {@link ReferenceStrategy.identity identity companion} harvests, or
 * `undefined` where the field declares none (or the schema cannot resolve its
 * reference type). The one reading of *which nested field identifies the edge*,
 * so the projection (which harvests it), {@link inheritedFacetKeys} (which
 * reads its target’s facet policy) and an adapter’s filter compiler cannot
 * resolve it differently.
 */
export function identityFieldOf(
  field: SearchField,
  schema: SearchSchema | undefined,
): ReferenceField | undefined {
  if (schema === undefined || !isInlineReference(field)) {
    return undefined;
  }
  const identity = field.ref.identity;
  if (identity === undefined) {
    return undefined;
  }
  const referenceType = referenceTypeNamed(schema, field.ref.typeName);
  if (referenceType === undefined) {
    return undefined;
  }
  // `assertIdentityCompanion` guarantees the named field is declared and is a
  // reference, so this is a read rather than a search.
  return fieldNamed(referenceType, identity) as ReferenceField | undefined;
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
 * `filterable`, `facetable`, `sortable`, `joinable`. Such a field is an
 * **internal field**: the projection populates it (so a later
 * {@link SearchFieldBase.derive} can read it), then prunes it before the
 * document reaches a writer, and the engine collection definition omits it
 * entirely – not stored, not indexed, no RAM. Absence of a role declares that
 * intent; there is no separate marker flag.
 *
 * {@link ReferenceField.joinable} counts as a role for exactly the reason the
 * others do: it is a promise about what the *engine* can do with the field, and
 * an engine can only join through a value it actually stores. Leaving it out
 * would let a joinable-but-otherwise-role-less reference declare an edge the
 * schema resolves, the query validates and the compiler emits – against a
 * collection that never stored the column, so every such query fails at the
 * engine.
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
    field.sortable !== true &&
    (field.kind !== 'reference' || field.joinable !== true)
  );
}

/** Fields of kind `reference` (IRI-valued, label-resolved), in declaration order. */
export function referenceFields(
  searchType: SearchType,
): readonly ReferenceField[] {
  return searchType.fields.filter((field) => field.kind === 'reference');
}

/**
 * The field a type declares over the dataset being indexed
 * ({@link ProjectionValue `from: 'dataset'`}), if it declares one.
 * {@link validateSearchType} rejects a second field over the same projection
 * value, so for any type that reached a {@link SearchSchema} this is the only
 * such field rather than the first of several.
 *
 * The single lookup every consumer of the declaration shares – the projection
 * that populates it, and the engine writer that keeps its provenance
 * bookkeeping on it rather than on a private field of its own.
 */
export function datasetField(
  searchType: SearchType,
): (KeywordField | ReferenceField) | undefined {
  return searchType.fields.find(
    (field): field is KeywordField | ReferenceField =>
      (field.kind === 'keyword' || field.kind === 'reference') &&
      field.from === 'dataset',
  );
}

/** Look up a field by its logical name. */
export function fieldNamed(
  searchType: SearchType,
  name: string,
): SearchField | undefined {
  return searchType.fields.find((field) => field.name === name);
}

/**
 * The **document key** of one node of `searchType`: what the projection writes
 * as the document’s `id`, and what a reference into this type stores.
 *
 * The whole rule, in one place, so the projection and any transform that needs
 * to know a node’s key read the same answer:
 *
 * 1. a type declaring no {@link RootType.key} keys on `nodeIri` – the node’s own
 *    IRI, as every type does today;
 * 2. otherwise the key field’s `rawValues` become **candidates**: its
 *    {@link ReferenceField.transform} (where IRI normalisation lives, so two
 *    spellings of one IRI become one candidate), then the
 *    {@link isAbsoluteIri} filter, then dedupe and sort – so the default is
 *    deterministic whatever order the CONSTRUCT returned them in;
 * 3. no candidate keys on `nodeIri`, without consulting {@link KeyField.pick};
 * 4. otherwise {@link KeyField.pick} chooses (defaulting to the first
 *    candidate), and `undefined` keeps `nodeIri`.
 *
 * So a key is always either the node’s own IRI or an IRI the graph offered for
 * that node – never one invented in between. A `pick` returning anything else
 * throws, naming the node and the candidates: it is a bug in a pure function
 * that keys both the document and every reference to it, and letting it through
 * would key those two differently.
 *
 * @param nodeIri the node’s own IRI – the key it falls back to
 * @param rawValues the key field’s values **as a reference field reads them** –
 *   a node’s `@id` or a bare-string value, before the field’s `transform`. A
 *   caller that reads them itself (a transform working on quads) must apply the
 *   same rule and skip a literal-valued object, or it will compute a key for a
 *   value the projection never saw and key the two differently.
 */
export function documentKeyOf(
  searchType: RootType,
  nodeIri: string,
  rawValues: readonly string[],
): string {
  const key = searchType.key;
  if (key === undefined) {
    return nodeIri;
  }
  // Guaranteed a declared reference field by `searchSchema`, which is what
  // validates a `key` at all.
  const { transform } = fieldNamed(searchType, key.field) as ReferenceField;
  const candidates = [
    ...new Set(
      (transform === undefined ? rawValues : rawValues.map(transform)).filter(
        isAbsoluteIri,
      ),
    ),
  ].sort();
  if (candidates.length === 0) {
    return nodeIri;
  }
  const picked = (key.pick ?? firstCandidate)(candidates);
  if (picked === undefined) {
    return nodeIri;
  }
  if (!candidates.includes(picked)) {
    throw new Error(
      `The “pick” of “${searchType.name}.key” returned “${picked}” for <${nodeIri}>, which is not among its candidates (${candidates
        .map((candidate) => `<${candidate}>`)
        .join(
          ', ',
        )}); a key must be one of them, or “undefined” to keep the node’s own IRI.`,
    );
  }
  return picked;
}

/** The {@link KeyField.pick} a type that declares none falls back to. */
function firstCandidate(candidates: readonly string[]): string {
  return candidates[0];
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
 * Whether a value is an **absolute IRI**: a scheme, then anything with no
 * whitespace. The single definition the projection (which
 * drops a reference value failing it) and an API surface (which types such a
 * value as an IRI, and rejects one that is not) both read, so the two cannot
 * disagree about what a reference holds – the argument {@link physicalFields}
 * makes for the physical fanout.
 *
 * Deliberately a **scheme check, not an `http(s)` one**. `urn:`, `doi:`, `ark:`,
 * `tag:`, `mailto:` and a deployment’s own minted scheme (`urn:lde:…`) are
 * ordinary Linked Data, and rejecting them would make this package refuse
 * conformant data. What the check does exclude is what a reference must never
 * hold: a blank node label (`_:b0` – a scheme must start with a letter), a bare
 * token (`boerenbont`), and a relative reference. Full RFC 3987 parsing would
 * buy nothing over that while starting to reject real data with a character
 * someone forgot to percent-encode.
 */
export function isAbsoluteIri(value: string): boolean {
  return ABSOLUTE_IRI.test(value);
}

/** Scheme (RFC 3986 `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`), then any
 *  run of non-whitespace. Non-ASCII is deliberately allowed: an IRI is not
 *  restricted to ASCII. */
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/;

/**
 * The engine storage codec for `date` fields: stored as Unix seconds (a
 * sortable, range-filterable int64), ISO 8601 at the API edges. One pair for
 * the projection (writes), the query compiler (filter bounds) and the surface
 * (output), so the three cannot disagree. Returns `undefined` for an
 * unparseable value.
 */
export function isoToUnixSeconds(iso: string): number | undefined {
  // Trim first: XSD collapses whitespace around a date literal before parsing,
  // so a padded lexical form is legal and reaches here verbatim. Left in place
  // it defeats the year expansion below in both directions – a leading space
  // stops the match, a trailing one survives it into the legacy parser – and
  // each lands the value in a different year than it reads.
  const millis = new Date(expandYear(iso.trim())).getTime();
  return Number.isNaN(millis) ? undefined : Math.trunc(millis / 1000);
}

/**
 * Pad a year outside the plain four-digit form to the signed six digits ISO
 * 8601 expects, so `Date` reads it as a year at all. Deep time is real data,
 * not a corner case: SCHEMA-AP-NDE blesses years beyond four digits for
 * `schema:dateCreated`. Left unexpanded, neither era parses as written and
 * neither fails loudly – `-1100` is read as a bare UTC offset and lands
 * around 1100 **CE** (shifted by the host’s offset), `25000` is read as a
 * legacy local-time date and lands a year early, on a boundary that moves
 * with the host’s timezone. Either way nothing throws, no field is left
 * absent, and the value sorts and filters as if it were another date
 * entirely. A plain four-digit year and an already-expanded one pass through
 * unchanged, so the form the API itself emits round-trips.
 */
function expandYear(iso: string): string {
  // The year, then the rest: a non-digit stops the run, so a longer digit
  // string (epoch millis, say) is left alone rather than cut into a year.
  const year = /^([+-]?)(\d{1,6})(\D.*|)$/.exec(iso);
  if (year === null || (year[1] === '' && year[2].length === 4)) {
    return iso;
  }
  return `${year[1] || '+'}${year[2].padStart(6, '0')}${year[3]}`;
}

/** The inverse of {@link isoToUnixSeconds}: stored Unix seconds → ISO 8601. */
export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Derive the **indexed** physical engine field names a declaration produces:
 * the per-locale `search`/`sort` fanout, and the field a `facet` reads. A
 * localized `text` field’s display fields are pattern-based and not enumerated
 * here – see {@link displayFieldName} and its siblings.
 *
 * The facet is the one member that depends on more than the declaration: a
 * facetable reference whose target declares a {@link FacetKeys facet policy}
 * facets a `${name}_facet` companion rather than itself, and only the `schema`
 * can resolve that target ({@link inheritedFacetKeys}). Without one the field
 * facets on its own name – the same reading the projection makes without a
 * schema, where it cannot re-key a reference either.
 */
export function physicalFields(
  field: SearchField,
  schema?: SearchSchema,
): PhysicalFields {
  if (field.kind === 'text') {
    const locales = field.locales;
    return {
      search: field.searchable
        ? locales.map((locale) => `${field.name}_search_${locale}`)
        : [],
      sort: field.sortable
        ? locales.map((locale) => `${field.name}_sort_${locale}`)
        : [],
      // Text is never facetable (`validateSearchType`).
      facet: undefined,
      identity: undefined,
    };
  }
  // A field storing a nested OBJECT cannot be filtered or faceted as itself, so
  // everything an engine indexes for it reads the identity companion instead –
  // the facet included, which is why the facet name is derived from the
  // companion rather than from `name`. Two shapes store one: an inline
  // reference that names an `identity`, and a `local` lookup, whose own id is
  // otherwise a level further in than an engine can weld a condition to.
  const nestsAnObject =
    identityFieldOf(field, schema) !== undefined ||
    (localLookupTypeOf(field, schema) !== undefined &&
      field.filterable === true);
  const identity = nestsAnObject ? identityFieldName(field.name) : undefined;
  const filtered = identity ?? field.name;
  return {
    search: field.searchable !== undefined ? [`${field.name}_search`] : [],
    sort: [],
    facet:
      field.facetable !== true
        ? undefined
        : inheritedFacetKeys(field, schema) === undefined
          ? filtered
          : `${filtered}_facet`,
    identity,
  };
}

/**
 * The {@link FacetKeys facet policy} a field inherits: the `facetKeys` of the
 * Root Type it names ({@link labelSourceNameOf}), when the field is a facetable
 * reference and the schema resolves that type. The boundary is *naming the
 * target* – the same line along which a reference is re-keyed and a join is
 * drawn – so a reference that names no type inherits nothing, whatever type
 * its values happen to point at; and a `derive`d reference, which produces its
 * own values rather than reading a referent, is re-keyed by nothing and so
 * narrowed by nothing either. The one reading the projection (which writes the
 * companion) and {@link physicalFields} (which names it) share.
 *
 * An **inline** reference names its target one level in, through the nested
 * reference its {@link ReferenceStrategy.identity identity companion} harvests
 * ({@link identityFieldOf}). The boundary is the same one: the companion holds
 * that field’s ids, so the policy that narrows a facet over those ids is the
 * policy of the type that field names. Reading it through the nested field
 * rather than declaring it twice is what keeps *which of a type’s ids deserve
 * a bucket* a fact about the type.
 */
export function inheritedFacetKeys(
  field: SearchField,
  schema: SearchSchema | undefined,
): FacetKeys | undefined {
  if (
    schema === undefined ||
    field.kind !== 'reference' ||
    field.facetable !== true ||
    field.derive !== undefined
  ) {
    return undefined;
  }
  const identity = identityFieldOf(field, schema);
  const targetName = labelSourceNameOf(identity ?? field);
  return targetName === undefined
    ? undefined
    : rootTypeNamed(schema, targetName)?.facetKeys;
}
