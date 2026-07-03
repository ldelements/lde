// Projection: RDF CONSTRUCT quads → flat search documents, driven by the unified
// SearchField/SearchType model below (one declaration; the fanout names come
// from `physicalFields`).
export { projectGraph, irisOf, literalsOf, firstLiteralOf } from './project.js';
export type { SearchDocument } from './project.js';

// Unified field model: one declaration drives projection, engine collection
// schema, query semantics and the GraphQL surface. Plus the field selectors and
// the physical field-name convention they all share.
export {
  searchSchema,
  physicalFields,
  searchableFields,
  facetableFields,
  filterableFields,
  sortableFields,
  outputFields,
  referenceFields,
  fieldNamed,
  isRangeFacet,
  isoToUnixSeconds,
  unixSecondsToIso,
} from './schema.js';
export type {
  FieldKind,
  SearchField,
  SearchType,
  SearchSchema,
  Derivation,
  PhysicalFields,
  FacetRange,
} from './schema.js';

// Engine- and protocol-neutral query IR + filter semantics.
export { filterOperatorFor, pageForOffset } from './query.js';
export type { SearchQuery, Filter, Sort, FilterOperator } from './query.js';

// Engine port + the logical result document returned across it.
export type {
  SearchEngine,
  SearchResult,
  SearchHit,
  ResultDocument,
  SearchValue,
  LocalizedValue,
  Reference,
  FacetBucket,
  FacetMap,
  FacetFieldsOf,
  OutputFieldsOf,
  EngineFor,
} from './engine.js';

export type { FramedNode } from './frame-by-type.js';
