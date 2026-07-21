import type { Quad } from '@rdfjs/types';
import { fold } from '@lde/text-normalization';
import {
  buildSubjectIndex,
  frameSubjects,
  type FramedNode,
} from './frame-by-type.js';
import {
  assertTypeInSchema,
  displayFieldName,
  inlineFramingDepth,
  irAlias,
  isInternalField,
  isInlineReference,
  isoToUnixSeconds,
  physicalFields,
  referenceTypeNamed,
  type KeywordField,
  type ReferenceField,
  type RootType,
  type SearchField,
  type SearchSchema,
  type SearchType,
  type TextField,
} from './schema.js';

/** A flat search document. `id` is the engine document key. */
export type SearchDocument = { id: string } & Record<string, unknown>;

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
): SearchDocument {
  const document = projectFields(node, searchType, schema);
  pruneInternalFields(document, searchType, schema);
  return document;
}

/**
 * Prune every internal field from a fully projected document, in place. Runs
 * only after all projection – so every derive that might read an internal
 * field, at any depth, has already run – which makes this single post-order
 * pass safe. A no-role inline reference is itself internal, so it is deleted
 * whole here; a surfaced (`output`) inline reference survives, but its own
 * internal helper fields are pruned from the nested document. That keeps the
 * *a field without a role reaches neither the engine nor the API* invariant
 * true at every depth of the reference graph, not just at the root.
 */
function pruneInternalFields(
  document: SearchDocument,
  searchType: SearchType,
  schema: SearchSchema | undefined,
): void {
  for (const field of searchType.fields) {
    if (isInternalField(field)) {
      delete document[field.name];
      continue;
    }
    // A surfaced inline reference nests its referent(s) as SearchDocument(s);
    // prune those too, by their reference type.
    if (schema === undefined || field.kind !== 'reference') {
      continue;
    }
    const ref = field.ref;
    if (ref?.strategy !== 'inline') {
      continue;
    }
    const referenceType = referenceTypeNamed(schema, ref.typeName);
    const nested = document[field.name];
    if (referenceType === undefined || nested === undefined) {
      continue;
    }
    for (const referent of Array.isArray(nested) ? nested : [nested]) {
      pruneInternalFields(referent as SearchDocument, referenceType, schema);
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
): SearchDocument {
  const id = node['@id'];
  if (typeof id !== 'string') {
    throw new Error(
      `Cannot project a “${searchType.name}” node without an @id: every search document needs a stable key, and an empty one would collide with other keyless nodes.`,
    );
  }
  const document: SearchDocument = { id };
  for (const field of searchType.fields) {
    applyField(document, node, field, searchType, schema);
  }
  return document;
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
): AsyncIterable<SearchDocument> {
  assertTypeInSchema(schema, searchType);
  const index = buildSubjectIndex(quads);
  // Distinct roots only. A selector may return an IRI more than once – a
  // non-`DISTINCT` `SELECT` over a one-to-many join yields the same subject per
  // matched row – and a repeated root would otherwise frame and emit a
  // duplicate document under the same `id`.
  const depth = inlineFramingDepth(schema, searchType);
  for await (const node of frameSubjects(index, [...new Set(roots)], depth)) {
    yield projectDocument(node, searchType, schema);
  }
}

function applyField(
  document: SearchDocument,
  node: FramedNode,
  field: SearchField,
  searchType: SearchType,
  schema: SearchSchema | undefined,
): void {
  if (field.derive !== undefined) {
    const value = field.derive(document);
    if (value !== undefined) {
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
      applyInlineReference(document, node, alias, field, schema);
    }
    return;
  }
  switch (field.kind) {
    case 'text':
      return applyText(document, langValuesOf(node, alias), field);
    case 'keyword':
      return applyFacet(document, literalsOf(node, alias), field);
    case 'reference':
      return applyFacet(document, irisOf(node, alias), field);
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
 * Project a text field. **Display** (when `output`) preserves *every* language
 * present – one label per language (accents preserved, untagged under `und`),
 * stored `index: false` so extra languages cost nothing – so a value in an
 * undeclared language still renders rather than collapsing to a bare IRI.
 * **Search** (folded, when `searchable`) and **sort** (folded primary, when
 * `sortable`) stay on the declared `locales`, which drive the indexed, stemmed,
 * weighted fanout; a value in an undeclared language is not indexed. Absent
 * languages emit nothing.
 */
function applyText(
  document: SearchDocument,
  values: readonly LangValue[],
  field: TextField,
): void {
  if (field.output) {
    // First value of each present language wins; a language absent from
    // `locales` still lands as a display field (kept off the search index).
    const seenLangs = new Set<string>();
    for (const { lang, value } of values) {
      if (!seenLangs.has(lang)) {
        seenLangs.add(lang);
        setString(document, displayFieldName(field, lang), value);
      }
    }
  }
  // Empty `locales` is rejected at declaration time (`validateSearchType`);
  // here it simply indexes nothing.
  if (field.searchable !== undefined || field.sortable === true) {
    const names = physicalFields(field);
    field.locales.forEach((locale, index) => {
      const localeValues = values
        .filter((value) => value.lang === locale)
        .map((value) => value.value);
      if (localeValues.length === 0) {
        return;
      }
      if (field.searchable) {
        setString(
          document,
          names.search[index],
          foldedSearchValue(localeValues),
        );
      }
      if (field.sortable) {
        setString(document, names.sort[index], fold(localeValues[0]));
      }
    });
  }
}

/** The projection’s definition of a folded free-text search value. */
function foldedSearchValue(values: readonly string[]): string {
  return fold(values.join(' ')).trim();
}

/**
 * Project a faceted multi-value field: dedupe (after the optional transform),
 * write the value field, and – when `searchable` – a folded `${name}_search`
 * array. `keyword` reads literals; `reference` reads IRIs (the caller passes the
 * already-read raw values).
 */
function applyFacet(
  document: SearchDocument,
  raw: readonly string[],
  field: KeywordField | ReferenceField,
): void {
  const values = dedupe(field.transform ? raw.map(field.transform) : raw);
  setArray(document, field.name, values);
  if (field.searchable) {
    setArray(
      document,
      physicalFields(field).search[0],
      dedupe(values.map((value) => fold(value))),
    );
  }
}

/**
 * Project an inline reference: the referent node(s) embedded under the field’s
 * {@link irAlias IR Alias} are each projected through the reference’s
 * {@link ReferenceType} (whose own fields read their own aliases, minted against
 * the reference type) and attached under the field’s name – a nested
 * {@link SearchDocument} for a single reference, an array for an `array` one.
 * The referent is projected in full – internal fields included – so the
 * declaring type’s (or the reference type’s own) derives can read them;
 * {@link pruneInternalFields} then removes the internal fields from a *surfaced*
 * referent and deletes an internal inline reference whole. Recurses through
 * `schema`, so an inline reference may itself carry further inline references to
 * the schema’s declared depth. The referent type is guaranteed declared by
 * {@link searchSchema}.
 */
function applyInlineReference(
  document: SearchDocument,
  node: FramedNode,
  alias: string,
  field: ReferenceField & { readonly ref: { readonly typeName: string } },
  schema: SearchSchema,
): void {
  // Resolves for a schema that declares the referent (always so for the schema a
  // type is projected through); a type framed against a foreign schema that
  // omits it simply contributes no nesting.
  const referenceType = referenceTypeNamed(schema, field.ref.typeName);
  if (referenceType === undefined) {
    return;
  }
  const referents = valuesOf(node, alias)
    .filter(isObject)
    .filter((referent) => typeof referent['@id'] === 'string')
    .map((referent) => projectFields(referent, referenceType, schema));
  if (referents.length === 0) {
    return;
  }
  document[field.name] = field.array === true ? referents : referents[0];
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

function iriString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (isObject(value) && typeof value['@id'] === 'string') {
    return value['@id'];
  }
  return undefined;
}

function toInteger(literal: string | undefined): number | undefined {
  return literal === undefined ? undefined : Math.trunc(Number(literal));
}

function toNumber(literal: string | undefined): number | undefined {
  return literal === undefined ? undefined : Number(literal);
}

function setNumber(
  document: SearchDocument,
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
  document: SearchDocument,
  field: string,
  value: string | undefined,
): void {
  if (value !== undefined && value !== '') {
    document[field] = value;
  }
}

function setArray(
  document: SearchDocument,
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
