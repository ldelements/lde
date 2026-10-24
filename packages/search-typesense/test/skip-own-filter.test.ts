import { describe, expect, it } from 'vitest';
import { searchSchema, type SearchQuery, type SearchType } from '@lde/search';
import { createTypesenseSearchEngine } from '../src/search.js';
import { fakeTypesenseClient } from './fake-typesense-client.js';

const datasetType: SearchType = {
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'keyword', kind: 'keyword', facetable: true, filterable: true },
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
    { name: 'iiif', kind: 'boolean', facetable: true, filterable: true },
  ],
};
const schema = searchSchema(datasetType);

const selectingAtlas: SearchQuery = {
  where: [{ or: [{ field: 'keyword', in: ['atlas'] }] }],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: ['keyword'],
  locale: 'nl',
};

/** Whether a sent search counts one selected value: no facets, no hits. */
function isCount(search: Record<string, unknown>): boolean {
  return !('facet_by' in search) && search.per_page === 0;
}

/** A facet search answering with one bucket – the cap, so `atlas` must be
 *  counted – a hits search answering with none, and a count search answered
 *  by `count`. */
function cappedClient(
  count: (search: Record<string, unknown>) => Record<string, unknown>,
) {
  return fakeTypesenseClient({
    multiSearch: (search) =>
      'facet_by' in search
        ? {
            found: 2,
            hits: [],
            facet_counts: [
              {
                field_name: 'keyword',
                counts: [{ value: 'kaarten', count: 2 }],
              },
            ],
          }
        : isCount(search)
          ? count(search)
          : { found: 0, hits: [] },
  });
}

describe('skip-own-filter', () => {
  it('counts an own-filtered facet without its own clause, in the round-trip of the hits', async () => {
    const fake = fakeTypesenseClient({
      multiSearch: (search) =>
        'facet_by' in search
          ? {
              found: 3,
              hits: [],
              facet_counts: [
                {
                  field_name: 'keyword',
                  counts: [{ value: 'kaarten', count: 2 }],
                },
                {
                  field_name: 'status',
                  counts: [{ value: 'valid', count: 1 }],
                },
              ],
            }
          : { found: 1, hits: [] },
    });
    const engine = createTypesenseSearchEngine(fake.client, schema);

    await engine.search(datasetType, {
      ...selectingAtlas,
      facets: ['keyword', 'status'],
    });

    // One request: the hits search carries the facet sharing its `where`
    // (status); the keyword facet is counted without `keyword:=atlas`.
    expect(fake.performs).toHaveLength(1);
    const [hits, keyword] = fake.performs[0] ?? [];
    expect(hits?.facet_by).toBe('status');
    expect(String(hits?.filter_by)).toContain('atlas');
    expect(keyword?.facet_by).toBe('keyword');
    expect(keyword?.filter_by ?? '').not.toContain('atlas');
    expect(keyword?.per_page).toBe(0);
  });

  it('rejects search() when counting a cut-off value fails', async () => {
    const { client } = cappedClient(() => ({ error: 'boom', code: 500 }));
    const engine = createTypesenseSearchEngine(client, schema, {
      maxFacetValues: 1,
    });
    await expect(engine.search(datasetType, selectingAtlas)).rejects.toThrow(
      'Typesense count of facet value “atlas” on “keyword” failed (500): boom',
    );
  });

  it('fails only its own query in a batch when counting a value fails', async () => {
    const { client } = cappedClient(() => ({ error: 'boom' }));
    const engine = createTypesenseSearchEngine(client, schema, {
      maxFacetValues: 1,
    });
    const [failed, sibling] = await engine.searchFacets(datasetType, [
      selectingAtlas,
      { ...selectingAtlas, where: [] },
    ]);
    expect('error' in failed && String(failed.error)).toContain(
      'Typesense count of facet value “atlas” on “keyword” failed: boom',
    );
    expect(sibling).toEqual({
      facets: { keyword: { buckets: [{ value: 'kaarten', count: 2 }] } },
    });
  });

  it('fails only its own query when the count request itself rejects', async () => {
    const { client } = cappedClient(() => {
      throw new Error('socket hang up');
    });
    const engine = createTypesenseSearchEngine(client, schema, {
      maxFacetValues: 1,
    });
    const [failed, sibling] = await engine.searchFacets(datasetType, [
      selectingAtlas,
      { ...selectingAtlas, where: [] },
    ]);
    expect('error' in failed && String(failed.error)).toContain(
      'socket hang up',
    );
    expect(sibling).toEqual({
      facets: { keyword: { buckets: [{ value: 'kaarten', count: 2 }] } },
    });
  });

  it('merges a counted value among the buckets by count', async () => {
    // A value a facet policy hid can outnumber every bucket the engine kept.
    const { client } = cappedClient(() => ({ found: 5, hits: [] }));
    const engine = createTypesenseSearchEngine(client, schema, {
      maxFacetValues: 1,
    });
    const result = await engine.search(datasetType, selectingAtlas);
    expect(result.facets.keyword?.buckets).toEqual([
      { value: 'atlas', count: 5 },
      { value: 'kaarten', count: 2 },
    ]);
  });

  it('splits counts over as many multi_search requests as Typesense accepts', async () => {
    const values = Array.from({ length: 51 }, (_, index) => `value-${index}`);
    const fake = cappedClient(() => ({ found: 1, hits: [] }));
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      maxFacetValues: 1,
    });
    const result = await engine.search(datasetType, {
      ...selectingAtlas,
      where: [{ or: [{ field: 'keyword', in: values }] }],
    });
    const countRequests = fake.performs.filter((searches) =>
      searches.every(isCount),
    );
    expect(countRequests.map((searches) => searches.length)).toEqual([50, 1]);
    expect(result.facets.keyword?.buckets).toHaveLength(52);
  });

  it('reports the selection of a query that asks for no document, at count 0', async () => {
    const fake = fakeTypesenseClient();
    const engine = createTypesenseSearchEngine(fake.client, schema);
    const unsatisfiable: SearchQuery = {
      ...selectingAtlas,
      where: [{ or: [{ field: 'id', in: [] }] }, ...selectingAtlas.where],
    };
    const [outcome] = await engine.searchFacets(datasetType, [unsatisfiable]);
    expect(outcome).toEqual({
      facets: { keyword: { buckets: [{ value: 'atlas', count: 0 }] } },
    });
    const result = await engine.search(datasetType, unsatisfiable);
    expect(result).toEqual({
      total: 0,
      hits: [],
      facets: { keyword: { buckets: [{ value: 'atlas', count: 0 }] } },
    });
    // Neither went to the engine.
    expect(fake.performs).toEqual([]);
  });

  it('reports a selected value for a facet the engine left out of the response', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: () => ({ found: 0, hits: [] }),
    });
    const engine = createTypesenseSearchEngine(client, schema);
    const result = await engine.search(datasetType, selectingAtlas);
    expect(result.facets).toEqual({
      keyword: { buckets: [{ value: 'atlas', count: 0 }] },
    });
  });

  it('counts a selected boolean the bucket cap cut off with an `is` filter', async () => {
    const fake = fakeTypesenseClient({
      multiSearch: (search) =>
        'facet_by' in search
          ? {
              found: 3,
              hits: [],
              facet_counts: [
                { field_name: 'iiif', counts: [{ value: 'true', count: 2 }] },
              ],
            }
          : { found: 1, hits: [] },
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      maxFacetValues: 1,
    });
    const [outcome] = await engine.searchFacets(datasetType, [
      {
        ...selectingAtlas,
        where: [{ or: [{ field: 'iiif', is: false }] }],
        facets: ['iiif'],
      },
    ]);
    expect(outcome).toEqual({
      facets: {
        iiif: {
          buckets: [
            { value: 'true', count: 2, is: true },
            { value: 'false', count: 1, is: false },
          ],
        },
      },
    });
    const count = fake.performs.flat().find(isCount);
    expect(count?.filter_by).toBe('iiif:=false');
  });

  it('splits a batch over as many multi_search requests as Typesense accepts', async () => {
    const fake = fakeTypesenseClient({
      multiSearch: () => ({ found: 0, hits: [], facet_counts: [] }),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema);
    const outcomes = await engine.searchFacets(
      datasetType,
      Array.from({ length: 51 }, () => ({ ...selectingAtlas, where: [] })),
    );
    expect(outcomes).toHaveLength(51);
    expect(fake.performs.map((searches) => searches.length)).toEqual([50, 1]);
  });

  it('answers a batch query without facets without a search', async () => {
    const fake = fakeTypesenseClient();
    const engine = createTypesenseSearchEngine(fake.client, schema);
    await expect(
      engine.searchFacets(datasetType, [{ ...selectingAtlas, facets: [] }]),
    ).resolves.toEqual([{ facets: {} }]);
    expect(fake.performs).toEqual([]);
  });

  it('fails a batch query as a whole when one of its searches fails', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (search) =>
        search.facet_by === 'keyword'
          ? { error: 'boom', code: 500 }
          : { found: 0, hits: [], facet_counts: [] },
    });
    const engine = createTypesenseSearchEngine(client, schema);
    const [outcome] = await engine.searchFacets(datasetType, [
      { ...selectingAtlas, facets: ['keyword', 'status'] },
    ]);
    expect('error' in outcome && String(outcome.error)).toContain(
      'Typesense facet search for “keyword” failed (500): boom',
    );
  });
});
