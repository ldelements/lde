import { describe, expect, it } from 'vitest';
import {
  searchSchema,
  type FacetsOutcome,
  type SearchEngine,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { createSearchGraphQLHandler } from '../src/handler.js';
import { queryCostPlugin } from '../src/query-cost.js';

const person: SearchType = {
  name: 'Person',
  class: 'https://schema.org/Person',
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'birthPlace',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
  ],
};
const organization: SearchType = {
  name: 'Organization',
  class: 'https://schema.org/Organization',
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
};
const place: SearchType = {
  name: 'Place',
  class: 'https://schema.org/Place',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'postalCode', kind: 'keyword', output: true },
    {
      name: 'containedIn',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
  ],
};
const work: SearchType = {
  name: 'CreativeWork',
  class: 'https://schema.org/CreativeWork',
  fields: [
    {
      name: 'title',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'genre',
      kind: 'keyword',
      array: true,
      output: true,
      filterable: true,
      facetable: true,
    },
    {
      name: 'year',
      kind: 'integer',
      output: true,
      filterable: true,
      facetable: true,
    },
    {
      name: 'author',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'lookup', target: 'Person' },
    },
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
    },
  ],
};
const schema = searchSchema(work, person, organization, place);

const noHits: SearchResult = { total: 0, hits: [], facets: {} };

const engine: SearchEngine = {
  schema,
  async search() {
    return noHits;
  },
  async searchFacets(_searchType, queries) {
    return queries.map((): FacetsOutcome => ({ facets: {} }));
  },
};

/** The cost a query is scored at, read off its rejection. */
async function costOf(
  query: string,
  variables?: Record<string, unknown>,
): Promise<number> {
  const handler = createSearchGraphQLHandler({
    searchSchema: schema,
    engine,
    maxCost: 0,
  });
  const response = await handler(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }),
  );
  const { errors } = await response.json();
  if (errors === undefined) {
    return 0;
  }
  return Number(/^Query costs (\d+);/.exec(errors[0].message)?.[1]);
}

describe('the cost of a query', () => {
  it('counts one search per root field, whatever its page size', async () => {
    expect(
      await costOf('{ creativeWorks(perPage: 100) { items { id } } }'),
    ).toBe(1);
    expect(
      await costOf(
        '{ a: creativeWorks { items { id } } b: creativeWorks { items { id } } }',
      ),
    ).toBe(2);
  });

  it('charges nothing for a plain field, at any depth', async () => {
    expect(
      await costOf(
        '{ creativeWorks { pagination { total } items { id title { value language } genre year } } }',
      ),
    ).toBe(1);
  });

  it('charges one per lookup and per lookup below it', async () => {
    expect(
      await costOf(
        '{ creativeWorks { items { author { name { value } birthPlace { postalCode containedIn { postalCode } } } } } }',
      ),
    ).toBe(1 + 3);
  });

  it('charges a lookup over several targets once per target', async () => {
    expect(
      await costOf(
        '{ creativeWorks { items { creator { id name { value } } } } }',
      ),
    ).toBe(1 + 2);
  });

  it('charges one per selected facet key', async () => {
    expect(
      await costOf(
        // `year.all` is a second facet query, next to the `matching` one.
        '{ creativeWorks(perPage: 0) { facets { genre { value count } author { value count } year { all { min max } buckets { value } } } } }',
      ),
    ).toBe(1 + 3 + 1);
  });

  it('charges a range facet’s whole-collection extent as a facet of its own', async () => {
    expect(
      await costOf(
        '{ creativeWorks(perPage: 0) { facets { year { matching { min } buckets { value } } } } }',
      ),
    ).toBe(1 + 1);
  });

  it('charges a lookup inside a fragment like an inlined one', async () => {
    expect(
      await costOf(
        `{ creativeWorks { items { ...Work } } }
         fragment Work on CreativeWork { author { ...Person } }
         fragment Person on PersonReference { birthPlace { postalCode } }`,
      ),
    ).toBe(1 + 2);
  });

  it('leaves out a selection skipped by a variable', async () => {
    const query = `query ($withAuthor: Boolean!) {
      creativeWorks { items { author @include(if: $withAuthor) { name { value } } } }
    }`;
    expect(await costOf(query, { withAuthor: true })).toBe(2);
    // The validation of the same document is cached; the cost is not.
    expect(await costOf(query, { withAuthor: false })).toBe(1);
  });

  it('answers a query within maxCost', async () => {
    const handler = createSearchGraphQLHandler({
      searchSchema: schema,
      engine,
      maxCost: 2,
    });
    const response = await handler(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: '{ creativeWorks { items { author { name { value } } } } }',
        }),
      }),
    );
    const { data, errors } = await response.json();

    expect(errors).toBeUndefined();
    expect(data.creativeWorks.items).toEqual([]);
  });

  it('measures only the operation that runs', async () => {
    const handler = createSearchGraphQLHandler({
      searchSchema: schema,
      engine,
      maxCost: 1,
    });
    const response = await handler(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query Cheap { creativeWorks { items { id } } }
            query Costly { creativeWorks { items { author { name { value } } } } }`,
          operationName: 'Cheap',
        }),
      }),
    );
    const { errors } = await response.json();

    expect(errors).toBeUndefined();
  });

  it('leaves an operation it cannot pick to yoga’s own error', async () => {
    const handler = createSearchGraphQLHandler({
      searchSchema: schema,
      engine,
      maxCost: 1,
    });
    const send = async (query: string, operationName?: string) => {
      const response = await handler(
        new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, operationName }),
        }),
      );
      return (await response.json()).errors[0].message as string;
    };

    expect(
      await send(
        'query A { creativeWorks { items { id } } } query B { creativeWorks { items { id } } }',
      ),
    ).toBe('Could not determine what operation to execute.');
    expect(await send('{ creativeWorks { items { id } } }', 'Missing')).toBe(
      'Could not determine what operation to execute.',
    );
  });

  it('reports a missing variable rather than measuring around it', async () => {
    const handler = createSearchGraphQLHandler({
      searchSchema: schema,
      engine,
    });
    const response = await handler(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            'query ($skip: Boolean!) { creativeWorks { items { id @skip(if: $skip) } } }',
        }),
      }),
    );
    const { data, errors } = await response.json();

    expect(data).toBeUndefined();
    expect(errors[0].message).toContain('$skip');
  });

  it('requires a non-negative integer', () => {
    expect(() => queryCostPlugin(-1)).toThrow(
      'maxCost must be a non-negative integer; got -1.',
    );
  });
});
