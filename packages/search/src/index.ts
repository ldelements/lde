// Projection: RDF CONSTRUCT quads → flat search documents, driven by the unified
// SearchField/SearchSchema model below (one declaration; the fanout names come
// from `physicalFields`).
export { projectGraph, irisOf, literalsOf, firstLiteralOf } from './project.js';
export type { SearchDocument } from './project.js';

// Unified field model: one declaration drives projection, engine collection
// schema, query semantics and the GraphQL surface. Plus the schema selectors and
// the physical field-name convention they all share.
export {
  physicalFields,
  searchableFields,
  facetableFields,
  filterableFields,
  sortableFields,
  outputFields,
} from './schema.js';
export type {
  FieldKind,
  SearchField,
  SearchSchema,
  Derivation,
  PhysicalFields,
} from './schema.js';

// Engine- and protocol-neutral query IR + filter semantics.
export { filterOperatorFor, filterOperator, acceptsFilter } from './query.js';
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
  ResultFor,
} from './engine.js';

export type { FramedNode } from './frame-by-type.js';
