import { describe, expect, it } from 'vitest';
import { extendSchema, getIntrospectionQuery, parse } from 'graphql';
import {
  searchSchema,
  type FacetsOutcome,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema } from '../src/build-schema.js';
import { createSearchGraphQLHandler } from '../src/handler.js';

const schema: SearchType = {
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
    },
    {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      output: true,
    },
  ],
};

const canned: SearchResult = {
  total: 1,
  hits: [
    {
      id: 'https://d/1',
      document: {
        title: { nl: ['Titel'], en: ['Title'] },
        keyword: ['kaarten'],
      },
    },
  ],
  facets: {},
};

function fakeEngine(): { engine: SearchEngine; received: () => SearchQuery } {
  let captured: SearchQuery;
  return {
    engine: {
      schema: searchSchema(schema),
      async search(_searchType, query) {
        captured = query;
        return canned;
      },
      async searchFacets(_searchType, queries) {
        return queries.map((): FacetsOutcome => ({ facets: {} }));
      },
    },
    received: () => captured,
  };
}

function post(
  handler: (request: Request) => Promise<Response>,
  query: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify({ query }),
    }),
  );
}

describe('createSearchGraphQLHandler', () => {
  it('executes a POST query against the engine', async () => {
    const { engine, received } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(
      handler,
      '{ datasets(query: "kaart") { pagination { total } items { id keyword } } }',
    );
    expect(response.status).toBe(200);
    const { data, errors } = await response.json();

    expect(errors).toBeUndefined();
    expect(data.datasets.pagination.total).toBe(1);
    expect(data.datasets.items[0].id).toBe('https://d/1');
    expect(received().text).toBe('kaart');
  });

  // Only the real handler shows this: graphql-yoga builds its responses with a
  // ponyfill whose `Response` is a different class than the platform global, so
  // a host framework that checks `instanceof Response` nominally – SvelteKit
  // does – rejects every request. A test double reproduces nothing.
  it('answers with the platform Response on every route', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const query = await post(handler, '{ datasets { pagination { total } } }');
    const playground = await handler(
      new Request('http://localhost/graphql', {
        headers: { accept: 'text/html' },
      }),
    );
    const sdl = await handler(new Request('http://localhost/graphql?sdl'));

    expect(query).toBeInstanceOf(Response);
    expect(playground).toBeInstanceOf(Response);
    expect(sdl).toBeInstanceOf(Response);
  });

  // The regression the unit tests cannot catch: argument validation runs inside
  // a resolver, and the transport masks a resolver throw as “Unexpected error.”
  // unless it is a GraphQLError. Asserted through the handler, since masking is
  // exactly what the direct-execution tests bypass.
  it('reports an invalid argument to the caller instead of masking it', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(
      handler,
      '{ datasets(perPage: 150) { pagination { total } } }',
    );
    const { errors } = await response.json();

    expect(errors[0].message).toBe(
      'perPage must be between 0 and 100; got 150.',
    );
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('masks an engine failure, which the caller cannot fix', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine: {
        ...engine,
        search: () => Promise.reject(new Error('connect ECONNREFUSED')),
      },
    });

    const response = await post(
      handler,
      '{ datasets { pagination { total } } }',
    );
    const { errors } = await response.json();

    expect(errors[0].message).toBe('Unexpected error.');
    expect(errors[0].message).not.toContain('ECONNREFUSED');
  });

  it('orders output languages by the Accept-Language header', async () => {
    const { engine, received } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(
      handler,
      '{ datasets { items { title { language value } } } }',
      { 'accept-language': 'en;q=0.8, nl' },
    );
    const { data } = await response.json();

    expect(data.datasets.items[0].title).toEqual([
      { language: 'nl', value: 'Titel' },
      { language: 'en', value: 'Title' },
    ]);
    expect(received().locale).toBe('nl');
  });

  it('serves a self-contained playground on GET', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await handler(
      new Request('http://localhost/graphql', {
        headers: { accept: 'text/html' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('GraphiQL');
    // Self-contained: no assets loaded from an external CDN.
    expect(html).not.toContain('unpkg.com');
    expect(html).not.toContain('cdn.jsdelivr.net');
    // Embeddable: no anti-framing headers.
    expect(response.headers.get('x-frame-options')).toBeNull();
  });

  it('disables the playground when playground is false', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
      playground: false,
    });

    const response = await handler(
      new Request('http://localhost/graphql', {
        headers: { accept: 'text/html' },
      }),
    );

    expect(response.headers.get('content-type') ?? '').not.toContain(
      'text/html',
    );
  });

  it('serves the SDL on GET ?sdl without introspection', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await handler(new Request('http://localhost/graphql?sdl'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/graphql',
    );
    const sdl = await response.text();
    expect(sdl).toContain('type Query');
    expect(sdl).toContain('datasets(');
  });

  it('sends CORS headers for cross-origin browser clients', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const preflight = await handler(
      new Request('http://localhost/graphql', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://docs.example.org',
          'access-control-request-method': 'POST',
        },
      }),
    );

    expect(preflight.headers.get('access-control-allow-origin')).not.toBeNull();
  });

  it('rejects a query deeper than maxDepth', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
      maxDepth: 1,
    });

    const response = await post(
      handler,
      '{ datasets { pagination { total } } }',
    );
    const { data, errors } = await response.json();

    expect(data).toBeUndefined();
    expect(JSON.stringify(errors)).toContain('depth');
  });

  it('rejects a query costlier than maxCost', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
      maxCost: 1,
    });

    const response = await post(
      handler,
      '{ datasets { pagination { total } items { id keyword } } }',
    );
    const { data, errors } = await response.json();

    expect(data).toBeUndefined();
    expect(JSON.stringify(errors)).toContain('Cost');
  });

  it('answers introspection within the default limits', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(handler, getIntrospectionQuery());
    const { data, errors } = await response.json();

    expect(errors).toBeUndefined();
    expect(data.__schema.queryType.name).toBe('Query');
  });

  it('serves a supplied schema with custom fields merged in', async () => {
    const { engine } = fakeEngine();
    const merged = extendSchema(
      buildGraphQLSchema(searchSchema(schema)),
      parse('extend type Query { hello: String }'),
    );
    merged.getQueryType()!.getFields().hello.resolve = () => 'world';
    const handler = createSearchGraphQLHandler({ schema: merged, engine });

    const response = await post(
      handler,
      '{ hello datasets { pagination { total } } }',
    );
    const { data, errors } = await response.json();

    expect(errors).toBeUndefined();
    expect(data.hello).toBe('world');
    expect(data.datasets.pagination.total).toBe(1);
  });

  it('requires exactly one of searchSchema and schema', () => {
    const { engine } = fakeEngine();

    expect(() => createSearchGraphQLHandler({ engine })).toThrow(/exactly one/);
    expect(() =>
      createSearchGraphQLHandler({
        searchSchema: searchSchema(schema),
        schema: buildGraphQLSchema(searchSchema(schema)),
        engine,
      }),
    ).toThrow(/exactly one/);
  });
});
