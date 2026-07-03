import type { Quad } from '@rdfjs/types';
import { fold } from '@lde/text-normalization';
import { frameByType, type FramedNode } from './frame-by-type.js';
import {
  isoToUnixSeconds,
  physicalFields,
  type SearchField,
  type SearchSchema,
  type SearchType,
} from './schema.js';

/** A flat search document. `id` is the engine document key. */
export type SearchDocument = { id: string } & Record<string, unknown>;

/**
 * Project one framed JSON-LD node into a flat search document: apply each field
 * of the type, then run the derivations (which may read fields the field specs
 * already set). The physical field names a field fans out to come from
 * {@link physicalFields}, the single source shared with the engine collection
 * schema and the query compiler.
 */
export function projectDocument(
  node: FramedNode,
  searchType: SearchType,
): SearchDocument {
  const id = node['@id'];
  if (typeof id !== 'string') {
    throw new Error(
      `Cannot project a ${searchType.type} node without an @id: every search document needs a stable key, and an empty one would collide with other keyless nodes.`,
    );
  }
  const document: SearchDocument = { id };
  for (const field of searchType.fields) {
    applyField(document, node, field);
  }
  for (const derive of searchType.derivations ?? []) {
    derive(document, node);
  }
  return document;
}

/**
 * Frame `quads` for every root type in the schema and project each node with its
 * type’s declaration — the multi-shape pipeline. Streams one document at a time
 * so memory stays flat. The IR maps to a declaration by type, so adding a shape
 * is adding a `SearchType` to the schema (no engine change).
 */
export async function* projectGraph(
  quads: readonly Quad[],
  schema: SearchSchema,
): AsyncIterable<SearchDocument> {
  for (const searchType of schema.values()) {
    for await (const node of frameByType(quads, searchType.type)) {
      yield projectDocument(node, searchType);
    }
  }
}

function applyField(
  document: SearchDocument,
  node: FramedNode,
  field: SearchField,
): void {
  const path = field.path;
  if (path === undefined) {
    // A derived field — populated by a derivation, not projected from a path.
    return;
  }
  switch (field.kind) {
    case 'text':
      return applyLocalizedText(document, langValuesOf(node, path), field);
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
 * Project a language-tagged text field per locale. Display shows one label
 * (accents preserved) when the field is `output`; sort keys off that same
 * primary value (folded) when `sortable`; search folds every value of the locale
 * when `searchable`, so all are matchable. Absent locales emit nothing.
 */
function applyLocalizedText(
  document: SearchDocument,
  values: readonly LangValue[],
  field: SearchField,
): void {
  const locales = field.locales ?? [];
  if (locales.length === 0) {
    throw new Error(
      `Localized text field “${field.name}” must declare at least one locale; nothing would be projected otherwise.`,
    );
  }
  const names = physicalFields(field);
  locales.forEach((locale, index) => {
    const localeValues = values
      .filter((value) => value.lang === locale)
      .map((value) => value.value);
    if (localeValues.length === 0) {
      return;
    }
    const [primary] = localeValues;
    if (field.output) {
      setString(document, names.display[index], primary);
    }
    if (field.searchable) {
      setString(
        document,
        names.search[index],
        fold(localeValues.join(' ')).trim(),
      );
    }
    if (field.sortable) {
      setString(document, names.sort[index], fold(primary));
    }
  });
}

/**
 * Project a faceted multi-value field: dedupe (after the optional transform),
 * write the value field, and — when `searchable` — a folded `${name}_search`
 * array. `keyword` reads literals; `reference` reads IRIs (the caller passes the
 * already-read raw values).
 */
function applyFacet(
  document: SearchDocument,
  raw: readonly string[],
  field: SearchField,
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
  const lang =
    isObject(value) && typeof value['@language'] === 'string'
      ? value['@language']
      : '';
  return { value: literal, lang };
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
