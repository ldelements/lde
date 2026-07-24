#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { configFromEnvironment } from './config.js';
import { createSearchApiServer } from './server.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

try {
  const config = configFromEnvironment(process.env);
  const server = await createSearchApiServer(config);
  const port = await server.start();
  console.info(
    `@lde/search-api-server ${version} serving ${config.graphqlEndpoint} on port ${port}.`,
  );
  const shutdown = (signal: string): void => {
    console.info(`Received ${signal}; shutting down.`);
    void server.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
