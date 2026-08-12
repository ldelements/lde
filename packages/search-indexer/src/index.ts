// The bootable search indexer: the composition layer binding the
// engine-agnostic @lde/search-pipeline indexer to Typesense rebuild writers,
// a mounted schema-declaration module and environment config. The
// `search-indexer` bin (src/cli.ts) and the Docker image are thin wrappers
// over these.
export { createSearchIndexer } from './indexer.js';
export type { SearchIndexerExtensions } from './indexer.js';
// The pieces createSearchIndexer composes. Adding a transform does NOT need
// these – that is `createSearchIndexer(config, { transforms })`. They are for
// the genuinely bespoke deployment (a non-SPARQL reader, another engine, a root
// selector that is not by class), which composes `searchStages`,
// `searchIndexWriter` and `Pipeline` directly and would otherwise also re-derive
// dataset selection, the QLever import path and collection naming.
export {
  datasetSelectorFrom,
  distributionResolverFrom,
  writerFactoryFrom,
} from './composition.js';
export { configFromEnvironment } from './config.js';
export type {
  IndexerConfig,
  ProvenanceConfig,
  QleverConfig,
  TypesenseConnection,
} from './config.js';
