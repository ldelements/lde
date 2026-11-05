import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSearchApiServer, type SearchApiServer } from '../src/server.js';
import type { ServerConfig } from '../src/config.js';

const config: ServerConfig = {
  schemaModulePath: fileURLToPath(
    new URL('./fixtures/search-schema.mjs', import.meta.url),
  ),
  port: 0,
  graphqlEndpoint: '/graphql',
  playground: true,
  // The engine is constructed but never searched in these tests, so the
  // Typesense connection points nowhere.
  typesense: { host: 'localhost', port: 1, protocol: 'http', apiKey: 'none' },
};

let server: SearchApiServer;
let baseUrl: string;

async function boot(overrides: Partial<ServerConfig> = {}): Promise<void> {
  server = await createSearchApiServer({ ...config, ...overrides });
  const port = await server.start();
  baseUrl = `http://localhost:${port}`;
}

afterEach(() => server.stop());

describe('createSearchApiServer', () => {
  it('answers the liveness endpoint', async () => {
    await boot();
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('serves the SDL without a running introspection query', async () => {
    await boot();
    const response = await fetch(`${baseUrl}/graphql?sdl`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('datasets');
  });

  it('serves the self-contained playground on GET', async () => {
    await boot();
    const response = await fetch(`${baseUrl}/graphql`, {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    // Consume the (large) page, releasing the connection before stop().
    expect(await response.text()).toContain('graphiql');
  });

  it('executes GraphQL over POST', async () => {
    await boot();
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }),
    });
    expect(response.status).toBe(200);
    const { data, errors } = (await response.json()) as {
      data: { __schema: { queryType: { name: string } } };
      errors?: unknown;
    };
    expect(errors).toBeUndefined();
    expect(data.__schema.queryType.name).toBe('Query');
  });

  it('redirects the root to the endpoint', async () => {
    await boot();
    const response = await fetch(baseUrl, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${baseUrl}/graphql`);
  });

  it('answers unknown paths with 404', async () => {
    await boot();
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });

  it('serves a custom endpoint path', async () => {
    await boot({ graphqlEndpoint: '/api/graphql' });
    const response = await fetch(`${baseUrl}/api/graphql?sdl`);
    expect(response.status).toBe(200);
  });
});
