import type { Quad } from '@rdfjs/types';
import { fold } from '@lde/text-normalization';
import { matchLanguage } from './language.js';
import {
  buildSubjectIndex,
  frameSubjects,
  type FramedNode,
} from './frame-by-type.js';
import {
  companionNames,
  assertTypeInSchema,
  displayFieldName,
  displayLangOf,
  documentKeyOf,
  endpointFieldOf,
  fieldNamed,
  identityFieldOf,
  inheritedFacetPolicies,
  inlineFramingDepth,
  irAlias,
  isAbsoluteIri,
  isInternalField,
  isInlineReference,
  literalKindOf,
  localLookupTargetsOf,
  physicalFields,
  referencedTargetsOf,
  referenceTypeNamed,
  storableUnixSeconds,
  storedTargetOf,
  TARGET_FIELD,
  unixSecondsToIso,
  type KeywordField,
  type PhysicalFields,
  type ProjectionValue,
  type FacetKeys,
  type ReferenceField,
  type ReferenceType,
  type RootType,
  type SearchField,
  type SearchSchema,
  type SearchType,
  type StoredDate,
  type TextField,
} from './schema.js';
import { periodCovering, periodOf, type StoredPeriod } from './period.js';
import {
  describeValue,
  isReadKind,
  readValue,
  UNREADABLE,
  type ReadKind,
} from './read-value.js';

/**
 * A projected node: the fields of one {@link SearchType}, flat. A **Root Type**
 * carries the `id` that keys it – as a root it is a {@link SearchDocument}, and
 * nested by a {@link ReferenceStrategy.local local} lookup it is what the lookup
 * resolves against. A **Reference Type** never does: it is kept in no collection,
 * so nesting needs the referent’s fields and not its identity.
 */
export type ProjectedNode = Record<string, unknown>;

/** A flat search document. `id` is the engine document key. */
export type SearchDocument = { id: string } & ProjectedNode;

/**
 * What the projection knows that the graph does not say: the values a run
 * carries about the *indexing* rather than about the data. They reach a
 * declaration two ways – a field declaring {@link KeywordField.from `from`} is
 * populated from one, and every `derive` receives the whole context as its
 * second argument, so a derive can relate a projected value to it.
 *
 * Empty when the caller supplies nothing: projecting a graph in isolation (a
 * test, a one-off) is legitimate, and a field over an absent value is simply
 * left unpopulated, exactly as a `path` that matched nothing is.
 */
export interface ProjectionContext extends Partial<
  Readonly<Record<ProjectionValue, string>>
> {
  /** The IRI of the dataset being indexed. */
  readonly dataset?: string;
  /**
   * Called once for each value a typed field could not read and so left out:
   * a `date` over `Z.j`, an `integer` over `onbekend`, a `period` over
   * `1987/1897`, a `reference` over a literal, a `boolean` outside
   * `true`/`false`/`1`/`0`. Values from a `derive` count too; one that is not
   * a string is reported as `String(value)`.
   */
  readonly onUnreadable?: (unreadable: UnreadableValue) => void;
  /**
   * The projected document of the dataset being indexed, whose `id` is
   * {@link dataset}: it lets a `derive` copy a field of the dataset – the
   * publisher of a work’s dataset, say – onto every document indexed from it.
   * Supplied by a caller that projects the dataset first (`@lde/search-pipeline`,
   * for a schema with a `dcat:Dataset` root type); absent otherwise. See the
   * docs’ “Copy a field of the dataset” for when it is absent.
   */
  readonly datasetDocument?: SearchDocument;
}

/** A value a typed field could not read ({@link ProjectionContext.onUnreadable}). */
export interface UnreadableValue {
  /** The field that could not read it; dotted for a field of a nested
   *  referent (`creator.birthDate`). */
  readonly field: string;
  /** The value as the source – or the derive – stated it. */
  readonly value: string;
  /** The IRI of the node the document was projected from. */
  readonly id: string;
}

/** The context a projection runs with when its caller supplied none. */
const NO_PROJECTION_CONTEXT: ProjectionContext = {};

/**
 * Project one framed JSON-LD node into a flat search document: apply each field
 * of the type in declaration order. A field with a `derive` function computes
 * its value from the document as populated so far (so a derived field may read
 * fields declared before it), never from the graph – `path` is the complete
 * statement of what the projection reads. {@link isInternalField Internal
 * fields} (those declaring no role) are populated so a later derive can read
 * them, then pruned before the document is returned: they must reach neither a
 * writer nor the collection definition. Pruning ({@link pruneInternalFields})
 * recurses into the referents of surfaced inline references, so that invariant
 * holds at every depth, not just the root. The physical field names a field
 * fans out to come from {@link physicalFields}, the single source shared with
 * the engine collection definition and the query compiler.
 */
export function projectDocument(
  node: FramedNode,
  searchType: SearchType,
  schema?: SearchSchema,
  context: ProjectionContext = NO_PROJECTION_CONTEXT,
): SearchDocument {
  const key = documentKey(node);
  if (key === undefined) {
    throw new Error(
      `Cannot project a “${searchType.name}” node whose @id is not an absolute IRI (got ${JSON.stringify(node['@id']) ?? 'none'}; a blank node label or a relative reference is not one): every search document needs a stable key, and an empty one would collide with other keyless nodes.`,
    );
  }
  // The guard above is what makes this a SearchDocument: projectFields sets `id`
  // for exactly the nodes documentKey resolves.
  const document = projectFields(
    node,
    searchType,
    schema,
    context,
    unreadableSink(context, key),
  ) as SearchDocument;
  pruneInternalFields(document, searchType, schema);
  return document;
}

/**
 * Prune every internal field from a fully projected document, in place. Runs
 * only after all projection – so every derive that might read an internal
 * field, at any depth, has already run – which makes this single post-order
 * pass safe. A no-role inline reference is itself internal, so it is deleted
 * whole here; one that carries a Role survives, but its own internal helper
 * fields are pruned from the nested document. That keeps the *a field without a
 * role reaches neither the engine nor the API* invariant true at every depth of
 * the reference graph, not just at the root.
 *
 * Both kinds of nesting are walked, because both store projected nodes: an
 * inline reference’s Reference Type, and the Root Type a
 * {@link ReferenceStrategy.local local} lookup projects its endpoint through.
 * The second matters more than it looks – a Root Type’s reading-device fields
 * exist for its OWN derives, and nothing in a referring document wants them.
 *
 * A Reference Type entry’s `id` is pruned here too. It is a reading device of
 * the same kind: the node IRI a derive on the referrer may read, and never a
 * document key – an entry is kept in no collection, a weld names the identity
 * field inside it, and an entry’s own key answers no query (ADR
 * 24). Left in, it would make an entry’s shape depend on whether a publisher
 * minted an IRI for a relationship, and be a field the collection never
 * declared. A Root Type keeps its `id` wherever it nests: that is the key its
 * own collection files it under, and a `local` lookup resolves against it.
 */
function pruneInternalFields(
  document: ProjectedNode,
  searchType: SearchType,
  schema: SearchSchema | undefined,
): void {
  if (searchType.class === undefined) {
    delete document.id;
  }
  for (const field of searchType.fields) {
    if (isInternalField(field)) {
      // With its companions, which no collection declares for it either.
      for (const name of [field.name, ...companionNames(field)]) {
        delete document[name];
      }
      continue;
    }
    if (schema === undefined || field.kind !== 'reference') {
      continue;
    }
    const nestedTypes: readonly SearchType[] =
      field.ref?.strategy === 'inline'
        ? [referenceTypeNamed(schema, field.ref.typeName)].filter(
            (type): type is ReferenceType => type !== undefined,
          )
        : localLookupTargetsOf(field, schema);
    const nested = document[field.name];
    if (nestedTypes.length === 0 || nested === undefined) {
      continue;
    }
    for (const referent of Array.isArray(nested) ? nested : [nested]) {
      pruneInternalFields(
        referent as ProjectedNode,
        nestedTypes.length === 1
          ? nestedTypes[0]
          : storedTargetOf(
              referent as ProjectedNode,
              nestedTypes as readonly RootType[],
            ),
        schema,
      );
    }
    // Two entries that differed only in their node IRI are one entry now that
    // it is gone – two edge nodes stating the same fact.
    if (nestedTypes[0].class === undefined && Array.isArray(nested)) {
      document[field.name] = dedupeBy(nested, (referent) =>
        JSON.stringify(referent),
      );
    }
  }
}

/** Apply every field of `searchType` to a fresh document, without pruning – the
 *  shared core of {@link projectDocument} and inline-referent projection.
 *  Pruning is deferred to a single recursive pass ({@link pruneInternalFields})
 *  once the whole nested structure is projected, so a derive at any depth can
 *  still read an internal field before it is removed. */
function projectFields(
  node: FramedNode,
  searchType: SearchType,
  schema: SearchSchema | undefined,
  context: ProjectionContext,
  sink: UnreadableSink,
  nested = false,
): ProjectedNode {
  const document = emptyDocument(documentIdOf(node, searchType), searchType);
  for (const field of searchType.fields) {
    applyField(
      document,
      node,
      field,
      searchType,
      schema,
      context,
      sink,
      nested,
    );
  }
  return document;
}

/** A document holding only its `id`, if it has one. A Reference Type entry’s
 *  IRI is a reading device, so it is not enumerable there: a derive reads
 *  `entry.id`, but `Object.keys`, a spread and `JSON.stringify` see only the
 *  entry’s fields ({@link documentIdOf}). */
function emptyDocument(
  id: string | undefined,
  searchType: SearchType,
): ProjectedNode {
  if (id === undefined || searchType.class !== undefined) {
    return id === undefined ? {} : { id };
  }
  return Object.defineProperty({}, 'id', {
    value: id,
    configurable: true,
    writable: true,
  });
}

/**
 * The document key a framed node carries, if any – an {@link isAbsoluteIri
 * absolute IRI}, the same rule {@link iriString} applies to a referent, so a
 * root and a reference cannot disagree about what counts as identity. A blank
 * node label (`_:b0`) is not one: framing mints it per call, so it recurs across
 * documents and can change when unrelated triples do. A node bearing one is
 * therefore projected as if framing had pruned its `@id` – which it does
 * whenever the label occurs only once in the framing results.
 */
function documentKey(node: FramedNode): string | undefined {
  const id = node['@id'];
  return typeof id === 'string' && isAbsoluteIri(id) ? id : undefined;
}

/**
 * The `id` a node is projected under: its own IRI, unless its type declares a
 * {@link RootType.key} – then the key its key field carries
 * ({@link documentKeyOf}). The candidates are read off the frame like any other
 * field value, under the key field’s own {@link irAlias IR Alias}, because the
 * key field *is* an ordinary declared field: the extraction already emits it,
 * and a reader transform that repairs reference values has already run on it.
 *
 * The key is assigned before any `derive` runs, so a derive sees the key and
 * never the node IRI; a deployment that wants the node IRI declares a plain
 * `idOnly` reference over the same path.
 *
 * A Reference Type has no key, so its entry gets the node IRI itself – as a
 * reading device only. A Reference Type is nested in its referrer and kept in
 * no collection, so nothing downstream resolves an entry by key, and
 * {@link pruneInternalFields} removes the `id` again before the document
 * leaves the projection, exactly as it removes a no-role helper field. Until
 * then it is not enumerable, so no step that walks an entry’s keys mistakes it
 * for a field. What stays is the window in between: a `derive` on the referrer
 * reads the entry’s IRI where that IRI is the data – a IIIF manifest among a
 * work’s media, whose URL is its `@id` and stated nowhere else – and surfaces
 * it under a field of its own. The entry still needs a field of its own (the
 * manifest’s `encodingFormat`) to be a referent at all; an `@id` alone is not
 * one.
 */
function documentIdOf(
  node: FramedNode,
  searchType: SearchType,
): string | undefined {
  const nodeIri = documentKey(node);
  if (nodeIri === undefined || searchType.key === undefined) {
    return nodeIri;
  }
  return documentKeyOf(
    searchType,
    nodeIri,
    keyCandidatesOf(node, searchType, searchType.key.field),
  );
}

/** The raw values a node carries under a type’s key field – untransformed, as
 *  {@link documentKeyOf} expects them. Empty for a node the key field matched
 *  nothing on. The field itself is guaranteed declared by `searchSchema`, which
 *  is what validates a `key` at all. */
function keyCandidatesOf(
  node: FramedNode,
  searchType: SearchType,
  name: string,
): readonly string[] {
  const keyField = fieldNamed(searchType, name) as SearchField;
  return irisOf(node, irAlias(searchType, keyField));
}

/**
 * Project a single type over a known set of `roots` – the per-type, roots-given
 * projection. The roots are supplied by the caller (the pipeline selector)
 * rather than discovered from `rdf:type`, so `quads` need carry no type triples
 * and the projection frames each distinct subject once. {@link assertTypeInSchema}
 * guards that `searchType` belongs to `schema` – the port’s own membership check
 * – so no schema is ever forged to scope a projection to one type. Yields a bare
 * {@link SearchDocument}: pairing a document with its type is a routing concern,
 * owned by the pipeline glue, not the projection.
 *
 * Consumes `quads` once, so it accepts any `Iterable` – a batch’s materialized
 * array or a chained generator merging several readers.
 */
export async function* projectRoots(
  quads: Iterable<Quad>,
  roots: readonly string[],
  schema: SearchSchema,
  searchType: RootType,
  context: ProjectionContext = NO_PROJECTION_CONTEXT,
): AsyncIterable<SearchDocument> {
  assertTypeInSchema(schema, searchType);
  const index = buildSubjectIndex(quads);
  // Distinct roots only. A selector may return an IRI more than once – a
  // non-`DISTINCT` `SELECT` over a one-to-many join yields the same subject per
  // matched row – and framing a root twice would do the same work twice for one
  // node. Distinct roots may still legitimately share an `id`, where the type
  // declares a `key` two of them carry: that is what a document key means, and
  // it is the writer’s upsert – not the projection – that folds them into one
  // document.
  const depth = inlineFramingDepth(schema, searchType);
  for await (const node of frameSubjects(index, [...new Set(roots)], depth)) {
    yield projectDocument(node, searchType, schema, context);
  }
}

/**
 * The `required` fields a projected document
 * lacks, by name – a field of an inline reference’s referent as
 * `reference.field` – or none when it has them all.
 *
 * An engine cannot always hold a document to `required` itself. A text field
 * spreads over a display field per language and a search and sort field per
 * locale, so *a value in some language* is no one physical field it can make
 * mandatory; and a field of a Reference Type is required of every referent,
 * which a flag on a nested engine field cannot say. A writer asks this before
 * it writes, so a document the API would fail to serve is left out instead.
 *
 * An array or boolean field is never missing: the API serves an absent one as
 * empty or false. Neither is a field of a {@link ReferenceStrategy.local local}
 * lookup’s target: the API relaxes `required` there, because a referrer
 * states only what it knows about the endpoint.
 */
export function missingRequiredFields(
  document: ProjectedNode,
  searchType: SearchType,
  schema?: SearchSchema,
): readonly string[] {
  const missing = new Set<string>();
  for (const field of searchType.fields) {
    if (isInternalField(field)) {
      continue;
    }
    if (
      field.required === true &&
      field.array !== true &&
      field.kind !== 'boolean' &&
      !hasValue(document, field, searchType)
    ) {
      missing.add(field.name);
    }
    const referenceType =
      schema !== undefined &&
      field.kind === 'reference' &&
      field.ref?.strategy === 'inline'
        ? referenceTypeNamed(schema, field.ref.typeName)
        : undefined;
    const nested = document[field.name];
    if (referenceType === undefined || nested === undefined) {
      continue;
    }
    for (const referent of Array.isArray(nested) ? nested : [nested]) {
      for (const name of missingRequiredFields(
        referent as ProjectedNode,
        referenceType,
        schema,
      )) {
        missing.add(`${field.name}.${name}`);
      }
    }
  }
  return [...missing];
}

/** Whether a projected document carries a value for `field`: for text, in any
 *  of the physical fields it spreads over – never in a sibling field whose
 *  name only looks like one of them (`title_short` beside `title`); for a
 *  lookup reading its literals as periods, a referent or a period. */
function hasValue(
  document: ProjectedNode,
  field: SearchField,
  searchType: SearchType,
): boolean {
  if (field.kind !== 'text') {
    const periods =
      literalKindOf(field) === 'period'
        ? physicalFields(field).period?.values
        : undefined;
    return (
      document[field.name] !== undefined ||
      (periods !== undefined && document[periods] !== undefined)
    );
  }
  const { search, sort } = physicalFields(field);
  return Object.keys(document).some(
    (key) =>
      document[key] !== undefined &&
      (search.includes(key) ||
        sort.includes(key) ||
        (displayLangOf(field, key) !== undefined &&
          fieldNamed(searchType, key) === undefined)),
  );
}

function applyField(
  document: ProjectedNode,
  node: FramedNode,
  field: SearchField,
  searchType: SearchType,
  schema: SearchSchema | undefined,
  context: ProjectionContext,
  sink: UnreadableSink,
  nested: boolean,
): void {
  const unread: Unread = (value) => sink(field.name, value);
  // The three value sources, mutually exclusive by declaration
  // (`validateSearchType`): a projection value, a computed value, a graph path.
  if (
    (field.kind === 'keyword' || field.kind === 'reference') &&
    field.from !== undefined
  ) {
    return applyProjectionValue(document, field, field.from, context, schema);
  }
  if (field.derive !== undefined) {
    const derived = field.derive(document, context);
    if (field.kind === 'period') {
      return setPeriod(
        document,
        field,
        derivedStrings(derived, unread),
        unread,
        nested,
      );
    }
    // A derived value is held to the same rule as a read one, through the same
    // reader: a derived `reference` stores a selection key the surface types
    // `IRI` – ADR 21 sends an IRI-valued `keyword` derive here by converting it
    // to `reference`, so this is the busiest way a non-IRI could otherwise
    // reach the index – and a derived `integer` an int64.
    if (isReadKind(field.kind)) {
      return applyRead(
        document,
        field,
        field.kind,
        Array.isArray(derived) ? derived : [derived],
        unread,
      );
    }
    // A `keyword` or `text` field reads any value but NaN, which serializes as
    // `null` – stored by an engine as no value, or refused with the document.
    if (Number.isNaN(derived)) {
      unread('NaN');
    } else if (derived !== undefined) {
      document[field.name] = derived;
    }
    return;
  }
  if (field.path === undefined && field.name !== searchType.literalField) {
    // Neither path nor derive: populated outside the projection, if at all. A
    // pathless literal field is the exception: {@link literalReader} fills it
    // from a literal the reference reached, never from a node.
    return;
  }
  // The framed node is keyed by the {@link irAlias IR Alias} the extraction
  // CONSTRUCT minted, not by the source `path`: `path` states what to read from
  // the graph (the reader adapter’s grammar), the alias is what the reader
  // emitted it under. Minting against `searchType` – a root field against the
  // root type, an inline referent’s field against its reference type – is what
  // lets one subject be a root of two types without their fields colliding.
  const alias = irAlias(searchType, field);
  if (isInlineReference(field)) {
    // An inline reference is a nested structure, not a bare IRI: it can only be
    // projected with the schema that declares its reference type. Without one,
    // project nothing rather than fall through and emit the referent IRIs under
    // the field name (the wrong shape).
    if (schema !== undefined) {
      applyInlineReference(
        document,
        node,
        alias,
        field,
        schema,
        context,
        sink,
        nested,
      );
    }
    return;
  }
  // A `local` lookup stores nested documents too, shaped by the TARGET’s own
  // declaration rather than by a reference type – so an unidentified referent
  // is an entry like any other, minus its `id`. Same reason as above for
  // needing a schema: without one there is no target to project through.
  if (field.kind === 'reference' && schema !== undefined) {
    const localTargets = localLookupTargetsOf(field, schema);
    if (localTargets.length > 0) {
      const endpoints = applyNestedReferents(
        document,
        valuesOf(node, alias),
        field,
        localTargets,
        schema,
        context,
        sink,
      );
      // A `local` lookup stores an object, so its own id is a level deeper than
      // a filter can reach – an engine welds conditions on an entry's LEAF
      // fields only, and facets flat values. `filterable` and `facetable`
      // therefore fan out the id beside the object.
      applyLocalIdentity(document, endpoints, field, schema, nested);
      return;
    }
  }
  switch (field.kind) {
    case 'text':
      return applyText(document, langValuesOf(node, alias), field);
    case 'keyword':
      return applyFacet(document, literalsOf(node, alias), field, schema);
    case 'reference': {
      if (literalKindOf(field) === 'period') {
        return applyReferentsOrPeriods(
          document,
          valuesOf(node, alias),
          field,
          schema,
          unread,
          nested,
        );
      }
      return applyReferents(
        document,
        valuesOf(node, alias),
        field,
        schema,
        unread,
      );
    }
    case 'integer':
    case 'number':
    case 'date':
    case 'boolean':
      return applyRead(
        document,
        field,
        field.kind,
        literalsOf(node, alias),
        unread,
      );
    case 'period':
      return setPeriod(
        document,
        field,
        literalsOf(node, alias),
        unread,
        nested,
      );
  }
}

/**
 * Store what {@link readValue} reads of `values` as `kind`, reporting every
 * value it cannot. An `array` reference stores the list; every other kind is a
 * scalar in the engine, so it stores the first value read – and an unreadable
 * or blank value cannot cost the field a readable one behind it.
 */
function applyRead(
  document: ProjectedNode,
  field: SearchField,
  kind: ReadKind,
  values: readonly unknown[],
  unread: Unread,
): void {
  const read = values.flatMap((value) => {
    const reading = readValue(kind, value);
    if (reading === UNREADABLE) {
      unread(describeValue(value));
      return [];
    }
    return reading === undefined ? [] : [reading];
  });
  if (kind === 'date') {
    return setDate(document, field, read[0] as StoredDate | undefined);
  }
  if (kind === 'reference' && field.array === true) {
    document[field.name] = read;
  } else if (read.length > 0) {
    document[field.name] = read[0];
  }
}

/**
 * The values a non-inline reference stores: the referents’ IRIs, **or their
 * document keys** when the type the reference names declares a
 * {@link RootType.key}. A `lookup`’s `target` and an `idOnly`’s `labelSource`
 * both mean *this field holds ids of documents in that collection* (ADR 20) –
 * the fact a label lookup and a join rely on – so storing the node IRI where
 * the target keys on something else would break an invariant the schema already
 * has. Rewriting a reference is LDE keeping it, not a new rule.
 *
 * That is also why the boundary is *naming the target*: a reference that names
 * none ({@link labelSourceNameOf} → `undefined`) never claimed to hold a
 * collection’s ids, and a `derive`d one produces its own values rather than
 * reading a referent, so neither is re-keyed.
 *
 * The referent’s candidates are in the frame because framing already embeds a
 * referenced node’s own triples at one hop, and the extraction adds the key
 * field to that hop. A projection run without a `schema` cannot resolve the
 * target, so it leaves the values as they are – exactly as it leaves an inline
 * reference unprojected.
 *
 * The referring field’s own {@link ReferenceField.transform} still runs after
 * this, in {@link applyFacet}: a `transform` transforms what the field stores,
 * and for a keyed target that is the key. A `transform` written to repair the
 * referent’s node IRIs therefore sees a key instead, which is why the two are
 * worth declaring together only deliberately.
 */
function referenceValues(
  values: readonly unknown[],
  field: ReferenceField,
  schema: SearchSchema | undefined,
  targetsById: Map<string, RootType>,
  unread: Unread,
): readonly string[] {
  // A literal where a referent belongs states no IRI to store. A node without
  // one – a blank node – carries no value a publisher could look up, so only
  // literals are reported, and a blank one states nothing to correct.
  for (const value of values) {
    const literal =
      iriString(value) === undefined ? literalString(value) : undefined;
    if (literal !== undefined && literal.trim() !== '') {
      unread(literal);
    }
  }
  // Guaranteed declared: `searchSchema` validates that every named target
  // resolves, and the projection only ever runs against a type of its schema.
  const targets = referencedTargetsOf(field, schema);
  if (targets.length === 0) {
    return irisAmong(values);
  }
  return values
    .map((value) => {
      const iri = iriString(value);
      if (iri === undefined) {
        return undefined;
      }
      // Each referent is re-keyed through the target IT belongs to – the one
      // its `rdf:type` matches – so a person keyed on an authority IRI and an
      // organization keyed on nothing store, under one field, the ids their
      // own collections file them under.
      const target = targetOfReferent(value, targets);
      const keyed =
        target.key === undefined
          ? iri
          : documentKeyOf(
              target,
              iri,
              isObject(value)
                ? keyCandidatesOf(value, target, target.key.field)
                : [],
            );
      // Remembered only where there was a choice: a single-target reference
      // stays byte-identical to what it was, symbol keys included. Keyed by
      // what the field STORES – the value after its own `transform`, which
      // `applyFacet` applies before it reads this map.
      if (keyed !== undefined && targets.length > 1) {
        targetsById.set(
          field.transform === undefined ? keyed : field.transform(keyed),
          target,
        );
      }
      return keyed;
    })
    .filter((value): value is string => value !== undefined);
}

/** Store a non-inline reference’s referents: their ids, re-keyed through the
 *  targets they belong to ({@link referenceValues}), and every companion an
 *  id feeds. */
function applyReferents(
  document: ProjectedNode,
  values: readonly unknown[],
  field: ReferenceField,
  schema: SearchSchema | undefined,
  unread: Unread,
): void {
  const targetsById = new Map<string, RootType>();
  const ids = referenceValues(values, field, schema, targetsById, unread);
  rememberTargets(document, targetsById);
  applyFacet(document, ids, field, schema, targetsById);
}

/**
 * Store a lookup that reads its literals as periods
 * ({@link ReferenceStrategy.literal}): its referents as any lookup stores them,
 * and its literals as a `period` field stores its values, in the companions
 * {@link physicalFields} names for them.
 *
 * A single-valued field keeps the first value the graph carries that either
 * form can read, whichever form it is – so it holds one value, never one of
 * each. A literal no reader can parse does not count, exactly as a `period`
 * keeps its first readable value; a blank node carries no id, so it does not
 * count either.
 */
function applyReferentsOrPeriods(
  document: ProjectedNode,
  values: readonly unknown[],
  field: ReferenceField,
  schema: SearchSchema | undefined,
  unread: Unread,
  nested: boolean,
): void {
  const isReferent = (value: unknown) => iriString(value) !== undefined;
  const referents = values.filter(isReferent);
  const periods = readablePeriods(
    values
      .filter((value) => !isReferent(value))
      .map(literalString)
      .filter((value): value is string => value !== undefined),
    unread,
  );
  if (field.array === true) {
    applyReferents(document, referents, field, schema, unread);
    storePeriods(document, field, periods, nested);
    return;
  }
  const readable = new Set(periods.map(({ value }) => value));
  const first = values.find(
    (value) =>
      isReferent(value) || readable.has(literalString(value)?.trim() ?? ''),
  );
  if (first === undefined) {
    return;
  }
  if (isReferent(first)) {
    applyReferents(document, referents, field, schema, unread);
  } else {
    storePeriods(document, field, periods, nested);
  }
}

/**
 * The Root Type a framed referent belongs to, among the targets its reference
 * names: the first whose `class` is among the referent’s `rdf:type`s, which
 * the extraction emits and framing carries as `@type`; else the first target
 * declared. One target needs no evidence at all. This is the one reading of
 * *which of several targets is this*, so re-keying, the facet policy and the
 * stored discriminator ({@link TARGET_FIELD}) cannot disagree.
 */
function targetOfReferent(
  value: unknown,
  targets: readonly RootType[],
): RootType {
  if (targets.length === 1 || !isObject(value)) {
    return targets[0];
  }
  const classes = classesOf(value);
  return targets.find((target) => classes.has(target.class)) ?? targets[0];
}

/** The classes a framed node states it is an instance of: its `@type`, which
 *  framing gives as one IRI or a list – empty for a node stating none. */
function classesOf(value: Record<string, unknown>): ReadonlySet<string> {
  const raw = value['@type'];
  return new Set(
    (Array.isArray(raw) ? raw : [raw]).filter(
      (type): type is string => typeof type === 'string',
    ),
  );
}

/**
 * The targets the reference values of a projected node were resolved through,
 * by id – kept beside the node under a symbol, so it never reaches the
 * writer, for the one reader that needs it after projection: the identity
 * companion of an inline reference, which admits an entry’s id to a facet by
 * the policy of the target that id belongs to. Only a reference naming
 * several targets has anything to remember.
 */
const REFERENT_TARGETS: unique symbol = Symbol('referentTargets');

type WithReferentTargets = ProjectedNode & {
  [REFERENT_TARGETS]?: Map<string, RootType>;
};

function rememberTargets(
  document: ProjectedNode,
  targetsById: ReadonlyMap<string, RootType>,
): void {
  if (targetsById.size === 0) {
    return;
  }
  const node = document as WithReferentTargets;
  const remembered = (node[REFERENT_TARGETS] ??= new Map());
  for (const [id, target] of targetsById) {
    remembered.set(id, target);
  }
}

/**
 * Whether an id deserves a facet bucket, by the {@link FacetKeys facet policy}
 * of the target it belongs to: admitted where that target declares none, and
 * by its `only` where it does. `targetName` is the target the id was resolved
 * or stored against; an id whose target is unknown falls back to the first
 * declared, the same precedence every other reading of several targets uses.
 */
function admitsFacet(
  policies: ReadonlyMap<string, FacetKeys>,
  targets: readonly RootType[],
  targetName: string | undefined,
  id: string,
): boolean {
  // Policies are inherited from targets, so where any exists a target does.
  const policy = policies.get(targetName ?? targets[0].name);
  return policy === undefined || policy.only(id);
}

/**
 * Project a text field. **Display** (when `output`) preserves *every* language
 * present – one label per language, or every label of it for an `array` field
 * (accents preserved, untagged under `und`), stored `index: false` so extra
 * languages cost nothing – so a value in an undeclared language still renders
 * rather than collapsing to a bare IRI.
 * **Search** (folded, when `searchable`) and **sort** (folded primary, when
 * `sortable`) stay on the declared `locales`, which drive the indexed, stemmed,
 * weighted fanout; a value in an undeclared language is not indexed. Absent
 * languages emit nothing.
 *
 * The two companions differ in what an absent language means. A search query
 * fans out over *every* locale key at once, so a document titled in one
 * language is found whichever language the reader asks in. A sort names a
 * **single** key, so a locale key left empty is not “no value in Dutch” – it is
 * the empty string, which ties with every other document missing that language
 * and leaves them in relevance order. Each locale’s sort key therefore falls
 * back to the document’s first value in `locales` order: a collection of
 * untagged titles sorts by title in a Dutch request rather than not at all.
 * Ordering across languages is approximate by nature; a total order over the
 * titles a reader actually sees beats a partial one over the tagged few.
 */
function applyText(
  document: ProjectedNode,
  values: readonly LangValue[],
  field: TextField,
): void {
  if (field.output) {
    // Every present language lands as a display field (kept off the search
    // index), a language absent from `locales` included. `array` decides the
    // shape, as it does for every other kind: a declared list keeps every
    // value of a language, deduped; a single-valued field keeps the first.
    const valuesPerLang = new Map<string, string[]>();
    for (const { lang, value } of values) {
      if (value === '') {
        continue;
      }
      const langValues = valuesPerLang.get(lang);
      if (langValues === undefined) {
        valuesPerLang.set(lang, [value]);
      } else {
        langValues.push(value);
      }
    }
    for (const [lang, langValues] of valuesPerLang) {
      const name = displayFieldName(field, lang);
      if (field.array === true) {
        setArray(document, name, dedupe(langValues));
      } else {
        setString(document, name, langValues[0]);
      }
    }
  }
  // Empty `locales` is rejected at declaration time (`validateSearchType`);
  // here it simply indexes nothing.
  if (field.searchable !== undefined || field.sortable === true) {
    const names = physicalFields(field);
    // A literal lands under the declared locale its tag best matches as a
    // language range, so `nl-NL` titles are keyed under a declared `nl`; within
    // a locale, the exact tag comes first.
    const valuesPerLanguage = new Map<string, string[]>();
    for (const { lang, value } of values) {
      const languageValues = valuesPerLanguage.get(lang);
      if (languageValues === undefined) {
        valuesPerLanguage.set(lang, [value]);
      } else {
        languageValues.push(value);
      }
    }
    const languagesPerLocale = new Map<string, [string, string[]][]>();
    for (const entry of valuesPerLanguage) {
      const locale = matchLanguage(entry[0], field.locales)[0];
      if (locale !== undefined) {
        languagesPerLocale.set(locale, [
          ...(languagesPerLocale.get(locale) ?? []),
          entry,
        ]);
      }
    }
    const valuesPerLocale = field.locales.map((locale) => {
      const entries = languagesPerLocale.get(locale) ?? [];
      const ranked = matchLanguage(
        locale,
        entries.map(([language]) => language),
      );
      return entries
        .sort(([left], [right]) => ranked.indexOf(left) - ranked.indexOf(right))
        .flatMap(([, languageValues]) => languageValues);
    });
    // What every locale’s sort key falls back to: the document’s first value
    // in `locales` order, which is the declaration’s own statement of which
    // language stands in for the others.
    const fallbackSortValue = valuesPerLocale.find(
      (localeValues) => localeValues.length > 0,
    )?.[0];
    valuesPerLocale.forEach((localeValues, index) => {
      if (field.searchable !== undefined && localeValues.length > 0) {
        setString(
          document,
          names.search[index],
          foldedSearchValue(localeValues),
        );
      }
      if (field.sortable === true) {
        const sortValue = localeValues[0] ?? fallbackSortValue;
        if (sortValue !== undefined) {
          setString(document, names.sort[index], fold(sortValue));
        }
      }
    });
  }
}

/** The projection’s definition of a folded free-text search value. */
function foldedSearchValue(values: readonly string[]): string {
  return fold(values.join(' ')).trim();
}

/**
 * Project a faceted field: dedupe (after the optional transform), write the
 * value field, and – when `searchable` – its folded `${name}_search` companion.
 * `keyword` reads literals; `reference` reads IRIs (the caller passes the
 * already-read raw values).
 *
 * A reference inheriting a {@link FacetKeys facet policy} from the type it
 * names ({@link inheritedFacetPolicies}) also writes the `${name}_facet` companion
 * the engine facets instead of the field: the subset of **what the field
 * stores** that the policy admits. So it is written after the field’s own
 * `transform` and the IRI filter, from the same `values` – for a keyed target
 * those are already keys ({@link referenceValues}), which is what makes a
 * predicate over document keys the right shape. The field itself keeps every
 * value; only the facet narrows. An empty subset writes nothing, exactly as a
 * path that matched nothing does.
 *
 * **`array` decides the shape**, as it does for every other kind: a declared
 * `array` field stores a list, and a single-valued one stores the first value –
 * the graph may still carry several, exactly as it may carry several literals
 * for a single-valued `integer` or `date` (which take the first too). Honouring
 * it here is what keeps the projection, the engine collection definition
 * (`string` vs `string[]`) and the API output type saying the same thing about
 * one declaration; a list written into a single-valued field is a document the
 * engine rejects, or – where it does not type-check, as inside a nested
 * document – a value the API cannot serialize.
 */
function applyFacet(
  document: ProjectedNode,
  raw: readonly string[],
  field: KeywordField | ReferenceField,
  schema: SearchSchema | undefined,
  targetsById?: ReadonlyMap<string, RootType>,
): void {
  // A `reference` stores identity, so what it stores must be an IRI whatever
  // route the value arrived by. {@link iriString} guards the graph path, but a
  // `transform` runs after it and a `from` projection value never passes it at
  // all – so both are checked here, at the one point they share. Without this
  // the surface would promise `IRI` over a value the projection let through.
  const referenced = field.kind === 'reference';
  const transformed = field.transform ? raw.map(field.transform) : raw;
  const values = dedupe(
    referenced ? transformed.filter(isAbsoluteIri) : transformed,
  );
  const folded = dedupe(values.map((value) => fold(value)));
  const names = physicalFields(field, schema);
  const searchField = names.search[0];
  const policies = inheritedFacetPolicies(field, schema);
  const inherited = policies.size > 0;
  // `names.facet` is the companion exactly when a policy is inherited –
  // physicalFields reads the same `inheritedFacetPolicies`.
  const facetField = names.facet as string;
  // The companion is a subset of what the field STORES – for a single-valued
  // field its first value, not the first admitted of all of them, or the facet
  // would count a value no filter on the field can reproduce.
  const stored = field.array === true ? values : values.slice(0, 1);
  const targets = referencedTargetsOf(field, schema);
  const admitted = !inherited
    ? []
    : stored.filter((id) =>
        admitsFacet(policies, targets, targetsById?.get(id)?.name, id),
      );
  if (field.array === true) {
    setArray(document, field.name, stored);
    if (field.searchable) {
      setArray(document, searchField, folded);
    }
    if (inherited) {
      setArray(document, facetField, admitted);
    }
    return;
  }
  setString(document, field.name, stored[0]);
  if (field.searchable) {
    setString(document, searchField, folded[0]);
  }
  if (inherited) {
    setString(document, facetField, admitted[0]);
  }
}

/**
 * Project a field declared over a {@link ProjectionContext} value: read the
 * value the run carries and write it exactly as a graph-read one, through
 * {@link applyFacet} – so `array`, `transform` and the folded `searchable`
 * companion mean the same thing for a declaration over the dataset as for one
 * over a path, and the collection definition needs no special case.
 *
 * A value the context does not carry writes nothing: a projection run outside a
 * pipeline (a test, a one-off) leaves the field absent rather than inventing a
 * placeholder, the same as a `path` that matched nothing.
 */
function applyProjectionValue(
  document: ProjectedNode,
  field: KeywordField | ReferenceField,
  from: ProjectionValue,
  context: ProjectionContext,
  schema: SearchSchema | undefined,
): void {
  // `ProjectionContext` is keyed by `ProjectionValue`, so the declaration reads
  // the context directly: a projection value that has no context key, or a
  // context key no declaration can name, is a compile error rather than a
  // silently unpopulated field.
  const value = context[from];
  applyFacet(document, value === undefined ? [] : [value], field, schema);
}

/**
 * Project an inline reference: the referent node(s) embedded under the field’s
 * {@link irAlias IR Alias} are each projected through the reference’s
 * {@link ReferenceType} (whose own fields read their own aliases, minted against
 * the reference type) and attached under the field’s name – a nested
 * {@link ProjectedNode} for a single reference, an array for an `array` one.
 * A referent needs **no identity**: nesting carries its fields, not a document
 * key, so a blank-node referent – whose `@id` JSON-LD 1.1 framing prunes when its
 * label occurs once – nests exactly like a named one. Neither leaves the
 * projection with an `id`: a Reference Type is kept in no collection, so
 * nothing resolves an entry by key. A named referent carries its IRI as a
 * non-enumerable `id` only while derives run ({@link documentIdOf}).
 * The referent is projected in full – internal fields included – so the
 * declaring type’s (or the reference type’s own) derives can read them;
 * {@link pruneInternalFields} then removes the internal fields from a *surfaced*
 * referent and deletes an internal inline reference whole. Recurses through
 * `schema`, so an inline reference may itself carry further inline references to
 * the schema’s declared depth. The referent type is guaranteed declared by
 * {@link searchSchema}.
 */
function applyInlineReference(
  document: ProjectedNode,
  node: FramedNode,
  alias: string,
  field: ReferenceField & { readonly ref: { readonly typeName: string } },
  schema: SearchSchema,
  context: ProjectionContext,
  sink: UnreadableSink,
  nested: boolean,
): void {
  // Resolves for a schema that declares the referent (always so for the schema a
  // type is projected through); a type framed against a foreign schema that
  // omits it simply contributes no nesting.
  const referenceType = referenceTypeNamed(schema, field.ref.typeName);
  if (referenceType === undefined) {
    return;
  }
  const asEdge = edgeReader(referenceType, field.ref.identity);
  const asLiteralEntry = literalReader(referenceType);
  const referents = applyNestedReferents(
    document,
    valuesOf(node, alias).map(
      (value) => asLiteralEntry(value) ?? asEdge(value),
    ),
    field,
    [referenceType],
    schema,
    context,
    sink,
  );
  applyNarrowedFacet(document, referents, field, schema, nested);
}

/**
 * Read each framed node an inline reference reached as an **edge**: unchanged
 * where the Reference Type declares no {@link ReferenceType.edgeClass edge
 * class} or the node is of it, and otherwise the endpoint the graph pointed at
 * directly, wrapped in an edge carrying it under the identity field alone – so
 * a flat statement and a qualified one project through one path.
 *
 * None of the node’s other values are carried over: read off an endpoint, the
 * edge’s own fields describe the endpoint rather than the edge – a role read
 * from `schema:name` would be the agent’s name.
 */
function edgeReader(
  referenceType: ReferenceType,
  identity: string | undefined,
): (value: unknown) => unknown {
  const endpointField = endpointFieldOf(referenceType, identity);
  if (endpointField === undefined) {
    return (value) => value;
  }
  const endpointAlias = irAlias(referenceType, endpointField);
  return (value) =>
    // Only a node can be an endpoint: anything else is left for the
    // projection to discard, as it would be without an edge class – unless
    // {@link literalReader}, which runs first, read it as a literal entry.
    !isObject(value) || classesOf(value).has(referenceType.edgeClass as string)
      ? value
      : { [endpointAlias]: [value] };
}

/**
 * Read a **literal** an inline reference reached in place of a node as an entry
 * carrying it under the Reference Type’s
 * {@link ReferenceType.literalField literal field} alone – so a value the graph
 * states bare and one it states on a node project through one path. Returns
 * `undefined` for anything that is not a literal, and for every value where the
 * type declares no literal field, leaving it to {@link edgeReader}.
 */
function literalReader(
  referenceType: ReferenceType,
): (value: unknown) => FramedNode | undefined {
  const field =
    referenceType.literalField === undefined
      ? undefined
      : fieldNamed(referenceType, referenceType.literalField);
  if (field === undefined) {
    return () => undefined;
  }
  const literalAlias = irAlias(referenceType, field);
  return (value) =>
    literalString(value) === undefined
      ? undefined
      : { [literalAlias]: [value] };
}

/**
 * Write the narrowed facet companion of an inline reference naming an
 * {@link ReferenceStrategy.identity identity}, where its target declares a
 * {@link FacetKeys facet policy}: the admitted ids its entries reference,
 * flattened out of the nested documents just projected. Nothing to write
 * otherwise – the engine filters and facets the identity’s leaf inside each
 * entry, which the entries already hold ({@link physicalFields}).
 *
 * Harvested from the entries rather than read from a second path, so what the
 * companion holds is exactly what the entries hold – including the re-keying
 * the nested reference already applied, which a separately-read path would have
 * to repeat and could get wrong.
 *
 * The identity field stores either bare ids or, when it is a
 * {@link ReferenceStrategy.local local} lookup, nested documents carrying an
 * `id`. Both are read here, because which one a deployment declares is about
 * how much of the referent it wants to display – not about what identifies it.
 */
function applyNarrowedFacet(
  document: ProjectedNode,
  referents: readonly ProjectedNode[],
  field: ReferenceField,
  schema: SearchSchema,
  nested: boolean,
): void {
  const names = physicalFields(field, schema);
  if (nested || names.facet === undefined || names.facet === names.filter) {
    return;
  }
  const identity = (field.ref as { readonly identity: string }).identity;
  // Only the entries the document actually STORES: a single-valued reference
  // keeps the first referent and drops the rest, and a companion holding an id
  // from a dropped one would match a filter whose hit shows no such entry.
  const stored = field.array === true ? referents : referents.slice(0, 1);
  // Each id with the target it was resolved through, for the facet policy
  // below: a stored endpoint says so itself ({@link TARGET_FIELD}), a bare id
  // was remembered when the entry was projected ({@link rememberTargets}).
  const targetById = new Map<string, string | undefined>();
  for (const referent of stored) {
    const remembered = (referent as WithReferentTargets)[REFERENT_TARGETS];
    // Single-valued: the identity field is `filterable`, and a filterable
    // nested field states one value per entry.
    const value = referent[identity];
    const id = identityValue(value);
    if (id === undefined || targetById.has(id)) {
      continue;
    }
    targetById.set(
      id,
      isObject(value) && typeof value[TARGET_FIELD] === 'string'
        ? value[TARGET_FIELD]
        : remembered?.get(id)?.name,
    );
  }
  writeNarrowedFacet(
    document,
    names,
    targetById,
    field,
    referencedTargetsOf(identityFieldOf(field, schema) as SearchField, schema),
    schema,
    nested,
  );
}

/**
 * Write a local lookup’s identity companion under the arity of the reference it
 * belongs to – `array` decides the shape here exactly as it does for every
 * other kind ({@link applyFacet}).
 *
 * It matters most where the companion is a **nested** leaf. That is the field a
 * weld actually names – the endpoint's own id is a level deeper than a weld can
 * reach – and a weld asks whether ONE entry satisfies every condition. A
 * companion holding a list inside an entry stands for each of its ids at once,
 * so the entry answers the weld with none of them; a Typesense 30.2 engine does
 * not answer at all, and hangs (ADR 26). The entry fans out instead
 * ({@link tuplesOf}), which leaves exactly one id per entry for this to write.
 *
 * A top-level companion is unaffected: it is a flat field standing for the whole
 * document rather than for one entry, so an `array` reference's companion holds
 * every id its entries reference, as it always has.
 */
function setIdentity(
  document: ProjectedNode,
  name: string,
  ids: readonly string[],
  field: ReferenceField,
  nested: boolean,
): void {
  // `filterable` is the whole condition: only a `filterable` reference has a
  // weld to serve, and {@link tuplesOf} splits only `filterable` fields, so
  // only there does an entry hold the single id the narrower declared type
  // matches. A `facetable`-only companion stays a list, which a facet reads.
  if (!nested || field.array === true || field.filterable !== true) {
    setArray(document, name, ids);
    return;
  }
  setString(document, name, ids[0]);
}

/**
 * Write the identity companion of a {@link ReferenceStrategy.local local}
 * lookup: the ids of the endpoints just stored, under the flat physical name an
 * engine filters and facets on ({@link physicalFields}) – plus, where a target
 * declares a facet policy, the narrowed companion the facet reads instead.
 *
 * Nothing to do where the field is neither `filterable` nor `facetable`:
 * without either Role there is no companion, and the endpoint is display
 * weight like every other nesting.
 */
function applyLocalIdentity(
  document: ProjectedNode,
  endpoints: readonly ProjectedNode[],
  field: ReferenceField,
  schema: SearchSchema,
  nested: boolean,
): void {
  const names = physicalFields(field, schema);
  if (names.identity === undefined) {
    return;
  }
  // Only the endpoints the field actually STORES: a single-valued reference
  // keeps the first and drops the rest, and a companion holding an id from a
  // dropped one would match a filter whose hit shows a different endpoint.
  const stored = field.array === true ? endpoints : endpoints.slice(0, 1);
  // Each id with the target it was projected through, for the facet policy
  // below: a lookup naming several targets says so on the endpoint
  // ({@link TARGET_FIELD}); one naming a single target leaves it unsaid.
  const targetById = new Map<string, string | undefined>();
  for (const endpoint of stored) {
    if (typeof endpoint.id !== 'string' || targetById.has(endpoint.id)) {
      continue;
    }
    const target = endpoint[TARGET_FIELD];
    targetById.set(
      endpoint.id,
      typeof target === 'string' ? target : undefined,
    );
  }
  const ids = [...targetById.keys()];
  if (ids.length === 0) {
    return;
  }
  setIdentity(document, names.identity, ids, field, nested);
  writeNarrowedFacet(
    document,
    names,
    targetById,
    field,
    referencedTargetsOf(field, schema),
    schema,
    nested,
  );
}

/**
 * Write the narrowed facet companion of a local lookup or an inline reference’s
 * identity, where a target declares a facet policy: the admitted ids, each
 * judged by the target it was resolved through – the same rule as every other
 * facetable reference, so an excluded id is never seen by the engine rather
 * than merely unlabelled. Nothing to write without a policy, where the facet
 * reads the filter field itself.
 *
 * Written at the top level only: the companion counts root documents, so no
 * collection declares one inside an entry for it to fill.
 */
function writeNarrowedFacet(
  document: ProjectedNode,
  names: PhysicalFields,
  targetById: ReadonlyMap<string, string | undefined>,
  field: ReferenceField,
  targets: readonly RootType[],
  schema: SearchSchema,
  nested: boolean,
): void {
  if (nested || names.facet === undefined || names.facet === names.filter) {
    return;
  }
  const policies = inheritedFacetPolicies(field, schema);
  setArray(
    document,
    names.facet,
    [...targetById.keys()].filter((id) =>
      admitsFacet(policies, targets, targetById.get(id), id),
    ),
  );
}

/** The id a value under an identity field carries: the value itself when the
 *  field stores bare ids, its `id` when it stores nested documents. */
function identityValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const id = isObject(value) ? value.id : undefined;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Project raw framed values as nested document(s) of `nestedType` and attach
 * them under the field’s name – the shared body of an inline reference and a
 * {@link ReferenceStrategy.local local} lookup, which differ only in which type
 * shapes the referent: a declared Reference Type for the one, the lookup’s own
 * target Root Type for the other. Sharing it is what makes the two reconstruct
 * through one path, so a consumer cannot tell a nested referent from a resolved
 * one.
 *
 * Projecting through a Root Type also gives a `local` referent its `id` for
 * free, re-keyed through that type’s {@link RootType.key} exactly as a
 * top-level document of that type would be – so the stored id is the one the
 * target’s collection files it under, and the lookup can find it.
 */
function applyNestedReferents(
  document: ProjectedNode,
  values: readonly unknown[],
  field: ReferenceField,
  nestedTypes: readonly SearchType[],
  schema: SearchSchema,
  context: ProjectionContext,
  sink: UnreadableSink,
): readonly ProjectedNode[] {
  // One node may stand for several entries: a weldable leaf is single-valued,
  // so an edge the graph gave several roles or several endpoints fans out into
  // one entry per combination BEFORE it is projected (ADR 26).
  const referents = values
    .filter(isObject)
    .flatMap((value) => {
      // A lookup naming several targets projects each referent through the
      // one it belongs to, and stores which – so an engine adapter can read
      // an entry no collection answers for through the right declaration.
      const nestedType =
        nestedTypes.length === 1
          ? nestedTypes[0]
          : targetOfReferent(value, nestedTypes as readonly RootType[]);
      // Every tuple of a node carries the node’s other values, so each value
      // is reported once per node, not once per tuple it was copied into.
      let reported: Set<string> | undefined;
      const nestedSink: UnreadableSink = (name, value) => {
        const key = JSON.stringify([name, value]);
        if (!(reported ??= new Set()).has(key)) {
          reported.add(key);
          sink(`${field.name}.${name}`, value);
        }
      };
      return tuplesOf(value, nestedType, field).map((tuple) => {
        const projected = projectFields(
          tuple,
          nestedType,
          schema,
          context,
          nestedSink,
          true,
        );
        if (nestedTypes.length > 1 && Object.keys(projected).length > 0) {
          projected[TARGET_FIELD] = nestedType.name;
        }
        return projected;
      });
    })
    // Fields, not identity, are what makes something a referent: a literal
    // value object under the alias (dirty source data), or a node this
    // reference type reads nothing from, projects nothing and is no referent.
    // Nesting it would hand the writer a content-free document – and, for a
    // single-valued reference, let it win the slot over a real referent.
    .filter((referent) => Object.keys(referent).length > 0);
  // Fan-out splits RAW framed values, and two distinct ones can still collapse
  // downstream – a `transform` mapping two spellings onto one canonical value,
  // or a keyed target re-keying two referent IRIs to the same document key. The
  // pre-fan-out shape deduped, because those values met inside one entry and
  // `applyFacet` deduped them there; split across entries they would reach the
  // index and the API as byte-identical duplicates instead. The `id` is part
  // of the key even where it is not enumerable: two named referents with the
  // same fields are two IRIs a derive on the referrer may want, so they stay
  // apart until {@link pruneInternalFields} drops a Reference Type entry’s `id`
  // and dedupes what is left.
  const distinct = dedupeBy(referents, (referent) =>
    JSON.stringify([referent.id, referent]),
  );
  if (distinct.length === 0) {
    return distinct;
  }
  document[field.name] = field.array === true ? distinct : distinct[0];
  return distinct;
}

/**
 * Split one framed edge node into the entries it stands for: the cartesian
 * product of its **weldable** leaves’ values, one value each.
 *
 * A weld asks whether ONE entry satisfies every condition, so a leaf a weld can
 * name (`filterable` – `searchSchema` refuses `array` on one) states a single
 * value. An edge the graph gave two roles and two endpoints is therefore four
 * entries rather than one entry holding two lists, which stands for all four at
 * once and answers the weld with none of them. See
 * [ADR 26](../../docs/decisions/0026-fan-out-a-qualified-edge-into-one-entry-per-tuple.md).
 *
 * Done on the **framed node**, before projection, so each leaf reaches
 * {@link applyField} single-valued and passes through `transform`, folding and
 * the facet companion exactly as a single-valued field always has – no
 * downstream step learns that fan-out happened. Only the weldable aliases are
 * split: an `output`-only leaf keeps its list, because nothing welds it, and it
 * is shared unchanged across the entries the node fans out to.
 *
 * Inline references only. A {@link ReferenceStrategy.local local} lookup runs
 * through this same body but nests the endpoint’s **own Root Type**, whose
 * fields are multi-valued for reasons of their own – fanning one out would
 * split a person across their `sameAs` values. What a weld names there is the
 * flat `${name}_id` companion, which {@link applyLocalIdentity} already writes
 * beside the object.
 *
 * **Unbounded, deliberately and only for now.** The product grows with the
 * edge's own values, which ADR 12 says is no bound at all. The bound belongs
 * where the data enters memory – the CONSTRUCT already paid for those values,
 * the subject index already holds them, and the framed node already
 * materialised them – not here, at the last and cheapest step to skip. See
 * [#826](https://github.com/ldelements/lde/issues/826).
 */
function tuplesOf(
  node: FramedNode,
  nestedType: SearchType,
  field: ReferenceField,
): readonly FramedNode[] {
  if (!isInlineReference(field)) {
    return [node];
  }
  // `filterable` names the leaves a weld can condition on directly – the
  // reference's `identity` field among them, which must be filterable.
  const weldable = nestedType.fields
    .filter((nested) => nested.filterable === true)
    .map((nested) => irAlias(nestedType, nested))
    // A leaf the frame carries at most one value for is already a tuple
    // position; splitting it would copy the node to no purpose.
    .filter((alias) => valuesOf(node, alias).length > 1);
  if (weldable.length === 0) {
    return [node];
  }
  let tuples: FramedNode[] = [node];
  for (const alias of weldable) {
    const values = valuesOf(node, alias);
    tuples = tuples.flatMap((tuple) =>
      values.map((value) => ({ ...tuple, [alias]: value })),
    );
  }
  return tuples;
}

// --- Framed-IR readers: read a field’s value off the framed node by its
// {@link irAlias IR Alias} key. Internal to projection – a `derive` reads the
// projected document, never the node, so `path` stays the whole statement of
// what the projection reads from the graph, and the alias the whole statement of
// what the reader emitted it under.

/** A literal value with its (possibly empty) language tag. */
interface LangValue {
  readonly value: string;
  readonly lang: string;
}

function langValuesOf(node: FramedNode, key: string): LangValue[] {
  return valuesOf(node, key)
    .map(toLangValue)
    .filter((value): value is LangValue => value !== undefined);
}

function literalsOf(node: FramedNode, key: string): string[] {
  return valuesOf(node, key)
    .map(literalString)
    .filter((value): value is string => value !== undefined);
}

function irisOf(node: FramedNode, key: string): string[] {
  return irisAmong(valuesOf(node, key));
}

function irisAmong(values: readonly unknown[]): string[] {
  return values
    .map(iriString)
    .filter((value): value is string => value !== undefined);
}

function valuesOf(node: FramedNode, key: string): unknown[] {
  const value = node[key];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function toLangValue(value: unknown): LangValue | undefined {
  const literal = literalString(value);
  if (literal === undefined) {
    return undefined;
  }
  // Untagged literals (JSON-LD @none) land in the reserved `und` locale.
  // Normalise the tag to its BCP-47 shape: `_` is the reserved separator in the
  // physical/display field naming, so a non-conformant `pt_BR` tag becomes
  // `pt-BR`, which round-trips through display and matches a declared locale
  // instead of being silently dropped.
  const rawLang =
    isObject(value) && typeof value['@language'] === 'string'
      ? value['@language']
      : 'und';
  return { value: literal, lang: rawLang.replace(/_/g, '-') };
}

function literalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (isObject(value)) {
    const inner = value['@value'];
    if (typeof inner === 'string') {
      return inner;
    }
    if (typeof inner === 'number' || typeof inner === 'boolean') {
      return String(inner);
    }
  }
  return undefined;
}

/**
 * The IRI a reference value carries, or `undefined` when it carries none. A
 * value may arrive as a bare string – `schema:sameAs`, `contentUrl`,
 * `thumbnailUrl` and `landingPage` all range on `schema:URL`, which a source may
 * emit as a literal rather than a node – or as a node object.
 *
 * **A referent with no IRI yields nothing**, the same rule {@link documentKey}
 * applies to a root and for the same reason: what a `labelOnly`/`idOnly`
 * reference stores is a selection key, and a blank node label is not one.
 * Framing mints it per call, so it recurs across documents and changes when
 * unrelated triples do – indexing it would key a facet bucket on a value that
 * neither groups what is equal nor separates what is not. An **inline**
 * reference is untouched by this: it carries the referent’s fields rather than
 * its identity ({@link applyInlineReference}), so a blank-node referent nests
 * exactly as before.
 */
function iriString(value: unknown): string | undefined {
  const iri = isObject(value) ? value['@id'] : value;
  return typeof iri === 'string' && isAbsoluteIri(iri) ? iri : undefined;
}

/** Store a `date` field’s seconds, and its precision in the companion beside
 *  them ({@link physicalFields}), so the surface can serve the value in the
 *  form its source gave. */
function setDate(
  document: ProjectedNode,
  field: SearchField,
  stored: StoredDate | undefined,
): void {
  if (stored === undefined) {
    return;
  }
  document[field.name] = stored.seconds;
  document[physicalFields(field).precision as string] = stored.precision;
}

/**
 * Store a `period` field: the values that state a period, as stated but for
 * surrounding whitespace, under the field’s own name (a lookup’s
 * `${name}_literal` companion), for output, and the stretch they cover between
 * them in the bound companions ({@link physicalFields}). A value that states no period –
 * `onbekend`, `1987/1897` – is reported and left out, so every value served is
 * the EDTF its scalar promises; a deployment that wants to show such text
 * declares a `keyword` field over the same path.
 *
 * Blank and unreadable values are dropped before a single-valued field keeps
 * its first, so neither can cost the field the period behind it; and the
 * bounds are taken from exactly the values stored, so what is served and what
 * is filtered cannot disagree.
 */
function setPeriod(
  document: ProjectedNode,
  field: SearchField,
  values: readonly string[],
  unread: Unread,
  nested: boolean,
): void {
  storePeriods(document, field, readablePeriods(values, unread), nested);
}

/** The values a reader can parse as periods, trimmed and deduplicated in the
 *  order stated, each with the stretch it covers; every other non-blank value
 *  is reported. */
function readablePeriods(
  values: readonly string[],
  unread: Unread,
): readonly { readonly value: string; readonly period: StoredPeriod }[] {
  return dedupe(values.map((value) => value.trim())).flatMap((value) => {
    if (value === '') {
      return [];
    }
    const period = periodOf(value);
    if (period === undefined) {
      unread(value);
      return [];
    }
    return [{ value, period }];
  });
}

/** Store readable periods ({@link readablePeriods}) – the first alone for a
 *  single-valued field – and, outside a nested entry, the stretch they cover
 *  between them. No filter or sort reaches a nested period, so an entry stores
 *  its values alone. */
function storePeriods(
  document: ProjectedNode,
  field: SearchField,
  readable: readonly {
    readonly value: string;
    readonly period: StoredPeriod;
  }[],
  nested: boolean,
): void {
  const stated = field.array === true ? readable : readable.slice(0, 1);
  // Named for every field that stores periods: a `period`, and a lookup
  // reading its literals as periods.
  const companions = physicalFields(field).period;
  if (stated.length === 0 || companions === undefined) {
    return;
  }
  document[companions.values] =
    field.array === true ? stated.map(({ value }) => value) : stated[0].value;
  if (nested) {
    return;
  }
  const [first, ...rest] = stated.map(({ period }) => period);
  const covered = periodCovering(first, ...rest);
  document[companions.start] = covered.start;
  document[companions.end] = covered.end;
}

/** A derive’s value as the strings a `period` reads: one string or number,
 *  or those in a list. A number is Unix seconds, as a `date` derive’s is, and
 *  is stored as the instant it names (`1970-01-01T00:00:42Z`). `null` and
 *  `undefined` state no value; anything else is reported. */
function derivedStrings(derived: unknown, unread: Unread): readonly string[] {
  const values = Array.isArray(derived) ? derived : [derived];
  return values.flatMap((value) => {
    if (typeof value === 'string') {
      return [value];
    }
    const seconds =
      typeof value === 'number'
        ? storableUnixSeconds(Math.trunc(value))
        : undefined;
    if (seconds !== undefined) {
      return [unixSecondsToIso(seconds, 'dateTime')];
    }
    if (value !== undefined && value !== null) {
      unread(describeValue(value));
    }
    return [];
  });
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Keep the first of each distinct `key`, in order. */
function dedupeBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
}

function setString(
  document: ProjectedNode,
  field: string,
  value: string | undefined,
): void {
  if (value !== undefined && value !== '') {
    document[field] = value;
  }
}

function setArray(
  document: ProjectedNode,
  field: string,
  values: readonly string[],
): void {
  if (values.length > 0) {
    document[field] = values;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a field reports a value it could not read: the field’s name, prefixed
 *  with its parents’ for a nested referent, and the value. */
type UnreadableSink = (field: string, value: string) => void;

/** Where one field reports a value it could not read. */
type Unread = (value: string) => void;

/** The sink a root document’s fields report to: the context’s
 *  {@link ProjectionContext.onUnreadable}, told which node the value was
 *  dropped from. */
function unreadableSink(
  context: ProjectionContext,
  id: string,
): UnreadableSink {
  const { onUnreadable } = context;
  return onUnreadable === undefined
    ? ignoreUnreadable
    : (field, value) => onUnreadable({ field, value, id });
}

function ignoreUnreadable(): void {
  // Nobody asked for the report.
}
