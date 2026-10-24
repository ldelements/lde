import { describe, expect, it } from 'vitest';
import {
  searchSchema,
  type FacetsOutcome,
  type SearchEngine,
  type SearchQuery,
} from '@lde/search';
import { createFacetLoader } from '../src/facet-batch.js';

const dataset = {
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
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
      async searchFacets(
        _searchType,
        queries,
      ): Promise<readonly FacetsOutcome[]> {
        batches.push(queries);
        return queries.map((query) => ({
          facets: Object.fromEntries(
            query.facets.map((field) => [
              field,
              { buckets: [{ value: `${field}-value`, count: 1 }] },
            ]),
          ),
        }));
      },
    },
    batches,
  };
}

describe('createFacetLoader', () => {
  it('collects same-tick loads into one dispatch and resolves each field from it', async () => {
    const { engine, batches } = recordingEngine();
    const load = createFacetLoader(engine, dataset, baseQuery, baseQuery);

    const [keyword, status] = await Promise.all([
      load('keyword', 'matching'),
      load('status', 'matching'),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].facets).toEqual(['keyword', 'status']);
    expect(keyword).toEqual({
      buckets: [{ value: 'keyword-value', count: 1 }],
    });
    expect(status).toEqual({ buckets: [{ value: 'status-value', count: 1 }] });
  });

  it('deduplicates a field loaded twice in the same tick', async () => {
    const { engine, batches } = recordingEngine();
    const load = createFacetLoader(engine, dataset, baseQuery, baseQuery);

    const [first, second] = await Promise.all([
      load('keyword', 'matching'),
      load('keyword', 'matching'),
    ]);

    expect(batches[0][0].facets).toEqual(['keyword']);
    expect(first).toEqual(second);
  });

  it('starts a fresh batch for a load arriving after the flush', async () => {
    const { engine, batches } = recordingEngine();
    const load = createFacetLoader(engine, dataset, baseQuery, baseQuery);

    await load('keyword', 'matching');
    await load('status', 'matching');

    expect(batches).toHaveLength(2);
    expect(batches[0][0].facets).toEqual(['keyword']);
    expect(batches[1][0].facets).toEqual(['status']);
  });

  it('sends the listing query whole: the engine applies skip-own-filter', async () => {
    const { engine, batches } = recordingEngine();
    const filtered: SearchQuery = {
      ...baseQuery,
      where: [{ or: [{ field: 'status', in: ['valid'] }] }],
    };
    const load = createFacetLoader(engine, dataset, filtered, baseQuery);

    await Promise.all([
      load('keyword', 'matching'),
      load('status', 'matching'),
    ]);

    expect(batches).toEqual([
      [
        {
          ...filtered,
          facets: ['keyword', 'status'],
          limit: 0,
          offset: 0,
        },
      ],
    ]);
  });

  it('degrades only the facets of a failed query outcome, keeping the other query’s', async () => {
    const failed: string[] = [];
    const engine: SearchEngine = {
      schema: searchSchema(dataset),
      async search() {
        throw new Error('not under test');
      },
      async searchFacets(
        _searchType,
        queries,
      ): Promise<readonly FacetsOutcome[]> {
        // Fail the `all` query; answer the `matching` one.
        return queries.map((query, index) =>
          index === 1
            ? { error: new Error('unfiltered query failed') }
            : {
                facets: Object.fromEntries(
                  query.facets.map((field) => [
                    field,
                    { buckets: [{ value: `${field}-value`, count: 1 }] },
                  ]),
                ),
              },
        );
      },
    };
    const load = createFacetLoader(
      engine,
      dataset,
      baseQuery,
      baseQuery,
      (field) => failed.push(field),
    );

    const [keyword, status] = await Promise.all([
      load('keyword', 'matching'),
      load('status', 'all'),
    ]);

    expect(keyword).toEqual({
      buckets: [{ value: 'keyword-value', count: 1 }],
    });
    expect(status).toEqual({ buckets: [] });
    expect(failed).toEqual(['status']);
  });

  it('reports a facet failing in both queries once', async () => {
    const failed: string[] = [];
    const engine: SearchEngine = {
      schema: searchSchema(dataset),
      async search() {
        throw new Error('not under test');
      },
      async searchFacets(_searchType, queries) {
        return queries.map(() => ({ error: new Error('query failed') }));
      },
    };
    const load = createFacetLoader(
      engine,
      dataset,
      baseQuery,
      baseQuery,
      (field) => failed.push(field),
    );

    await Promise.all([load('status', 'matching'), load('status', 'all')]);

    expect(failed).toEqual(['status']);
  });

  it('treats a missing outcome (a port-contract breach) as a failed query', async () => {
    const failed: [string, unknown][] = [];
    const engine: SearchEngine = {
      schema: searchSchema(dataset),
      async search() {
        throw new Error('not under test');
      },
      // Shorter than the queries list: a broken engine, not empty facets.
      async searchFacets(): Promise<readonly FacetsOutcome[]> {
        return [];
      },
    };
    const load = createFacetLoader(
      engine,
      dataset,
      baseQuery,
      baseQuery,
      (field, error) => failed.push([field, error]),
    );

    const keyword = await load('keyword', 'matching');

    expect(keyword).toEqual({ buckets: [] });
    expect(failed).toHaveLength(1);
    expect(failed[0][0]).toBe('keyword');
    expect(String(failed[0][1])).toMatch(/no outcome/);
  });

  it('degrades every field of a failed dispatch to empty, reporting each', async () => {
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
    const load = createFacetLoader(
      engine,
      dataset,
      baseQuery,
      baseQuery,
      (field, error) => failed.push([field, error]),
    );

    const [keyword, status] = await Promise.all([
      load('keyword', 'matching'),
      load('status', 'matching'),
      // A second scope of the same field is still one failed facet.
      load('status', 'all'),
    ]);

    expect(keyword).toEqual({ buckets: [] });
    expect(status).toEqual({ buckets: [] });
    expect(failed.map(([field]) => field).sort()).toEqual([
      'keyword',
      'status',
    ]);
  });

  it('computes an `all` load over the unfiltered query, in the same dispatch', async () => {
    const { engine, batches } = recordingEngine();
    const filtered: SearchQuery = {
      ...baseQuery,
      text: 'kaart',
      where: [{ or: [{ field: 'keyword', in: ['x'] }] }],
    };
    const policyOnly: SearchQuery = {
      ...baseQuery,
      where: [{ or: [{ field: 'status', in: ['valid'] }] }],
    };
    const load = createFacetLoader(engine, dataset, filtered, policyOnly);

    await Promise.all([load('status', 'matching'), load('status', 'all')]);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { ...filtered, facets: ['status'], limit: 0, offset: 0 },
      { ...policyOnly, facets: ['status'], limit: 0, offset: 0 },
    ]);
  });
});
