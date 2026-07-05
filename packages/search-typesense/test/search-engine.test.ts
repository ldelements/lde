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

const datasetSchema: SearchType = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      localized: true,
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

const labelDocuments = [
  {
    id: 'https://org/1',
    label: 'Het Utrechts Archief',
    label_nl: 'Het Utrechts Archief',
    type: 'organization',
  },
  {
    id: 'https://org/2',
    label: 'Rijksmuseum',
    label_nl: 'Rijksmuseum',
    label_en: 'Rijksmuseum',
    type: 'organization',
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
    await client.collections().create({
      name: 'labels',
      fields: [
        { name: 'label', type: 'string' },
        { name: 'label_nl', type: 'string', optional: true, index: false },
        { name: 'label_en', type: 'string', optional: true, index: false },
        { name: 'type', type: 'string', facet: true },
      ],
    });
    await client
      .collections('datasets')
      .documents()
      .import(documents, { action: 'create' });
    await client
      .collections('labels')
      .documents()
      .import(labelDocuments, { action: 'create' });

    engine = createTypesenseSearchEngine(client, searchSchema(datasetSchema), {
      collection: 'datasets',
      labelsCollection: 'labels',
    });
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
      searchSchema(datasetSchema),
      {
        collection: 'datasets',
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
