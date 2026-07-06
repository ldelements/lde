import { describe, expect, it } from 'vitest';
import {
  searchSchema,
  type FacetMap,
  type SearchEngine,
  type SearchQuery,
} from '@lde/search';
import { createFacetLoader, groupFacetQueries } from '../src/facet-batch.js';

const dataset = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    { name: 'keyword', kind: 'keyword', facetable: true, filterable: true },
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
    { name: 'publisher', kind: 'reference', facetable: true },
  ],
} as const;

const baseQuery: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 20,
  offset: 40,
  facets: [],
  locale: 'nl',
};

/** An engine that records every searchFacets batch and answers each query
 *  with a bucket per requested facet field. */
function recordingEngine(): {
  engine: SearchEngine;
  batches: readonly (readonly SearchQuery[])[];
} {
  const batches: (readonly SearchQuery[])[] = [];
  return {
    engine: {
      schema: searchSchema(dataset),
      async search() {
        throw new Error('not under test');
      },
      async searchFacets(_searchType, queries): Promise<readonly FacetMap[]> {
        batches.push(queries);
        return queries.map((query) =>
          Object.fromEntries(
            query.facets.map((field) => [
              field,
              [{ value: `${field}-value`, count: 1 }],
            ]),
          ),
        );
      },
    },
    batches,
  };
}

describe('groupFacetQueries', () => {
  it('collapses an unfiltered selection to a single facet-only query', () => {
    const queries = groupFacetQueries(baseQuery, [
      'keyword',
      'status',
      'publisher',
    ]);
    expect(queries).toEqual([
      {
        ...baseQuery,
        facets: ['keyword', 'status', 'publisher'],
        limit: 0,
        offset: 0,
      },
    ]);
  });

  it('gives each own-filtered facet its own query with that filter removed', () => {
    const filtered: SearchQuery = {
      ...baseQuery,
      where: [
        { field: 'keyword', in: ['x'] },
        { field: 'status', in: ['valid'] },
      ],
    };
    const queries = groupFacetQueries(filtered, [
      'keyword',
      'status',
      'publisher',
    ]);
    // publisher (no own filter) keeps the untouched where; keyword and status
    // each drop only their own filter.
    expect(queries).toEqual([
      { ...filtered, facets: ['publisher'], limit: 0, offset: 0 },
      {
        ...filtered,
        where: [{ field: 'status', in: ['valid'] }],
        facets: ['keyword'],
        limit: 0,
        offset: 0,
      },
      {
        ...filtered,
        where: [{ field: 'keyword', in: ['x'] }],
        facets: ['status'],
        limit: 0,
        offset: 0,
      },
    ]);
  });

  it('returns no queries for an empty selection', () => {
    expect(groupFacetQueries(baseQuery, [])).toEqual([]);
  });

  it('drops the listing orderBy: a facet-only query has no hits to order', () => {
    const sorted: SearchQuery = {
      ...baseQuery,
      orderBy: [{ field: 'relevance', direction: 'desc' }],
    };
    const [facetQuery] = groupFacetQueries(sorted, ['keyword']);
    expect(facetQuery.orderBy).toEqual([]);
    expect(facetQuery.limit).toBe(0);
  });
});

describe('createFacetLoader', () => {
  it('collects same-tick loads into one dispatch and resolves each field from it', async () => {
    const { engine, batches } = recordingEngine();
    const load = createFacetLoader(engine, dataset, baseQuery);

    const [keyword, status] = await Promise.all([
      load('keyword'),
      load('status'),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].facets).toEqual(['keyword', 'status']);
    expect(keyword).toEqual([{ value: 'keyword-value', count: 1 }]);
    expect(status).toEqual([{ value: 'status-value', count: 1 }]);
  });

  it('deduplicates a field loaded twice in the same tick', async () => {
    const { engine, batches } = recordingEngine();
    const load = createFacetLoader(engine, dataset, baseQuery);

    const [first, second] = await Promise.all([
      load('keyword'),
      load('keyword'),
    ]);

    expect(batches[0][0].facets).toEqual(['keyword']);
    expect(first).toEqual(second);
  });

  it('starts a fresh batch for a load arriving after the flush', async () => {
    const { engine, batches } = recordingEngine();
    const load = createFacetLoader(engine, dataset, baseQuery);

    await load('keyword');
    await load('status');

    expect(batches).toHaveLength(2);
    expect(batches[0][0].facets).toEqual(['keyword']);
    expect(batches[1][0].facets).toEqual(['status']);
  });

  it('degrades every field of a failed dispatch to [], reporting each', async () => {
    const failed: [string, unknown][] = [];
    const engine: SearchEngine = {
      schema: searchSchema(dataset),
      async search() {
        throw new Error('not under test');
      },
      async searchFacets() {
        throw new Error('facet backend unavailable');
      },
    };
    const load = createFacetLoader(engine, dataset, baseQuery, (field, error) =>
      failed.push([field, error]),
    );

    const [keyword, status] = await Promise.all([
      load('keyword'),
      load('status'),
    ]);

    expect(keyword).toEqual([]);
    expect(status).toEqual([]);
    expect(failed.map(([field]) => field).sort()).toEqual([
      'keyword',
      'status',
    ]);
  });
});
