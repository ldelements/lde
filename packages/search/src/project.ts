import type { Quad } from '@rdfjs/types';
import { fold } from '@lde/text-normalization';
import {
  buildSubjectIndex,
  frameSubjects,
  type FramedNode,
} from './frame-by-type.js';
import {
  assertTypeInSchema,
  DEFAULT_MAX_ENTRIES,
  displayFieldName,
  documentKeyOf,
  fieldNamed,
  inheritedFacetKeys,
  inlineFramingDepth,
  irAlias,
  isAbsoluteIri,
  isInternalField,
  isInlineReference,
  isoToUnixSeconds,
  labelSourceNameOf,
  localLookupTypeOf,
  physicalFields,
  referenceTypeNamed,
  rootTypeNamed,
  type KeywordField,
  type ProjectionValue,
  type ReferenceField,
  type RootType,
  type SearchField,
  type SearchSchema,
  type SearchType,
  type TextField,
} from './schema.js';

/**
 * A projected node: the fields of one {@link SearchType}, flat. A root always
 * carries the `id` that keys it – it is a {@link SearchDocument} – but an inline
 * referent carries one only when the referent is a named node: a nested document
 * is not a document key, so nesting needs the referent’s fields, not its
 * identity.
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
  if (documentKey(node) === undefined) {
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
 */
function pruneInternalFields(
  document: ProjectedNode,
  searchType: SearchType,
  schema: SearchSchema | undefined,
): void {
  for (const field of searchType.fields) {
    if (isInternalField(field)) {
      delete document[field.name];
      continue;
    }
    if (schema === undefined || field.kind !== 'reference') {
      continue;
    }
    const nestedType =
      field.ref?.strategy === 'inline'
        ? referenceTypeNamed(schema, field.ref.typeName)
        : localLookupTypeOf(field, schema);
    const nested = document[field.name];
    if (nestedType === undefined || nested === undefined) {
      continue;
    }
    for (const referent of Array.isArray(nested) ? nested : [nested]) {
      pruneInternalFields(referent as ProjectedNode, nestedType, schema);
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
): ProjectedNode {
  const id = documentIdOf(node, searchType);
  const document: ProjectedNode = id === undefined ? {} : { id };
  for (const field of searchType.fields) {
    applyField(document, node, field, searchType, schema, context);
  }
  return document;
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

function applyField(
  document: ProjectedNode,
  node: FramedNode,
  field: SearchField,
  searchType: SearchType,
  schema: SearchSchema | undefined,
  context: ProjectionContext,
): void {
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
    // A derived `reference` is held to the same rule as a read one: what it
    // stores is a selection key, and the surface types it `IRI`. ADR 21 sends
    // an IRI-valued `keyword` derive here by converting it to `reference`, so
    // this is the busiest way a non-IRI could otherwise reach the index. A
    // value that survives nothing leaves the field absent, exactly as a derive
    // returning `undefined` does.
    const value =
      field.kind === 'reference' && derived !== undefined
        ? derivedIris(derived)
        : // A derived `date` goes through the same storage codec as a read one:
          // the field is stored as Unix seconds, so an ISO string returned here
          // would otherwise land as a string in an int64 field.
          field.kind === 'date' && typeof derived === 'string'
          ? isoToUnixSeconds(derived)
          : // A derive that computed seconds itself returns a number, which the
            // codec never saw and so never range-checked. Seconds outside what
            // `Date` can represent – reachable now that deep time is – would
            // store fine and then throw on every read at the surface, where an
            // unparseable string merely leaves the field absent. Drop it too.
            field.kind === 'date' && typeof derived === 'number'
            ? storableSeconds(derived)
            : derived;
    // NaN is not a value any kind stores, and a derive is the only route that
    // can produce one (`setNumber` guards the read route). It serializes as
    // `null`, which an engine rejects for a numeric field – so drop it, leaving
    // the field absent as an unparseable string already does.
    if (value !== undefined && !Number.isNaN(value)) {
      document[field.name] = value;
    }
    return;
  }
  if (field.path === undefined) {
    // Neither path nor derive: populated outside the projection, if at all.
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
        searchType.class === undefined,
      );
    }
    return;
  }
  // A `local` lookup stores nested documents too, shaped by the TARGET’s own
  // declaration rather than by a reference type – so an unidentified referent
  // is an entry like any other, minus its `id`. Same reason as above for
  // needing a schema: without one there is no target to project through.
  if (field.kind === 'reference' && schema !== undefined) {
    const localType = localLookupTypeOf(field, schema);
    if (localType !== undefined) {
      const endpoints = applyNestedReferents(
        document,
        valuesOf(node, alias),
        field,
        localType,
        schema,
        context,
      );
      // A `local` lookup stores an object, so its own id is a level deeper than
      // a filter can reach – an engine welds conditions on an entry's LEAF
      // fields only. `filterable` therefore fans out the id beside the object,
      // exactly as an inline reference's identity companion does.
      applyLocalIdentity(
        document,
        endpoints,
        field,
        schema,
        searchType.class === undefined,
      );
      return;
    }
  }
  switch (field.kind) {
    case 'text':
      return applyText(document, langValuesOf(node, alias), field);
    case 'keyword':
      return applyFacet(document, literalsOf(node, alias), field, schema);
    case 'reference':
      return applyFacet(
        document,
        referenceValues(node, alias, field, schema),
        field,
        schema,
      );
    case 'integer':
      return setNumber(
        document,
        field.name,
        toInteger(firstLiteralOf(node, alias)),
      );
    case 'number':
      return setNumber(
        document,
        field.name,
        toNumber(firstLiteralOf(node, alias)),
      );
    case 'date': {
      const literal = firstLiteralOf(node, alias);
      return setNumber(
        document,
        field.name,
        literal === undefined ? undefined : isoToUnixSeconds(literal),
      );
    }
    case 'boolean': {
      // The xsd:boolean lexical space: true/false/1/0.
      const literal = firstLiteralOf(node, alias);
      if (literal !== undefined) {
        document[field.name] = literal === 'true' || literal === '1';
      }
      return;
    }
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
  node: FramedNode,
  alias: string,
  field: ReferenceField,
  schema: SearchSchema | undefined,
): readonly string[] {
  const targetName = labelSourceNameOf(field);
  if (schema === undefined || targetName === undefined) {
    return irisOf(node, alias);
  }
  // Guaranteed declared: `searchSchema` validates that every named target
  // resolves, and the projection only ever runs against a type of its schema.
  const target = rootTypeNamed(schema, targetName) as RootType;
  if (target.key === undefined) {
    return irisOf(node, alias);
  }
  const keyFieldName = target.key.field;
  return valuesOf(node, alias)
    .map((value) => {
      const iri = iriString(value);
      return iri === undefined
        ? undefined
        : documentKeyOf(
            target,
            iri,
            isObject(value) ? keyCandidatesOf(value, target, keyFieldName) : [],
          );
    })
    .filter((value): value is string => value !== undefined);
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
    const valuesPerLocale = field.locales.map((locale) =>
      values
        .filter((value) => value.lang === locale)
        .map((value) => value.value),
    );
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
 * names ({@link inheritedFacetKeys}) also writes the `${name}_facet` companion
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
  const policy = inheritedFacetKeys(field, schema);
  // `names.facet` is the companion exactly when a policy is inherited –
  // physicalFields reads the same `inheritedFacetKeys`.
  const facetField = names.facet as string;
  // The companion is a subset of what the field STORES – for a single-valued
  // field its first value, not the first admitted of all of them, or the facet
  // would count a value no filter on the field can reproduce.
  const stored = field.array === true ? values : values.slice(0, 1);
  const admitted = policy === undefined ? [] : stored.filter(policy.only);
  if (field.array === true) {
    setArray(document, field.name, stored);
    if (field.searchable) {
      setArray(document, searchField, folded);
    }
    if (policy !== undefined) {
      setArray(document, facetField, admitted);
    }
    return;
  }
  setString(document, field.name, stored[0]);
  if (field.searchable) {
    setString(document, searchField, folded[0]);
  }
  if (policy !== undefined) {
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
 * label occurs once – nests exactly like a named one, minus the `id`.
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
  nested: boolean,
): void {
  // Resolves for a schema that declares the referent (always so for the schema a
  // type is projected through); a type framed against a foreign schema that
  // omits it simply contributes no nesting.
  const referenceType = referenceTypeNamed(schema, field.ref.typeName);
  if (referenceType === undefined) {
    return;
  }
  const referents = applyNestedReferents(
    document,
    valuesOf(node, alias),
    field,
    referenceType,
    schema,
    context,
  );
  applyIdentityCompanion(document, referents, field, schema, nested);
}

/**
 * Write the {@link ReferenceStrategy.identity identity companion} of an inline
 * reference: the ids its entries reference, flattened out of the nested
 * documents just projected, under the flat physical name an engine filters and
 * facets ({@link physicalFields}).
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
function applyIdentityCompanion(
  document: ProjectedNode,
  referents: readonly ProjectedNode[],
  field: ReferenceField,
  schema: SearchSchema,
  nested: boolean,
): void {
  const names = physicalFields(field, schema);
  if (names.identity === undefined) {
    return;
  }
  const identity = (field.ref as { readonly identity: string }).identity;
  // Only the entries the document actually STORES: a single-valued reference
  // keeps the first referent and drops the rest, and a companion holding an id
  // from a dropped one would match a filter whose hit shows no such entry.
  const stored = field.array === true ? referents : referents.slice(0, 1);
  const ids = dedupe(
    stored.flatMap((referent) =>
      (Array.isArray(referent[identity])
        ? referent[identity]
        : [referent[identity]]
      )
        .map(identityValue)
        .filter((id): id is string => id !== undefined),
    ),
  );
  if (ids.length === 0) {
    return;
  }
  setIdentity(document, names.identity, ids, field, nested);
  // Same rule as every other facetable reference: where the target declares a
  // facet policy, the facet reads a narrowed companion of its own, so an
  // excluded id is never seen by the engine rather than merely unlabelled.
  const policy = inheritedFacetKeys(field, schema);
  if (policy !== undefined) {
    setIdentity(
      document,
      names.facet as string,
      ids.filter(policy.only),
      field,
      nested,
    );
  }
}

/**
 * Write an identity companion under the arity of the reference it belongs to –
 * `array` decides the shape here exactly as it does for every other kind
 * ({@link applyFacet}).
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
  if (!nested || field.array === true) {
    setArray(document, name, ids);
    return;
  }
  setString(document, name, ids[0]);
}

/**
 * Write the identity companion of a {@link ReferenceStrategy.local local}
 * lookup: the ids of the endpoints just stored, under the flat physical name an
 * engine filters on ({@link physicalFields}).
 *
 * Nothing to do where the field is not `filterable`: without that Role there is
 * no companion, and the endpoint is display weight like every other nesting.
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
  const ids = dedupe(
    stored
      .map((endpoint) => endpoint.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  setIdentity(document, names.identity, ids, field, nested);
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
  nestedType: SearchType,
  schema: SearchSchema,
  context: ProjectionContext,
): readonly ProjectedNode[] {
  // One node may stand for several entries: a weldable leaf is single-valued,
  // so an edge the graph gave several roles or several endpoints fans out into
  // one entry per combination BEFORE it is projected (ADR 26). The budget spans
  // every edge THIS node states, rather than resetting per edge – a node holds
  // as many edges as the graph gives it, so a per-edge cap would still let the
  // entries grow with the input.
  const limit = isInlineReference(field)
    ? (field.ref.maxEntries ?? DEFAULT_MAX_ENTRIES)
    : Number.POSITIVE_INFINITY;
  const nodes: FramedNode[] = [];
  for (const value of values.filter(isObject)) {
    if (nodes.length >= limit) {
      break;
    }
    nodes.push(...tuplesOf(value, nestedType, field, limit - nodes.length));
  }
  const referents = nodes
    .map((referent) => projectFields(referent, nestedType, schema, context))
    // Fields, not identity, are what makes something a referent: a literal
    // value object under the alias (dirty source data), or a node this
    // reference type reads nothing from, projects nothing and is no referent.
    // Nesting it would hand the writer a content-free document – and, for a
    // single-valued reference, let it win the slot over a real referent.
    .filter((referent) => Object.keys(referent).length > 0);
  if (referents.length === 0) {
    return referents;
  }
  document[field.name] = field.array === true ? referents : referents[0];
  return referents;
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
 * `limit` is what remains of the document’s entry budget
 * ({@link ReferenceStrategy.maxEntries}, {@link DEFAULT_MAX_ENTRIES}), so the
 * product stops growing mid-way rather than being built and then trimmed – a
 * bound in the data’s own units is not a bound (ADR 12), and one pathological
 * edge would otherwise multiply a document until the run dies.
 */
function tuplesOf(
  node: FramedNode,
  nestedType: SearchType,
  field: ReferenceField,
  limit: number,
): readonly FramedNode[] {
  if (!isInlineReference(field)) {
    return [node];
  }
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
    const grown: FramedNode[] = [];
    for (const tuple of tuples) {
      if (grown.length === limit) {
        break;
      }
      for (const value of values) {
        if (grown.length === limit) {
          break;
        }
        grown.push({ ...tuple, [alias]: value });
      }
    }
    // Capped per alias rather than by returning from inside this loop, so every
    // tuple that survives is split across EVERY weldable alias. Returning early
    // would hand back tuples whose remaining aliases still held their lists,
    // and a single-valued leaf then keeps the first value and drops the rest –
    // silent data loss in place of the fan-out this exists to perform.
    tuples = grown;
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

function firstLiteralOf(node: FramedNode, key: string): string | undefined {
  return literalsOf(node, key)[0];
}

function irisOf(node: FramedNode, key: string): string[] {
  return valuesOf(node, key)
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

/** What a `derive` on a `reference` field is allowed to have produced: the
 *  absolute IRIs among its return value, keeping the shape the declaration
 *  promises (a list stays a list, a single value stays single) so `array` still
 *  decides the stored shape. A lone non-IRI becomes `undefined`, i.e. absent –
 *  the same outcome the graph path gives it. */
function derivedIris(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string =>
        typeof entry === 'string' && isAbsoluteIri(entry),
    );
  }
  return typeof value === 'string' && isAbsoluteIri(value) ? value : undefined;
}

/** Stored Unix seconds a `Date` can represent, or `undefined` – the same
 *  answer {@link isoToUnixSeconds} gives a string it cannot parse, so the two
 *  routes into a `date` field agree on what is storable. */
function storableSeconds(seconds: number): number | undefined {
  return Number.isNaN(new Date(seconds * 1000).getTime()) ? undefined : seconds;
}

function toInteger(literal: string | undefined): number | undefined {
  return literal === undefined ? undefined : Math.trunc(Number(literal));
}

function toNumber(literal: string | undefined): number | undefined {
  return literal === undefined ? undefined : Number(literal);
}

function setNumber(
  document: ProjectedNode,
  field: string,
  value: number | undefined,
): void {
  if (value !== undefined && !Number.isNaN(value)) {
    document[field] = value;
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
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
