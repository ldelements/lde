/**
 * The adapter-author surface of `@lde/search` (import from
 * `@lde/search/adapter`): the plumbing an engine adapter or API surface needs
 * to compile queries and reconstruct results – field selectors, the physical
 * field-name convention, query validation and the storage codecs. A
 * deployment author declaring a schema and running searches needs none of
 * this; the main entry point carries that (small) authoring surface.
 */
export {
  assertTypeInSchema,
  physicalFields,
  irAlias,
  displayFieldName,
  displayFieldPattern,
  displayLangOf,
  searchableFields,
  facetableFields,
  filterableFields,
  sortableFields,
  outputFields,
  isInternalField,
  isInlineReference,
  nestedReferenceType,
  nestedFieldName,
  localLookupTypeOf,
  identityFieldOf,
  identityFieldName,
  referenceFields,
  referenceTypeNamed,
  rootTypeNamed,
  inlineFramingDepth,
  fieldNamed,
  datasetField,
  ID_FIELD,
  AND_KEY,
  OR_KEY,
  labelFieldOf,
  labelFieldNameOf,
  labelSourceNameOf,
  labelTargetNameOf,
  documentKeyOf,
  DEFAULT_LABEL_FIELD,
  DEFAULT_MAX_ENTRIES,
  isRangeFacet,
  isAbsoluteIri,
  isoToUnixSeconds,
  unixSecondsToIso,
} from './schema.js';
export type { PhysicalFields } from './schema.js';
export { physicalNameTokens } from './physical-name.js';
export { joinGraph, MAX_JOIN_DEPTH } from './join-graph.js';
export type { JoinGraph } from './join-graph.js';
export {
  filterOperatorFor,
  filterOperator,
  filterOn,
  isWelded,
  isUnsatisfiable,
  validateQuery,
  assertValidQuery,
  resolvePath,
  pageForOffset,
} from './query.js';
export type {
  FilterOperator,
  QueryIssue,
  ResolvedPath,
  PathFailure,
} from './query.js';
