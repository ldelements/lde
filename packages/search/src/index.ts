// The AUTHORING surface: what a deployment declares a schema with, projects
// documents through, and holds engines and results as. The adapter/surface
// plumbing (field selectors, physical fanout, query validation, codecs) lives
// under `@lde/search/adapter`; the engine-port conformance suite under
// `@lde/search/testing`.

// Projection: RDF CONSTRUCT quads → flat search documents, driven by the
// unified SearchField/SearchType model. A `derive` reads the projected document,
// never the graph, so the IR readers stay internal to projection.
export { projectRoots } from './project.js';
export type {
  ProjectedNode,
  ProjectionContext,
  SearchDocument,
} from './project.js';

// Unified field model: one declaration drives projection, engine collection
// schema, query semantics and the GraphQL surface – a discriminated union by
// `kind`, validated again at runtime when the schema is built.
export {
  defineSearchType,
  searchSchema,
  validateSearchType,
  assertValidSearchType,
  ID_FIELD,
  AND_KEY,
  OR_KEY,
  // The `date` storage codec. A schema author needs it whenever a value
  // bypasses the projection’s own conversion – a `date` populated outside the
  // projection, or a derive that computes seconds from something other than an
  // ISO string – so it belongs on the authoring surface, not only the adapter
  // one.
  isoToUnixSeconds,
  unixSecondsToIso,
} from './schema.js';
export type {
  FieldKind,
  SearchField,
  SearchFieldBase,
  TextField,
  KeywordField,
  ReferenceField,
  ReferenceStrategy,
  NumericField,
  BooleanField,
  SearchType,
  SearchTypeBase,
  RootType,
  ReferenceType,
  RootTypeOf,
  SearchTypeIssue,
  KeyField,
  SearchSchema,
  FacetRange,
  ProjectionValue,
} from './schema.js';

// The declared join edges between root types: which types a query can filter
// across, and which collections must be rebuilt together. Built eagerly by
// `searchSchema`, so declaring a schema is what validates the joins.
export { joinGraph, MAX_JOIN_DEPTH } from './join-graph.js';
export type { JoinGraph } from './join-graph.js';

// Engine- and protocol-neutral query IR (what a `queryDefaults` policy or an
// in-process caller writes).
// `filterOn` builds the ordinary one-criterion clause – the shape a consumer
// policy (`queryDefaults`) appends to `where`, so it belongs on the authoring
// surface and not only on the adapter one.
export { filterOn } from './query.js';
export type {
  SearchQuery,
  ReferenceProjection,
  Filter,
  Criterion,
  CriterionBase,
  Sort,
} from './query.js';

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
  NestedDocument,
  FacetBucket,
  FacetMap,
  FacetsOutcome,
  FacetFieldsOf,
  OutputFieldsOf,
} from './engine.js';

export type { FramedNode } from './frame-by-type.js';
