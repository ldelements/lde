import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  searchSchema,
  type SearchEngine,
  type SearchQuery,
  type SearchType,
} from '@lde/search';
import { describeSearchEngineContract } from '@lde/search/testing';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { TypesenseContainer } from './typesense-container.js';

// The label source `publisher` resolves against: a first-class search type
// whose collection is built from the same declaration.
const organizationSchema: SearchType = {
  name: 'Organization',
  class: 'https://example.org/Organization',
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

// The shape a surfaced inline reference carries: a Reference Type, declaring
// no class, reached only through `Dataset.media`.
const mediaObjectSchema: SearchType = {
  name: 'MediaObject',
  fields: [
    {
      name: 'contentUrl',
      kind: 'keyword',
      array: true,
      output: true,
      path: 'https://schema.org/contentUrl',
    },
    {
      name: 'width',
      kind: 'integer',
      output: true,
      path: 'https://schema.org/width',
    },
  ],
};

const datasetSchema: SearchType = {
  name: 'Dataset',
  class: 'http://www.w3.org/ns/dcat#Dataset',
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
    {
      name: 'media',
      kind: 'reference',
      array: true,
      output: true,
      path: 'https://schema.org/associatedMedia',
      ref: { typeName: 'MediaObject', strategy: 'inline' },
    },
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
    { name: 'statusRank', kind: 'integer', sortable: true },
    { name: 'iiif', kind: 'boolean', facetable: true, filterable: true },
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
    // A surfaced inline reference: one nested document per referent, exactly as
    // the projection nests them. The second referent is a blank node in the
    // source, so it carries no `id`, and it has no width.
    media: [
      {
        id: 'https://ex/m/1',
        contentUrl: ['https://ex/1/full/max/0/default.jpg'],
        width: 4096,
      },
      { contentUrl: ['https://ex/2/full/max/0/default.jpg'] },
    ],
    status: 'valid',
    statusRank: 0,
    iiif: true,
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
    // The negative case, so the facet reports both buckets.
    iiif: false,
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
    iiif: true,
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
    // A language OUTSIDE the declared ['nl', 'en'] locales: display-only, stored
    // via the collection's regex `label_<lang>` field (no `label_search_fr`),
    // so it must still round-trip back into the reconstructed language map.
    label_fr: 'Rijksmusée',
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

const fullSchema = searchSchema(
  organizationSchema,
  mediaObjectSchema,
  datasetSchema,
);

describe('createTypesenseSearchEngine (integration)', () => {
  const container = new TypesenseContainer();
  let client: Client;
  let engine: SearchEngine;

  beforeAll(async () => {
    client = await container.start();
    // Typesense accepts the generated schema (stemming, locales, int64, …).
    await client.collections().create(
      buildCollectionDefinition(datasetSchema, {
        name: 'datasets',
        defaultSortingField: 'statusRank',
        defaultLocale: 'nl',
        schema: fullSchema,
      }),
    );
    // The label source's collection comes from the same declarative source.
    await client
      .collections()
      .create(
        buildCollectionDefinition(organizationSchema, { name: 'labels' }),
      );
    await client
      .collections('datasets')
      .documents()
      .import(documents, { action: 'create' });
    await client
      .collections('labels')
      .documents()
      .import(labelDocuments, { action: 'create' });

    engine = createTypesenseSearchEngine(client, fullSchema, {
      collections: { Dataset: 'datasets', Organization: 'labels' },
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
      where: [{ or: [{ field: 'status', in: ['valid'] }] }],
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
        // The undeclared French display value survives the round-trip.
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'], fr: ['Rijksmusée'] },
      },
    ]);
    expect(result.hits[1].document.publisher).toEqual([
      { id: 'https://org/1', label: { nl: ['Het Utrechts Archief'] } },
    ]);
  });

  it('serves a surfaced inline reference as nested documents, values grouped per referent', async () => {
    // End to end through a real Typesense: the collection declares the nested
    // object and its nested Physical Fields, the referents survive the
    // round-trip grouped, and reconstruction hands back one nested Search
    // Document per referent – `id` only on the referent that had one.
    const result = await engine.search(datasetSchema, {
      ...baseQuery,
      where: [{ or: [{ field: 'id', in: ['d1'] }] }],
    });

    expect(result.hits[0].document.media).toEqual([
      {
        id: 'https://ex/m/1',
        contentUrl: ['https://ex/1/full/max/0/default.jpg'],
        width: 4096,
      },
      { contentUrl: ['https://ex/2/full/max/0/default.jpg'] },
    ]);
    // A document without referents nests nothing rather than an empty list.
    const others = await engine.search(datasetSchema, {
      ...baseQuery,
      where: [{ or: [{ field: 'id', in: ['d2'] }] }],
    });
    expect(others.hits[0].document.media).toBeUndefined();
  });

  it('looks documents up by `id`, the field no type declares', async () => {
    const result = await engine.search(datasetSchema, {
      ...baseQuery,
      where: [{ or: [{ field: 'id', in: ['d3', 'd1'] }] }],
      orderBy: [{ field: 'statusRank', direction: 'asc' }],
    });

    // Membership, so an id lookup is also a batch lookup – and it reaches
    // documents a `status` filter would exclude (d3 is invalid).
    expect(result.total).toBe(2);
    expect(result.hits.map((hit) => hit.id).sort()).toEqual(['d1', 'd3']);
  });

  it('carries an id batch far past the GET query-string limit', async () => {
    // The clause travels in the multi_search POST body, so the batch is bounded
    // by the request rather than by 4000 URL chars: 400 IRIs of realistic
    // length encode to ~30 000, which the old GET transport could not send.
    const iris = Array.from(
      { length: 400 },
      (_, index) =>
        `https://id.drapo.nl/ffed9f91-4f5d-5eca-978f-ded1628${String(
          index,
        ).padStart(5, '0')}`,
    );
    const result = await engine.search(datasetSchema, {
      ...baseQuery,
      where: [{ or: [{ field: 'id', in: [...iris, 'd2'] }] }],
    });

    // Only the one real id matches; the rest simply are not there.
    expect(result.total).toBe(1);
    expect(result.hits.map((hit) => hit.id)).toEqual(['d2']);
  });

  it('answers an empty id membership with nothing, not with everything', async () => {
    // A client mapping a possibly-empty reference array into a batch lookup
    // asked for no document; the whole collection would be the wrong answer.
    const result = await engine.search(datasetSchema, {
      ...baseQuery,
      where: [{ or: [{ field: 'id', in: [] }] }],
    });

    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('answers facets for an unsatisfiable query as empty, siblings intact', async () => {
    const [unsatisfiable, sibling] = await engine.searchFacets(datasetSchema, [
      {
        ...baseQuery,
        limit: 0,
        where: [{ or: [{ field: 'id', in: [] }] }],
        facets: ['status'],
      },
      { ...baseQuery, limit: 0, facets: ['status'] },
    ]);

    if ('error' in unsatisfiable || 'error' in sibling) {
      throw new Error('expected both facet outcomes to succeed');
    }
    expect(unsatisfiable.facets).toEqual({});
    // The satisfiable sibling still gets its real counts, positionally aligned.
    expect(sibling.facets.status?.length).toBeGreaterThan(0);
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
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'], fr: ['Rijksmusée'] },
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
        where: [{ or: [{ field: 'status', in: ['valid'] }] }],
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
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'], fr: ['Rijksmusée'] },
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
        where: [{ or: [{ field: 'nonexistent', in: ['x'] }] }],
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
      searchSchema(organizationSchema, mediaObjectSchema, datasetSchema),
      {
        collections: { Dataset: 'datasets', Organization: 'labels' },
        onIgnoredFilter: (filter) => ignored.push(filter),
      },
    );

    const result = await reporting.search(datasetSchema, {
      ...baseQuery,
      where: [{ or: [{ field: 'status', in: [] }] }],
    });

    expect(result.total).toBeGreaterThan(0); // empty membership = no constraint
    expect(ignored).toEqual([{ or: [{ field: 'status', in: [] }] }]);
  });
});
