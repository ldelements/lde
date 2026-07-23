import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServerAdapter } from '@whatwg-node/server';
import { Client } from 'typesense';
import { createSearchGraphQLHandler } from '@lde/search-api-graphql';
import { createTypesenseSearchEngine } from '@lde/search-typesense';
import type { ServerConfig } from './config.js';
import { loadSchemaModule } from './schema-module.js';

/** The bootable server: construct with {@link createSearchApiServer}. */
export interface SearchApiServer {
  /** Start listening on the configured port; resolves with the bound port
   *  (useful with `port: 0`, which binds an ephemeral one). */
  start(): Promise<number>;
  /** Stop accepting connections and close the server. */
  stop(): Promise<void>;
}

/**
 * Compose the served search API from a {@link ServerConfig}: load and
 * validate the mounted schema module, bind the Typesense engine, build the
 * GraphQL handler, and wrap it all in a `node:http` server that also answers
 * `GET /health` (liveness) and redirects `/` to the endpoint. Every
 * misconfiguration – an invalid schema, an underivable collection name
 * – throws here, at boot, never on the first query.
 */
export async function createSearchApiServer(
  config: ServerConfig,
): Promise<SearchApiServer> {
  const { searchSchema, schemaOptions, engineOptions } = await loadSchemaModule(
    config.schemaModulePath,
  );
  const client = new Client({
    nodes: [
      {
        host: config.typesense.host,
        port: config.typesense.port,
        protocol: config.typesense.protocol,
      },
    ],
    apiKey: config.typesense.apiKey,
  });
  const engine = createTypesenseSearchEngine(
    client,
    searchSchema,
    engineOptions,
  );
  const graphql = createSearchGraphQLHandler({
    searchSchema,
    engine,
    schemaOptions,
    graphqlEndpoint: config.graphqlEndpoint,
    playground: config.playground,
    maxDepth: config.maxDepth,
    maxCost: config.maxCost,
  });

  const adapter = createServerAdapter(
    (request: Request): Response | Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }
      if (url.pathname === '/') {
        return Response.redirect(
          new URL(config.graphqlEndpoint, url.origin).href,
          302,
        );
      }
      return graphql(request);
    },
  );
  const server: Server = createServer(adapter);

  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => {
          resolve((server.address() as AddressInfo).port);
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // In-flight requests finish; idle keep-alive sockets would otherwise
        // hold the close (and a rolling restart) open indefinitely.
        server.closeIdleConnections();
      }),
  };
}
