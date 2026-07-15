import type { Quad } from '@rdfjs/types';
import { fold } from '@lde/text-normalization';
import {
  buildSubjectIndex,
  frameSubjects,
  type FramedNode,
} from './frame-by-type.js';
import {
  displayFieldName,
  isoToUnixSeconds,
  physicalFields,
  type KeywordField,
  type ReferenceField,
  type SearchField,
  type SearchSchema,
  type SearchType,
  type TextField,
} from './schema.js';

/** A flat search document. `id` is the engine document key. */
export type SearchDocument = { id: string } & Record<string, unknown>;

/**
 * A projected document tagged with the {@link SearchType} it was projected
 * from – one element of {@link projectGraph}’s mixed, whole-schema stream. The
 * tag is what lets a multi-collection writer route each document to the
 * collection for its type without re-deriving the type from the document.
 */
export interface TypedSearchDocument {
  readonly searchType: SearchType;
  readonly document: SearchDocument;
}

/**
 * Project one framed JSON-LD node into a flat search document: apply each field
 * of the type in declaration order. A field with a `derive` function computes
 * its value from the node and the document as populated so far (so a derived
 * field may read fields declared before it). The physical field names a field
 * fans out to come from {@link physicalFields}, the single source shared with
 * the engine collection definition and the query compiler.
 */
export function projectDocument(
  node: FramedNode,
  searchType: SearchType,
): SearchDocument {
  const id = node['@id'];
  if (typeof id !== 'string') {
    throw new Error(
      `Cannot project a ${searchType.class} node without an @id: every search document needs a stable key, and an empty one would collide with other keyless nodes.`,
    );
  }
  const document: SearchDocument = { id };
  for (const field of searchType.fields) {
    applyField(document, node, field);
  }
  return document;
}

/**
 * Frame `quads` for every root type in the schema and project each node with its
 * type’s declaration – the multi-shape pipeline. Yields each document tagged
 * with its {@link SearchType} ({@link TypedSearchDocument}), so a downstream
 * multi-collection writer can route it to that type’s collection; a
 * single-collection consumer just reads `.document`. Streams one document at a
 * time so memory stays flat. The IR maps to a declaration by type, so adding a
 * shape is adding a `SearchType` to the schema (no engine change).
 *
 * Consumes `quads` once (a single scan builds the shared subject index that
 * every type frames off), so it accepts any `Iterable` – a materialized array or
 * a chained generator merging several sources (`function* () { yield* a; yield* b; }`)
 * with no intermediate copy at the projection peak.
 */
export async function* projectGraph(
  quads: Iterable<Quad>,
  schema: SearchSchema,
): AsyncIterable<TypedSearchDocument> {
  const types = [...schema.values()];
  const index = buildSubjectIndex(
    quads,
    types.map((searchType) => searchType.class),
  );
  for (const searchType of types) {
    for await (const node of frameSubjects(index, searchType.class)) {
      yield { searchType, document: projectDocument(node, searchType) };
    }
  }
}

function applyField(
  document: SearchDocument,
  node: FramedNode,
  field: SearchField,
): void {
  if (field.derive !== undefined) {
    const value = field.derive(node, document);
    if (value !== undefined) {
      document[field.name] = value;
    }
    return;
  }
  const path = field.path;
  if (path === undefined) {
    // Neither path nor derive: populated outside the projection, if at all.
    return;
  }
  switch (field.kind) {
    case 'text':
      return applyText(document, langValuesOf(node, path), field);
    case 'keyword':
      return applyFacet(document, literalsOf(node, path), field);
    case 'reference':
      return applyFacet(document, irisOf(node, path), field);
    case 'integer':
      return setNumber(
        document,
        field.name,
        toInteger(firstLiteralOf(node, path)),
      );
    case 'number':
      return setNumber(
        document,
        field.name,
        toNumber(firstLiteralOf(node, path)),
      );
    case 'date': {
      const literal = firstLiteralOf(node, path);
      return setNumber(
        document,
        field.name,
        literal === undefined ? undefined : isoToUnixSeconds(literal),
      );
    }
    case 'boolean': {
      // The xsd:boolean lexical space: true/false/1/0.
      const literal = firstLiteralOf(node, path);
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

// --- Framed-IR readers (exported so derivations can read arbitrary paths) ---

/** A literal value with its (possibly empty) language tag. */
interface LangValue {
  readonly value: string;
  readonly lang: string;
}

function langValuesOf(node: FramedNode, path: string): LangValue[] {
  return valuesOf(node, path)
    .map(toLangValue)
    .filter((value): value is LangValue => value !== undefined);
}

export function literalsOf(node: FramedNode, path: string): string[] {
  return valuesOf(node, path)
    .map(literalString)
    .filter((value): value is string => value !== undefined);
}

export function firstLiteralOf(
  node: FramedNode,
  path: string,
): string | undefined {
  return literalsOf(node, path)[0];
}

export function irisOf(node: FramedNode, path: string): string[] {
  return valuesOf(node, path)
    .map(iriString)
    .filter((value): value is string => value !== undefined);
}

function valuesOf(node: FramedNode, path: string): unknown[] {
  const value = node[path];
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
