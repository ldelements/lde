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
  displayFieldName,
  displayFieldPattern,
  displayLangOf,
  searchableFields,
  facetableFields,
  filterableFields,
  sortableFields,
  outputFields,
  referenceFields,
  fieldNamed,
  labelFieldOf,
  isRangeFacet,
  isoToUnixSeconds,
  unixSecondsToIso,
} from './schema.js';
export type { PhysicalFields } from './schema.js';
export {
  filterOperatorFor,
  filterOperator,
  validateQuery,
  assertValidQuery,
  pageForOffset,
} from './query.js';
export type { FilterOperator, QueryIssue } from './query.js';
