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

function fakeEngine(result: SearchResult = canned): {
  engine: SearchEngine;
  received: () => SearchQuery;
} {
  let captured: SearchQuery;
  return {
    engine: {
      schema: searchSchema(schema),
      async search(_searchType, query) {
        captured = query;
        return result;
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

  it('declares that responses vary by Accept-Language', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(
      handler,
      '{ datasets { pagination { total } } }',
    );

    expect(response.headers.get('vary')).toContain('Accept-Language');
  });

  it('reports the displayed languages in Content-Language', async () => {
    const { engine } = fakeEngine({
      ...canned,
      hits: [
        ...canned.hits,
        {
          id: 'https://d/2',
          document: { title: { nl: ['Alleen Nederlands'] } },
        },
      ],
    });
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(
      handler,
      '{ datasets { items { title { language value } } } }',
      { 'accept-language': 'en' },
    );

    // The first item displays `en` (its `nl` is served but not displayed);
    // the second has only `nl`.
    expect(response.headers.get('content-language')).toBe('en, nl');
  });

  it('leaves malformed, untagged and case-duplicate tags out of Content-Language', async () => {
    const titles = ['nl', 'NL', 'en\nX-Injected: 1', 'UND', 'iw', 'und'].map(
      (language, index) => ({
        id: `https://d/${index}`,
        document: { title: { [language]: ['Titel'] } },
      }),
    );
    const { engine } = fakeEngine({ ...canned, hits: titles });
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(
      handler,
      '{ datasets { items { title { language value } } } }',
    );

    expect(response.status).toBe(200);
    // `iw` stays as served, not canonicalised to `he`.
    expect(response.headers.get('content-language')).toBe('nl, iw');
  });

  it('leaves a value that a failing field nulled out of Content-Language', async () => {
    const { engine } = fakeEngine({
      ...canned,
      hits: [{ id: 'not-an-iri', document: { title: { fr: ['Titre'] } } }],
    });
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    // `title` resolves before `id` fails, which nulls the item around it.
    const response = await post(
      handler,
      '{ datasets { items { title { language value } id } } }',
    );
    const { data, errors } = await response.json();

    expect(errors).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('Titre');
    expect(response.headers.get('content-language')).toBeNull();
  });

  it('sends no Content-Language when it served no language-tagged value', async () => {
    const { engine } = fakeEngine();
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
    });

    const response = await post(
      handler,
      '{ datasets { pagination { total } } }',
      { 'accept-language': 'en' },
    );

    expect(response.headers.get('content-language')).toBeNull();
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
      '{ datasets { items { id } facets { keyword { value } } } }',
    );
    const { data, errors } = await response.json();

    // Measured at execution, so not a 400 like a validation error.
    expect(response.status).toBe(200);
    expect(data).toBeUndefined();
    expect(errors[0].message).toBe(
      'Query costs 2; at most 1 is allowed. Each search, joined reference lookup and facet costs 1.',
    );
  });

  it('does not count fragment spreads as extra levels', async () => {
    const { engine } = fakeEngine();
    // Inlined, this query has depth 3; unflattened, depth 7.
    const handler = createSearchGraphQLHandler({
      searchSchema: searchSchema(schema),
      engine,
      maxDepth: 3,
      maxCost: 1,
    });

    const response = await post(
      handler,
      `{ datasets { ...Page } }
       fragment Page on DatasetSearchResult { pagination { total } items { ...Item } }
       fragment Item on Dataset { id keyword }`,
    );
    const { data, errors } = await response.json();

    expect(errors).toBeUndefined();
    expect(data.datasets.items).toBeDefined();
  });

  describe('still enforces the limits through fragments', () => {
    const nested = `{ datasets { ...Page } }
       fragment Page on DatasetSearchResult { pagination { total } items { ...Item } }
       fragment Item on Dataset { id keyword }`;

    it('rejects a fragment query deeper than maxDepth', async () => {
      const { engine } = fakeEngine();
      // The query above has depth 3 once flattened.
      const handler = createSearchGraphQLHandler({
        searchSchema: searchSchema(schema),
        engine,
        maxDepth: 2,
      });

      const { data, errors } = await (await post(handler, nested)).json();

      expect(data).toBeUndefined();
      expect(JSON.stringify(errors)).toContain('depth');
    });

    it('rejects a fragment query costlier than maxCost', async () => {
      const { engine } = fakeEngine();
      // The query above runs one search.
      const handler = createSearchGraphQLHandler({
        searchSchema: searchSchema(schema),
        engine,
        maxCost: 0,
      });

      const { data, errors } = await (await post(handler, nested)).json();

      expect(data).toBeUndefined();
      expect(errors[0].message).toContain('Query costs 1;');
    });
  });

  describe('maxSearches', () => {
    function handlerWith(maxSearches: number) {
      const { engine } = fakeEngine();
      return createSearchGraphQLHandler({
        searchSchema: searchSchema(schema),
        engine,
        maxSearches,
      });
    }

    it('rejects an operation with more aliased searches than maxSearches', async () => {
      const { data, errors } = await (
        await post(
          handlerWith(2),
          '{ a: datasets { items { id } } b: datasets { items { id } } c: datasets { items { id } } }',
        )
      ).json();

      expect(data).toBeUndefined();
      expect(errors[0].message).toBe(
        'Query selects 3 root fields; at most 2 are allowed, as each may run a search.',
      );
    });

    it('counts searches inside fragments at the operation root', async () => {
      const { data, errors } = await (
        await post(
          handlerWith(2),
          `{ a: datasets { items { id } } ...More }
           fragment More on Query { b: datasets { items { id } } ... on Query { c: datasets { items { id } } } }`,
        )
      ).json();

      expect(data).toBeUndefined();
      expect(errors[0].message).toContain('selects 3 root fields');
    });

    it('requires a positive integer', () => {
      expect(() => handlerWith(0)).toThrow(
        'maxSearches must be a positive integer; got 0.',
      );
    });

    it('reports a cyclic fragment instead of recursing into it', async () => {
      const { data, errors } = await (
        await post(
          handlerWith(2),
          '{ ...Cycle } fragment Cycle on Query { datasets { items { id } } ...Cycle }',
        )
      ).json();

      expect(data).toBeUndefined();
      expect(JSON.stringify(errors)).toContain('Cannot spread fragment');
    });

    it('leaves an unknown fragment to GraphQL’s own validation', async () => {
      const { data, errors } = await (
        await post(handlerWith(2), '{ ...Missing }')
      ).json();

      expect(data).toBeUndefined();
      expect(errors[0].message).toBe('Unknown fragment "Missing".');
    });

    it('counts a search selected twice under one key once, as it runs once', async () => {
      const { data, errors } = await (
        await post(
          handlerWith(1),
          '{ datasets { items { id } } datasets { pagination { total } } __typename }',
        )
      ).json();

      expect(errors).toBeUndefined();
      expect(data.datasets.items).toBeDefined();
    });
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
