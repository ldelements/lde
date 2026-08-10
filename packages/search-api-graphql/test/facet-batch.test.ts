import { describe, expect, it } from 'vitest';
import {
  searchSchema,
  type FacetsOutcome,
  type SearchEngine,
  type SearchQuery,
} from '@lde/search';
import { createFacetLoader, groupFacetQueries } from '../src/facet-batch.js';

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
              [{ value: `${field}-value`, count: 1 }],
            ]),
          ),
        }));
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
        { or: [{ field: 'keyword', in: ['x'] }] },
        { or: [{ field: 'status', in: ['valid'] }] },
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
        where: [{ or: [{ field: 'status', in: ['valid'] }] }],
        facets: ['keyword'],
        limit: 0,
        offset: 0,
      },
      {
        ...filtered,
        where: [{ or: [{ field: 'keyword', in: ['x'] }] }],
        facets: ['status'],
        limit: 0,
        offset: 0,
      },
    ]);
  });

  it('keeps a multi-field clause whole: it is no single facet’s own', () => {
    // The entity-page query: one IRI across several fields. The user never made
    // a selection on `keyword` or `publisher`, so there is nothing to widen
    // there – keeping the clause is what leaves each facet complete on its own
    // field, offering exactly the values that would return hits.
    const related: SearchQuery = {
      ...baseQuery,
      where: [
        {
          or: [
            { field: 'keyword', in: ['urn:vg'] },
            { field: 'publisher', in: ['urn:vg'] },
          ],
        },
      ],
    };
    const queries = groupFacetQueries(related, ['keyword', 'publisher']);
    // No facet owns the clause, so the sidebar stays ONE query, and its where
    // is untouched.
    expect(queries).toEqual([
      {
        ...related,
        facets: ['keyword', 'publisher'],
        limit: 0,
        offset: 0,
      },
    ]);
  });

  it('keeps a joined clause: a hop out is a different axis', () => {
    // Ownership is keyed by (path, field), so a condition on the publisher of a
    // work’s dataset is not a selection on the work’s OWN publisher facet.
    // Dropping it would count a corpus the sidebar is not showing.
    const joined: SearchQuery = {
      ...baseQuery,
      where: [
        { or: [{ on: ['dataset'], field: 'publisher', in: ['urn:vg'] }] },
      ],
    };
    expect(groupFacetQueries(joined, ['publisher'])).toEqual([
      { ...joined, facets: ['publisher'], limit: 0, offset: 0 },
    ]);
  });

  it('drops a facet’s own single-field clause while keeping a multi-field one', () => {
    const both: SearchQuery = {
      ...baseQuery,
      where: [
        {
          or: [
            { field: 'keyword', in: ['urn:vg'] },
            { field: 'publisher', in: ['urn:vg'] },
          ],
        },
        { or: [{ field: 'keyword', in: ['atlas'] }] },
      ],
    };
    const queries = groupFacetQueries(both, ['keyword']);
    // Only the clause that names `keyword` ALONE is its own and drops; the
    // cross-field clause stays, so the buckets still describe the related set.
    expect(queries).toEqual([
      {
        ...both,
        where: [
          {
            or: [
              { field: 'keyword', in: ['urn:vg'] },
              { field: 'publisher', in: ['urn:vg'] },
            ],
          },
        ],
        facets: ['keyword'],
        limit: 0,
        offset: 0,
      },
    ]);
  });

  it('drops a same-field disjunction from its own facet', () => {
    // Every criterion names `keyword`, so the clause IS a selection on that one
    // axis – a multi-select, or two ranges on one field. Skip-own-filter must
    // drop it; keeping it would compute the facet with the user’s own selection
    // applied, offering back only what they already picked.
    const sameField: SearchQuery = {
      ...baseQuery,
      where: [
        {
          or: [
            { field: 'keyword', in: ['atlas'] },
            { field: 'keyword', in: ['kaarten'] },
          ],
        },
      ],
    };
    expect(groupFacetQueries(sameField, ['keyword'])).toEqual([
      { ...sameField, where: [], facets: ['keyword'], limit: 0, offset: 0 },
    ]);
  });

  it('treats a clause with no criteria as nobody’s own', () => {
    // A vacuous clause constrains nothing, so it is not a selection on any
    // axis – it stays put and no facet claims it.
    const vacuous: SearchQuery = { ...baseQuery, where: [{ or: [] }] };
    expect(groupFacetQueries(vacuous, ['keyword'])).toEqual([
      { ...vacuous, facets: ['keyword'], limit: 0, offset: 0 },
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

  it('degrades only the facets of a failed query outcome, keeping its siblings', async () => {
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
        // Fail exactly the own-filtered status query; answer the rest.
        return queries.map((query) =>
          query.facets.includes('status')
            ? { error: new Error('status query failed') }
            : {
                facets: Object.fromEntries(
                  query.facets.map((field) => [
                    field,
                    [{ value: `${field}-value`, count: 1 }],
                  ]),
                ),
              },
        );
      },
    };
    const filtered: SearchQuery = {
      ...baseQuery,
      where: [{ or: [{ field: 'status', in: ['valid'] }] }],
    };
    const load = createFacetLoader(engine, dataset, filtered, (field) =>
      failed.push(field),
    );

    const [keyword, status] = await Promise.all([
      load('keyword'),
      load('status'),
    ]);

    // The shared keyword query keeps its buckets; only status degraded.
    expect(keyword).toEqual([{ value: 'keyword-value', count: 1 }]);
    expect(status).toEqual([]);
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
    const load = createFacetLoader(engine, dataset, baseQuery, (field, error) =>
      failed.push([field, error]),
    );

    const keyword = await load('keyword');

    expect(keyword).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0][0]).toBe('keyword');
    expect(String(failed[0][1])).toMatch(/no outcome/);
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
