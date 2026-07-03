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

/**
 * One queryable field — the single declarative source that drives all four
 * consumers (projection, engine collection schema, query semantics, and the
 * GraphQL surface).
 *
 * Capability flags (`searchable`/`filterable`/`facetable`/`sortable`/`output`)
 * are independent opt-ins: a field exposes exactly the roles it declares. A
 * field with no `path` is a **derived field** — populated by a
 * {@link Derivation} rather than projected from the IR — yet it still carries
 * full query/schema/output behavior (e.g. `status`, the compatibility booleans).
 *
 * The physical field names a declaration fans out to (per-locale search/sort
 * keys) follow one convention, owned by
 * {@link physicalFields} so projection, collection-schema and query compiler
 * cannot disagree.
 *
 * SHACL is one possible *source*, not a dependency: a generator can emit a
 * declaration from a NodeShape + `search:` annotations
 * (`kind`←`sh:datatype`/`sh:nodeKind`, `path`←`sh:path`, `array`←`sh:maxCount`,
 * `localized`←`rdf:langString`/`sh:languageIn`, `ref`←`sh:node`/`sh:class`),
 * and a hand-written declaration is just as valid.
 */
export interface SearchField {
  /** Logical API name; the physical fanout derives from it. Declare camelCase
   *  where it surfaces in GraphQL. */
  readonly name: string;
  readonly kind: FieldKind;
  /** Framed-IR predicate IRI to project from. Omit for a
   *  derivation-populated field. */
  readonly path?: string;
  /** Multi-valued. */
  readonly array?: boolean;
  /** Always present: a non-null scalar in the API output and
   *  a non-optional field in the engine index. Moot for arrays/booleans/`id`,
   *  which are non-null regardless. */
  readonly required?: boolean;
  /** Language-tagged text (`rdf:langString`); projected per locale. `text` only. */
  readonly localized?: boolean;
  /** When `localized`, the languages to emit (the per-locale fanout). */
  readonly locales?: readonly string[];
  /** Appears in the API output type / carries a display label. */
  readonly output?: boolean;
  /** Full-text inclusion with a `query_by` weight (folded; per-locale when
   *  `localized`). Presence is what makes a field searchable. */
  readonly searchable?: { readonly weight: number };
  /** Usable in `where`. */
  readonly filterable?: boolean;
  /** Returned as facet buckets. */
  readonly facetable?: boolean;
  /** Publicly selectable in `orderBy`; localized text also emits a folded sort key. */
  readonly sortable?: boolean;
  /** For `kind: 'reference'`: the referenced shape and how much of it to carry. */
  readonly ref?: {
    readonly type: string;
    readonly strategy: 'labelOnly' | 'idOnly' | 'inline';
  };
  /** Projection-time value transform (e.g. strip a media-type prefix). */
  readonly transform?: (value: string) => string;
  /**
   * Range-facet bins for a numeric (`integer`/`number`/`date`) facetable field.
   * When set, the field facets into these fixed half-open `[min, max)` ranges (a
   * histogram) rather than one bucket per distinct value — the per-bucket counts
   * a UI slider needs. Bins are query-time only (no index impact) and
   * engine-neutral: the Typesense adapter emits a `facet_by` range, an
   * OpenSearch adapter a `range` aggregation. See {@link FacetRange}.
   */
  readonly facetRanges?: readonly FacetRange[];
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
 * A computed field that is not a direct projection of a single path — a status
 * rank, a compatibility boolean. Reads
 * the framed node and writes onto the flat document the field specs already
 * populated.
 */
export type Derivation = (document: SearchDocument, node: FramedNode) => void;

/**
 * One root type’s complete search declaration: its logical API `name`, the
 * `type` IRI its documents are instances of, the queryable `fields`, and the
 * computed `derivations`. A SHACL generator can emit one per NodeShape
 * (`name`←`sh:name`/local name, `type`←`sh:targetClass`, `fields`←its property
 * shapes), but that is a source, not a requirement.
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
  readonly derivations?: readonly Derivation[];
}

/**
 * Declare a {@link SearchType}, capturing it as a literal: the `const` type
 * parameter preserves the field names and capability flags that the type-level
 * helpers (`FacetFieldsOf`, `OutputFieldsOf`, `EngineFor`) read off the type —
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
 * keyed by its `type` IRI. Build one with {@link searchSchema}.
 */
export type SearchSchema = ReadonlyMap<string, SearchType>;

/** Build a {@link SearchSchema} from root-type declarations, keyed by `type`. */
export function searchSchema(...types: readonly SearchType[]): SearchSchema {
  return new Map(types.map((searchType) => [searchType.type, searchType]));
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
): readonly SearchField[] {
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
 * {@link SearchField.facetRanges}. One predicate for the surface’s facet type,
 * the adapter’s facet clause and the bucket reconstruction, so they cannot
 * disagree.
 */
export function isRangeFacet(
  field: SearchField,
): field is SearchField & { readonly facetRanges: readonly FacetRange[] } {
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
  const localized = field.kind === 'text' && field.localized === true;
  const locales = localized ? (field.locales ?? []) : [];
  return {
    display:
      localized && field.output
        ? locales.map((locale) => `${field.name}_${locale}`)
        : [],
    search: field.searchable
      ? localized
        ? locales.map((locale) => `${field.name}_search_${locale}`)
        : [`${field.name}_search`]
      : [],
    sort:
      localized && field.sortable
        ? locales.map((locale) => `${field.name}_sort_${locale}`)
        : [],
  };
}
