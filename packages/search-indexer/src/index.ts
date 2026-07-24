// The bootable search indexer: the composition layer binding the
// engine-agnostic @lde/search-pipeline indexer to Typesense rebuild writers,
// a mounted schema-declaration module and environment config. The
// `search-indexer` bin (src/cli.ts) and the Docker image are thin wrappers
// over these.
export { createSearchIndexer } from './indexer.js';
export { configFromEnvironment } from './config.js';
export type {
  IndexerConfig,
  ProvenanceConfig,
  QleverConfig,
  TypesenseConnection,
} from './config.js';
