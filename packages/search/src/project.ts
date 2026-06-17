import type { Quad } from '@rdfjs/types';
import { fold } from '@lde/text-normalization';
import { frameByType, type FramedSubject } from './frame-by-type.js';

/** A flat search document. `id` is the engine document key. */
export type SearchDocument = { id: string } & Record<string, unknown>;

/**
 * How one framed-IR property projects into search fields. The vocabulary mirrors
 * SHACL so a generator can later emit it from shapes + search annotations:
 * `path` is `sh:path`, and the kind is derivable from `sh:datatype`/`sh:nodeKind`
 * /`sh:maxCount` plus the search annotations.
 */
export type FieldKind = LangTextKind | FacetKind | NumberKind;

/** Language-tagged text → per-locale display + a folded search field. */
export interface LangTextKind {
  readonly type: 'langText';
  /** Per-locale display fields `${name}_${locale}` (accents preserved). */
  readonly locales?: readonly string[];
  /** Folded `${name}_search` over all language values (diacritic-insensitive). */
  readonly search?: boolean;
  /** Folded `${name}_sort` over the best-effort primary value. */
  readonly sort?: boolean;
  /** Single best-effort display `${name}_name` (nl → en → untagged → first). */
  readonly display?: boolean;
}

/** A faceted multi-value field, optionally also folded for search. */
export interface FacetKind {
  readonly type: 'facet';
  /** Read IRI references (`@id`) rather than literal values. */
  readonly iri?: boolean;
  /** Also emit a folded `${name}_search` array. */
  readonly search?: boolean;
  /** Transform each value before faceting (e.g. strip a media-type prefix). */
  readonly transform?: (value: string) => string;
}

/** A numeric scalar; `date` parses an ISO date-time into unix seconds. */
export interface NumberKind {
  readonly type: 'number';
  readonly date?: boolean;
}

export interface FieldSpec {
  /** Output field base name; per-kind suffixes are appended. */
  readonly name: string;
  /** Framed-IR predicate IRI to read (the SHACL `sh:path`). */
  readonly path: string;
  readonly kind: FieldKind;
}

/** A computed field that is not a direct projection of a single path
 *  (e.g. a status rank, or a group derived from a code table). */
export type Derivation = (
  document: SearchDocument,
  node: FramedSubject,
) => void;

/**
 * One root type’s complete projection — the runtime form of a single SHACL
 * NodeShape: `type` is its `sh:targetClass` (and the framed node’s `@type`),
 * `fields` are its property shapes, and `derivations` are its `sh:rule`-shaped
 * computed fields. A generator emits one of these per NodeShape.
 */
export interface Projection {
  readonly type: string;
  readonly fields: readonly FieldSpec[];
  readonly derivations?: readonly Derivation[];
}

const DISPLAY_FALLBACK = ['nl', 'en', ''] as const;

/**
 * Project one framed JSON-LD node into a flat search document: apply each field
 * spec, then run the derivations (which may read fields the specs already set).
 */
export function projectDocument(
  node: FramedSubject,
  projection: Projection,
): SearchDocument {
  const id = node['@id'];
  if (typeof id !== 'string') {
    throw new Error(
      `Cannot project a ${projection.type} node without an @id: every search document needs a stable key, and an empty one would collide with other keyless nodes.`,
    );
  }
  const document: SearchDocument = { id };
  for (const field of projection.fields) {
    applyField(document, node, field);
  }
  for (const derive of projection.derivations ?? []) {
    derive(document, node);
  }
  return document;
}

/**
 * Frame `quads` for every projection’s root type and project each node with its
 * type’s projection — the multi-shape pipeline. Streams one document at a time
 * so memory stays flat. The IR maps to a projection by type, so adding a shape
 * is adding a `Projection` (no engine change).
 */
export async function* projectGraph(
  quads: readonly Quad[],
  projections: readonly Projection[],
): AsyncIterable<SearchDocument> {
  const byType = new Map(
    projections.map((projection) => [projection.type, projection]),
  );
  for (const projection of byType.values()) {
    for await (const node of frameByType(quads, projection.type)) {
      yield projectDocument(node, projection);
    }
  }
}

function applyField(
  document: SearchDocument,
  node: FramedSubject,
  field: FieldSpec,
): void {
  switch (field.kind.type) {
    case 'langText':
      return applyLangText(document, langValuesOf(node, field.path), field);
    case 'facet':
      return applyFacet(document, node, field);
    case 'number':
      return applyNumber(document, node, field);
  }
}

function applyLangText(
  document: SearchDocument,
  values: readonly LangValue[],
  { name, kind }: FieldSpec,
): void {
  const text = kind as LangTextKind;
  for (const locale of text.locales ?? []) {
    const match = values.find((value) => value.lang === locale)?.value;
    setString(document, `${name}_${locale}`, match);
  }
  if (text.search) {
    const folded = fold(values.map((value) => value.value).join(' ')).trim();
    setString(document, `${name}_search`, folded);
  }
  if (text.display) {
    setString(document, `${name}_name`, localized(values));
  }
  if (text.sort) {
    setString(document, `${name}_sort`, fold(localized(values) ?? ''));
  }
}

function applyFacet(
  document: SearchDocument,
  node: FramedSubject,
  { name, path, kind }: FieldSpec,
): void {
  const facet = kind as FacetKind;
  const raw = facet.iri ? irisOf(node, path) : literalsOf(node, path);
  const values = dedupe(facet.transform ? raw.map(facet.transform) : raw);
  setArray(document, name, values);
  if (facet.search) {
    setArray(
      document,
      `${name}_search`,
      dedupe(values.map((value) => fold(value))),
    );
  }
}

function applyNumber(
  document: SearchDocument,
  node: FramedSubject,
  { name, path, kind }: FieldSpec,
): void {
  const literal = firstLiteralOf(node, path);
  if (literal === undefined) {
    return;
  }
  const value = (kind as NumberKind).date
    ? isoToUnix(literal)
    : Math.trunc(Number(literal));
  if (value !== undefined && !Number.isNaN(value)) {
    document[name] = value;
  }
}

// --- Framed-IR readers (exported so derivations can read arbitrary paths) ---

/** A literal value with its (possibly empty) language tag. */
export interface LangValue {
  readonly value: string;
  readonly lang: string;
}

export function langValuesOf(node: FramedSubject, path: string): LangValue[] {
  return valuesOf(node, path)
    .map(toLangValue)
    .filter((value): value is LangValue => value !== undefined);
}

export function literalsOf(node: FramedSubject, path: string): string[] {
  return valuesOf(node, path)
    .map(literalString)
    .filter((value): value is string => value !== undefined);
}

export function firstLiteralOf(
  node: FramedSubject,
  path: string,
): string | undefined {
  return literalsOf(node, path)[0];
}

export function irisOf(node: FramedSubject, path: string): string[] {
  return valuesOf(node, path)
    .map(iriString)
    .filter((value): value is string => value !== undefined);
}

function valuesOf(node: FramedSubject, path: string): unknown[] {
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

function localized(values: readonly LangValue[]): string | undefined {
  for (const lang of DISPLAY_FALLBACK) {
    const match = values.find((value) => value.lang === lang)?.value;
    if (match !== undefined) {
      return match;
    }
  }
  return values[0]?.value;
}

function isoToUnix(iso: string): number | undefined {
  const millis = new Date(iso).getTime();
  return Number.isNaN(millis) ? undefined : Math.trunc(millis / 1000);
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
