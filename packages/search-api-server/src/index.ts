// The bootable served search API: the composition layer binding the
// engine-agnostic @lde/search-api-graphql handler to a Typesense engine, a
// mounted schema-declaration module and environment config. The `search-api-server`
// bin (src/cli.ts) and the Docker image are thin wrappers over these.
export { createSearchApiServer } from './server.js';
export type { SearchApiServer } from './server.js';
export { configFromEnvironment } from './config.js';
export type { ServerConfig, TypesenseConnection } from './config.js';
export { loadSchemaModule } from './schema-module.js';
export type { SchemaModule } from './schema-module.js';
