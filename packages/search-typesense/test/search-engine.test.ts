import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  searchSchema,
  type SearchEngine,
  type SearchQuery,
  type SearchType,
} from '@lde/search';
import { describeSearchEngineContract } from '@lde/search/testing';
import { buildCollectionSchema } from '../src/collection-schema.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { TypesenseContainer } from './typesense-container.js';

// The label source `publisher` resolves against: a first-class search type
// whose collection is built from the same declaration.
const organizationSchema: SearchType = {
  name: 'Organization',
  type: 'https://example.org/Organization',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
};

const datasetSchema: SearchType = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      searchable: { weight: 1 },
      output: true,
    },
    {
      name: 'publisher',
      kind: 'reference',
      array: true,
      facetable: true,
      output: true,
      ref: { typeName: 'Agent', strategy: 'labelOnly' },
      labelSource: 'Organization',
    },
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
    { name: 'statusRank', kind: 'integer', sortable: true },
  ],
};

// Flat documents, as the projection would emit them (physical field names).
const documents = [
  {
    id: 'd1',
    title_nl: 'Kaart van Utrecht',
    title_en: 'Map of Utrecht',
    title_search_nl: 'kaart van utrecht',
    title_search_en: 'map of utrecht',
    title_sort_nl: 'kaart van utrecht',
    title_sort_en: 'map of utrecht',
    keyword: ['kaarten'],
    keyword_search: ['kaarten'],
    publisher: ['https://org/1'],
    status: 'valid',
    statusRank: 0,
  },
  {
    id: 'd2',
    title_nl: 'Atlas der Nederlanden',
    title_search_nl: 'atlas der nederlanden',
    title_sort_nl: 'atlas der nederlanden',
    keyword: ['atlas'],
    keyword_search: ['atlas'],
    publisher: ['https://org/2'],
    status: 'valid',
    statusRank: 0,
  },
  {
    id: 'd3',
    title_nl: 'Verouderde kaart',
    title_search_nl: 'verouderde kaart',
    title_sort_nl: 'verouderde kaart',
    keyword: ['kaarten'],
    keyword_search: ['kaarten'],
    publisher: ['https://org/1'],
    status: 'invalid',
    statusRank: 3,
  },
];

// Organization documents in projected shape (per-locale display + folded
// search fields), as @lde/search's projection would emit them.
const labelDocuments = [
  {
    id: 'https://org/1',
    label_nl: 'Het Utrechts Archief',
    label_search_nl: 'het utrechts archief',
  },
  {
    id: 'https://org/2',
    label_nl: 'Rijksmuseum',
    label_en: 'Rijksmuseum',
    label_search_nl: 'rijksmuseum',
    label_search_en: 'rijksmuseum',
  },
];

const baseQuery: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};

describe('createTypesenseSearchEngine (integration)', () => {
  const container = new TypesenseContainer();
  let client: Client;
  let engine: SearchEngine;

  beforeAll(async () => {
    client = await container.start();
    // Typesense accepts the generated schema (stemming, locales, int64, …).
    await client.collections().create(
      buildCollectionSchema(datasetSchema, {
        name: 'datasets',
        defaultSortingField: 'statusRank',
        defaultLocale: 'nl',
      }),
    );
    // The label source's collection comes from the same declarative source.
    await client
      .collections()
      .create(buildCollectionSchema(organizationSchema, { name: 'labels' }));
    await client
      .collections('datasets')
      .documents()
      .import(documents, { action: 'create' });
    await client
      .collections('labels')
      .documents()
      .import(labelDocuments, { action: 'create' });

    engine = createTypesenseSearchEngine(
      client,
      searchSchema(organizationSchema, datasetSchema),
      {
        collections: { Dataset: 'datasets', Organization: 'labels' },
      },
    );
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  // The executable port contract from @lde/search/testing, run against the
  // live container-backed engine.
  describeSearchEngineContract('TypesenseSearchEngine', () => engine);

  it('filters by status, sorts by the localized title key, and resolves reference labels', async () => {
    const result = await engine.search(datasetSchema, {
      ...baseQuery,
      where: [{ field: 'status', in: ['valid'] }],
      orderBy: [
        { field: 'title', direction: 'asc' },
        { field: 'statusRank', direction: 'asc' },
      ],
    });

    // d3 is invalid → filtered out; remaining two sorted by folded title.
    expect(result.total).toBe(2);
    expect(result.hits.map((hit) => hit.id)).toEqual(['d2', 'd1']);
    expect(result.hits[0].document.title).toEqual({
      nl: ['Atlas der Nederlanden'],
    });
    expect(result.hits[0].document.publisher).toEqual([
      {
        id: 'https://org/2',
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'] },
      },
    ]);
    expect(result.hits[1].document.publisher).toEqual([
      { id: 'https://org/1', label: { nl: ['Het Utrechts Archief'] } },
    ]);
  });

  it('ranks a full-text query through the weighted query_by fields', async () => {
    const result = await engine.search(datasetSchema, {
      ...baseQuery,
      text: 'Utrecht',
      orderBy: [{ field: 'relevance', direction: 'desc' }],
    });

    expect(result.hits[0].id).toBe('d1');
    expect(result.hits.map((hit) => hit.id)).not.toContain('d2');
  });

  it('returns facet buckets with counts, labelling reference facets', async () => {
    const result = await engine.search(datasetSchema, {
      ...baseQuery,
      facets: ['keyword', 'publisher'],
    });

    // Plain facet: value + count, no label.
    const keyword = [...(result.facets.keyword ?? [])].sort(
      (a, b) => b.count - a.count,
    );
    expect(keyword).toEqual([
      { value: 'kaarten', count: 2 },
      { value: 'atlas', count: 1 },
    ]);

    // Reference facet: IRI-keyed buckets carry the resolved data label.
    const publisher = [...(result.facets.publisher ?? [])].sort(
      (a, b) => b.count - a.count,
    );
    expect(publisher).toEqual([
      {
        value: 'https://org/1',
        count: 2,
        label: { nl: ['Het Utrechts Archief'] },
      },
      {
        value: 'https://org/2',
        count: 1,
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'] },
      },
    ]);
  });

  it('answers a whole facet batch in one searchFacets call, positionally, with labelled reference buckets', async () => {
    const outcomes = await engine.searchFacets(datasetSchema, [
      // Unfiltered: counts across all documents, faceting two fields at once.
      { ...baseQuery, limit: 0, facets: ['keyword', 'publisher'] },
      // Filtered (as a skip-own-filter variant would be): valid only.
      {
        ...baseQuery,
        limit: 0,
        where: [{ field: 'status', in: ['valid'] }],
        facets: ['keyword'],
      },
    ]);

    expect(outcomes).toHaveLength(2);
    const [unfiltered, filtered] = outcomes;
    if ('error' in unfiltered || 'error' in filtered) {
      throw new Error('Expected facets outcomes.');
    }

    const keyword = [...(unfiltered.facets.keyword ?? [])].sort(
      (first, second) => second.count - first.count,
    );
    expect(keyword).toEqual([
      { value: 'kaarten', count: 2 },
      { value: 'atlas', count: 1 },
    ]);
    // Reference facets carry resolved labels, exactly as in search().
    const publisher = [...(unfiltered.facets.publisher ?? [])].sort(
      (first, second) => second.count - first.count,
    );
    expect(publisher).toEqual([
      {
        value: 'https://org/1',
        count: 2,
        label: { nl: ['Het Utrechts Archief'] },
      },
      {
        value: 'https://org/2',
        count: 1,
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'] },
      },
    ]);

    // The filtered query counts only the valid documents (d1, d2).
    const filteredKeyword = [...(filtered.facets.keyword ?? [])].sort(
      (first, second) => first.value.localeCompare(second.value),
    );
    expect(filteredKeyword).toEqual([
      { value: 'atlas', count: 1 },
      { value: 'kaarten', count: 1 },
    ]);
  });

  it('always rejects a structurally invalid query, before reaching the engine', async () => {
    await expect(
      engine.search(datasetSchema, {
        ...baseQuery,
        where: [{ field: 'nonexistent', in: ['x'] }],
      }),
    ).rejects.toThrow(/Invalid search query for “Dataset”/);
    await expect(
      engine.search(datasetSchema, { ...baseQuery, facets: ['title'] }),
    ).rejects.toThrow(/not-facetable/);
  });

  it('reports a vacuous where clause via onIgnoredFilter and still searches', async () => {
    const ignored: unknown[] = [];
    const reporting = createTypesenseSearchEngine(
      client,
      searchSchema(organizationSchema, datasetSchema),
      {
        collections: { Dataset: 'datasets', Organization: 'labels' },
        onIgnoredFilter: (filter) => ignored.push(filter),
      },
    );

    const result = await reporting.search(datasetSchema, {
      ...baseQuery,
      where: [{ field: 'status', in: [] }],
    });

    expect(result.total).toBeGreaterThan(0); // empty membership = no constraint
    expect(ignored).toEqual([{ field: 'status', in: [] }]);
  });
});
