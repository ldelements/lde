// The AUTHORING surface: what a deployment declares a schema with, projects
// documents through, and holds engines and results as. The adapter/surface
// plumbing (field selectors, physical fanout, query validation, codecs) lives
// under `@lde/search/adapter`; the engine-port conformance suite under
// `@lde/search/testing`.

// Projection: RDF CONSTRUCT quads → flat search documents, driven by the
// unified SearchField/SearchType model. The IR readers (irisOf, …) are here
// because `derive` functions are written against them.
export { projectGraph, irisOf, literalsOf, firstLiteralOf } from './project.js';
export type { SearchDocument } from './project.js';

// Unified field model: one declaration drives projection, engine collection
// schema, query semantics and the GraphQL surface — a discriminated union by
// `kind`, validated again at runtime when the schema is built.
export {
  defineSearchType,
  searchSchema,
  validateSearchType,
  assertValidSearchType,
} from './schema.js';
export type {
  FieldKind,
  SearchField,
  SearchFieldBase,
  TextField,
  LocalizedTextField,
  KeywordField,
  ReferenceField,
  NumericField,
  BooleanField,
  SearchType,
  SearchTypeIssue,
  SearchSchema,
  FacetRange,
} from './schema.js';

// Engine- and protocol-neutral query IR (what a `queryDefaults` policy or an
// in-process caller writes).
export type { SearchQuery, Filter, Sort } from './query.js';

// Engine port + the logical result document returned across it. An engine is
// bound to the whole SearchSchema at construction by its adapter factory.
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
} from './engine.js';

export type { FramedNode } from './frame-by-type.js';
