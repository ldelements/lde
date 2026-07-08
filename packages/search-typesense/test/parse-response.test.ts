import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  searchSchema,
  type LocalizedValue,
  type SearchQuery,
  type SearchType,
  type TextField,
} from '@lde/search';
import type { Client } from 'typesense';
import {
  createTypesenseSearchEngine,
  fetchLabels,
  parseSearchResponse,
} from '../src/search.js';
import {
  fakeTypesenseClient,
  filterByIds,
  labelLookup,
} from './fake-typesense-client.js';

// Document-search hits referencing labelled organizations; the second stores
// a scalar (non-array) reference value. Shared by the label fakes.
const referenceHits = {
  found: 2,
  hits: [
    { document: { id: 'https://d/1', publisher: ['https://org/1'] } },
    { document: { id: 'https://d/2', publisher: 'https://org/2' } },
  ],
};

// The label source the `publisher` reference resolves against; its collection
// is the `labels` entry in the engines' `collections` maps below.
const organization: SearchType = {
  name: 'Organization',
  type: 'https://example.org/Organization',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
};

const schema: SearchType = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
    },
    {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
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
    { name: 'size', kind: 'integer', output: true },
    { name: 'datePosted', kind: 'date', output: true },
    { name: 'iiif', kind: 'boolean', facetable: true, output: true },
    // A non-output field is never reconstructed into the logical document.
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
  ],
};

/** The engine-facing schema and collections wiring shared by the label tests. */
const labelledSchema = () => searchSchema(organization, schema);
const labelledCollections = { Dataset: 'datasets', Organization: 'labels' };

const labels = new Map<string, LocalizedValue>([
  ['https://org/1', { nl: ['Het Utrechts Archief'] }],
  ['https://org/2', { nl: ['Rijksmuseum'], en: ['Rijksmuseum'] }],
]);

const response = {
  found: 2,
  hits: [
    {
      document: {
        id: 'https://d/1',
        title_nl: 'Titel',
        title_en: 'Title',
        keyword: ['kaarten'],
        publisher: ['https://org/1'],
        size: 1234,
        datePosted: 1_700_000_000,
        iiif: true,
        status: 'valid',
      },
    },
    {
      document: {
        id: 'https://d/2',
        title_nl: 'Andere',
        keyword: ['atlas', 'kaart'],
        publisher: ['https://org/2', 'https://org/3'],
      },
    },
  ],
  facet_counts: [
    {
      field_name: 'keyword',
      counts: [
        { value: 'kaarten', count: 3 },
        { value: 'atlas', count: 1 },
      ],
    },
    {
      // A reference facet: buckets are keyed by IRI and carry resolved labels.
      field_name: 'publisher',
      counts: [
        { value: 'https://org/1', count: 2 },
        { value: 'https://org/3', count: 1 },
      ],
    },
  ],
};

describe('parseSearchResponse', () => {
  const result = parseSearchResponse(response, schema, labels);

  it('carries the total and the facet buckets keyed by field name', () => {
    expect(result.total).toBe(2);
    // A plain facet: buckets carry no label.
    expect(result.facets.keyword).toEqual([
      { value: 'kaarten', count: 3 },
      { value: 'atlas', count: 1 },
    ]);
  });

  it('attaches resolved labels to reference-facet buckets, id-only when unlabelled', () => {
    expect(result.facets.publisher).toEqual([
      {
        value: 'https://org/1',
        count: 2,
        label: { nl: ['Het Utrechts Archief'] },
      },
      { value: 'https://org/3', count: 1 },
    ]);
  });

  it('reconstructs localized text into a best-available language map', () => {
    expect(result.hits[0].id).toBe('https://d/1');
    expect(result.hits[0].document.title).toEqual({
      nl: ['Titel'],
      en: ['Title'],
    });
    // Only the present locale is emitted.
    expect(result.hits[1].document.title).toEqual({ nl: ['Andere'] });
  });

  it('resolves reference IRIs to labelled references, id-only when unlabelled', () => {
    expect(result.hits[0].document.publisher).toEqual([
      { id: 'https://org/1', label: { nl: ['Het Utrechts Archief'] } },
    ]);
    expect(result.hits[1].document.publisher).toEqual([
      {
        id: 'https://org/2',
        label: { nl: ['Rijksmuseum'], en: ['Rijksmuseum'] },
      },
      { id: 'https://org/3' },
    ]);
  });

  it('passes keyword arrays and numeric scalars through, and omits absent fields', () => {
    expect(result.hits[0].document.keyword).toEqual(['kaarten']);
    expect(result.hits[0].document.size).toBe(1234);
    expect(result.hits[0].document.datePosted).toBe(1_700_000_000);
    expect(result.hits[1].document.size).toBeUndefined();
  });

  it('defaults an absent boolean to false and never reconstructs non-output fields', () => {
    expect(result.hits[0].document.iiif).toBe(true);
    expect(result.hits[1].document.iiif).toBe(false);
    expect(result.hits[0].document.status).toBeUndefined();
  });
});

describe('parseSearchResponse range facets', () => {
  const rangeSchema: SearchType = {
    name: 'Dataset',
    type: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'size',
        kind: 'integer',
        facetable: true,
        output: true,
        facetRanges: [
          { key: '0', min: 1, max: 10 },
          { key: '1', min: 10, max: 100 },
          // Open-ended top bin: no upper bound.
          { key: '2', min: 100 },
        ],
      },
    ],
  };

  const rangeResponse = {
    found: 5,
    hits: [],
    facet_counts: [
      {
        field_name: 'size',
        counts: [
          { value: '0', count: 2 },
          { value: '1', count: 1 },
          { value: '2', count: 2 },
        ],
      },
    ],
  };

  it('echoes each range bin’s half-open bounds onto its bucket, open ends omitted', () => {
    const result = parseSearchResponse(rangeResponse, rangeSchema, new Map());
    expect(result.facets.size).toEqual([
      { value: '0', count: 2, min: 1, max: 10 },
      { value: '1', count: 1, min: 10, max: 100 },
      // The open-ended top bin carries only its lower bound.
      { value: '2', count: 2, min: 100 },
    ]);
  });
});

describe('createTypesenseSearchEngine label degradation', () => {
  const baseQuery: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('degrades to id-only references when the label lookup fails, reporting the cause', async () => {
    let capturedError: unknown;
    // The document search succeeds but the label lookup (multi_search)
    // rejects, so the engine must degrade to id-only references.
    const { client } = fakeTypesenseClient({
      searchResponse: referenceHits,
      multiSearch: () => {
        throw new Error('labels collection unavailable');
      },
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
      onLabelError: (error) => {
        capturedError = error;
      },
    });
    const result = await engine.search(schema, baseQuery);
    // The reference is present but unlabelled: the failed lookup degraded
    // rather than failing the whole search.
    expect(result.hits[0].document.publisher).toEqual([
      { id: 'https://org/1' },
    ]);
    expect(result.hits[1].document.publisher).toEqual([
      { id: 'https://org/2' },
    ]);
    expect(capturedError).toBeInstanceOf(Error);
  });
});

describe('createTypesenseSearchEngine label cache (labelCacheTtlMs)', () => {
  const baseQuery: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  // One labels document, as the export endpoint streams it (JSONL).
  const labelsJsonl = JSON.stringify({
    id: 'https://org/1',
    label: 'Het Utrechts Archief',
    label_nl: 'Het Utrechts Archief',
  });

  // Document search always answers `referenceHits`; the `labels` collection
  // export is driven per test, its call count observable via `exportCalls`.
  function fakeClient(exportImpl: () => Promise<string>) {
    return fakeTypesenseClient({
      searchResponse: referenceHits,
      exportJsonl: exportImpl,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the collection once for concurrent searches (single-flight)', async () => {
    const { client, exportCalls } = fakeClient(() =>
      Promise.resolve(labelsJsonl),
    );
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
      labelCacheTtlMs: 60_000,
    });

    const results = await Promise.all([
      engine.search(schema, baseQuery),
      engine.search(schema, baseQuery),
      engine.search(schema, baseQuery),
    ]);

    // One export served all three concurrent searches.
    expect(exportCalls()).toBe(1);
    for (const result of results) {
      expect(result.hits[0].document.publisher).toEqual([
        { id: 'https://org/1', label: { nl: ['Het Utrechts Archief'] } },
      ]);
    }
  });

  it('serves a later search from cache without a second export', async () => {
    const { client, exportCalls } = fakeClient(() =>
      Promise.resolve(labelsJsonl),
    );
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
      labelCacheTtlMs: 60_000,
    });

    await engine.search(schema, baseQuery);
    await engine.search(schema, baseQuery);

    expect(exportCalls()).toBe(1);
  });

  it('reloads the collection after the TTL expires', async () => {
    vi.useFakeTimers();
    const { client, exportCalls } = fakeClient(() =>
      Promise.resolve(labelsJsonl),
    );
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
      labelCacheTtlMs: 1000,
    });

    await engine.search(schema, baseQuery);
    expect(exportCalls()).toBe(1);

    // Within the TTL: still cached.
    vi.advanceTimersByTime(500);
    await engine.search(schema, baseQuery);
    expect(exportCalls()).toBe(1);

    // Past the TTL: reload.
    vi.advanceTimersByTime(600);
    await engine.search(schema, baseQuery);
    expect(exportCalls()).toBe(2);
  });

  it('degrades to id-only references on a load error and retries next time', async () => {
    let capturedError: unknown;
    let attempt = 0;
    const { client, exportCalls } = fakeClient(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('labels collection unavailable'))
        : Promise.resolve(labelsJsonl);
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
      labelCacheTtlMs: 60_000,
      onLabelError: (error) => {
        capturedError = error;
      },
    });

    // First load fails: id-only reference, error reported, nothing cached.
    const failed = await engine.search(schema, baseQuery);
    expect(failed.hits[0].document.publisher).toEqual([
      { id: 'https://org/1' },
    ]);
    expect(capturedError).toBeInstanceOf(Error);
    expect(exportCalls()).toBe(1);

    // Next search retries the load (the failure was not cached) and resolves.
    const recovered = await engine.search(schema, baseQuery);
    expect(recovered.hits[0].document.publisher).toEqual([
      { id: 'https://org/1', label: { nl: ['Het Utrechts Archief'] } },
    ]);
    expect(exportCalls()).toBe(2);
  });
});

describe('createTypesenseSearchEngine searchFacets (multi_search batching)', () => {
  const facetBrowse: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 0,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('sends the whole batch as ONE multi_search and maps the results positionally', async () => {
    const { client, performs } = fakeTypesenseClient({
      multiSearch: (search) => ({
        found: 0,
        hits: [],
        facet_counts: [
          {
            field_name: search.facet_by,
            counts: [{ value: `${search.facet_by}-value`, count: 1 }],
          },
        ],
      }),
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
    });

    const outcomes = await engine.searchFacets(schema, [
      { ...facetBrowse, facets: ['keyword'] },
      // A non-zero limit still compiles facet-only: the port never returns
      // hits, so the adapter normalizes rather than transferring a page.
      { ...facetBrowse, limit: 10, facets: ['status'] },
    ]);

    expect(performs).toHaveLength(1);
    expect(performs[0]).toHaveLength(2);
    expect(performs[0][0]).toMatchObject({
      collection: 'datasets',
      facet_by: 'keyword',
      per_page: 0,
    });
    expect(performs[0][1]).toMatchObject({
      collection: 'datasets',
      facet_by: 'status',
      per_page: 0,
    });
    expect(outcomes[0]).toEqual({
      facets: { keyword: [{ value: 'keyword-value', count: 1 }] },
    });
    expect(outcomes[1]).toEqual({
      facets: { status: [{ value: 'status-value', count: 1 }] },
    });
  });

  it('makes no request for an empty batch', async () => {
    const { client, performs } = fakeTypesenseClient({
      multiSearch: () => ({ found: 0, hits: [] }),
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
    });
    await expect(engine.searchFacets(schema, [])).resolves.toEqual([]);
    expect(performs).toHaveLength(0);
  });

  it('reports a failed entry as an in-place error outcome, keeping its siblings', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (_search, index) =>
        index === 1
          ? { code: 404, error: 'collection not found' }
          : { found: 0, hits: [], facet_counts: [] },
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
    });

    const outcomes = await engine.searchFacets(schema, [
      { ...facetBrowse, facets: ['keyword'] },
      { ...facetBrowse, facets: ['status'] },
    ]);

    // The sibling entry's facets survive the failed one.
    expect(outcomes[0]).toEqual({ facets: {} });
    const failed = outcomes[1];
    if (!('error' in failed)) {
      throw new Error('Expected an error outcome.');
    }
    // The error names the failed query's facets, not its batch position.
    expect(String(failed.error)).toMatch(
      /facet search for “status” failed \(404\): collection not found/,
    );
  });

  it('reports a failed entry that carries no status code', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: () => ({ error: 'malformed query' }),
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
    });
    const [outcome] = await engine.searchFacets(schema, [
      { ...facetBrowse, facets: ['keyword'] },
    ]);
    if (!('error' in outcome)) {
      throw new Error('Expected an error outcome.');
    }
    expect(String(outcome.error)).toMatch(
      /facet search for “keyword” failed: malformed query/,
    );
  });

  it('serves batch labels from the in-memory cache without a per-batch lookup', async () => {
    const { client, performs, exportCalls } = fakeTypesenseClient({
      exportJsonl: () =>
        Promise.resolve(
          JSON.stringify({
            id: 'https://org/1',
            label_nl: 'Het Utrechts Archief',
          }),
        ),
      multiSearch: () => ({
        found: 0,
        hits: [],
        facet_counts: [
          {
            field_name: 'publisher',
            counts: [{ value: 'https://org/1', count: 1 }],
          },
        ],
      }),
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
      labelCacheTtlMs: 60_000,
    });

    const outcomes = await engine.searchFacets(schema, [
      { ...facetBrowse, facets: ['publisher'] },
    ]);

    // ONE export populated the cache; the only multi_search is the facet
    // batch itself – no per-batch label lookup.
    expect(exportCalls()).toBe(1);
    expect(performs).toHaveLength(1);
    expect(outcomes[0]).toEqual({
      facets: {
        publisher: [
          {
            value: 'https://org/1',
            count: 1,
            label: { nl: ['Het Utrechts Archief'] },
          },
        ],
      },
    });
  });

  it('resolves reference-facet labels for the whole batch in one bundled lookup', async () => {
    const labelDocs: Record<string, Record<string, unknown>> = {
      'https://org/1': { label_nl: 'Het Utrechts Archief' },
      'https://org/2': { label_nl: 'Rijksmuseum' },
    };
    const { client, performs } = fakeTypesenseClient({
      multiSearch: (search, index) =>
        search.collection === 'labels'
          ? labelLookup(labelDocs)(search)
          : {
              found: 0,
              hits: [],
              facet_counts: [
                {
                  field_name: 'publisher',
                  counts: [
                    {
                      value: index === 0 ? 'https://org/1' : 'https://org/2',
                      count: 1,
                    },
                  ],
                },
              ],
            },
    });
    const engine = createTypesenseSearchEngine(client, labelledSchema(), {
      collections: labelledCollections,
    });

    const outcomes = await engine.searchFacets(schema, [
      { ...facetBrowse, facets: ['publisher'] },
      {
        ...facetBrowse,
        where: [{ field: 'status', in: ['valid'] }],
        facets: ['publisher'],
      },
    ]);

    // One facet multi_search + ONE label lookup shared by the whole batch.
    expect(performs).toHaveLength(2);
    expect(performs[1]).toHaveLength(1);
    expect(outcomes[0]).toEqual({
      facets: {
        publisher: [
          {
            value: 'https://org/1',
            count: 1,
            label: { nl: ['Het Utrechts Archief'] },
          },
        ],
      },
    });
    expect(outcomes[1]).toEqual({
      facets: {
        publisher: [
          { value: 'https://org/2', count: 1, label: { nl: ['Rijksmuseum'] } },
        ],
      },
    });
  });
});

describe('fetchLabels', () => {
  // Resolving via multi_search/POST avoids the GET query-string limit that a
  // large id-list would otherwise overflow; each POST's per-search id-lists
  // are recoverable from `performs` so batching is observable.
  const labelsSource = {
    collection: 'labels',
    labelField: organization.fields[0] as TextField,
    queryBy: 'label_search_nl',
  };
  const group = (iris: readonly string[]) => [{ source: labelsSource, iris }];

  it('resolves labels via multi_search, merging per-locale variants', async () => {
    const { client, performs } = fakeTypesenseClient({
      multiSearch: labelLookup({
        'https://org/1': { label: 'KB', label_nl: 'KB' },
        // Only a default label (no locale variant) → untagged (`und`) fallback.
        'https://org/3': { label: 'Untagged' },
      }),
    });
    const labels = await fetchLabels(
      client,
      group(['https://org/1', 'https://org/2', 'https://org/3']),
    );
    expect(labels.get('https://org/1')).toEqual({ nl: ['KB'] });
    expect(labels.get('https://org/3')).toEqual({ und: ['Untagged'] });
    // An IRI absent from the collection yields no entry.
    expect(labels.has('https://org/2')).toBe(false);
    expect(performs).toHaveLength(1);
  });

  it('batches a large id-list under the per_page cap, in a single POST', async () => {
    const ids = Array.from(
      { length: 450 },
      (_unused, index) => `https://example.org/class/${index}`,
    );
    const docsById = Object.fromEntries(
      ids.map((id) => [id, { label_nl: id }]),
    );
    const { client, performs } = fakeTypesenseClient({
      multiSearch: labelLookup(docsById),
    });
    const labels = await fetchLabels(client, group(ids));
    // 450 ids → batches of 200, 200, 50, bundled into one round-trip.
    expect(performs).toHaveLength(1);
    expect(
      performs[0].map((search) => filterByIds(String(search.filter_by)).length),
    ).toEqual([200, 200, 50]);
    expect(labels.size).toBe(450);
  });

  it('makes no request for an empty id-list', async () => {
    const { client, performs } = fakeTypesenseClient({
      multiSearch: labelLookup({}),
    });
    const labels = await fetchLabels(client, group([]));
    expect(labels.size).toBe(0);
    expect(performs).toHaveLength(0);
  });

  it('reports an inline multi_search error via onError, skipping only that source', async () => {
    // multi_search reports a failed entry inline (the call still resolves).
    // fetchLabels reports it via onError and skips that source, so healthy
    // sources still resolve and the failed source falls back to id-only.
    const termsSource = {
      collection: 'terms',
      labelField: organization.fields[0] as TextField,
      queryBy: 'label_search_und',
    };
    const errors: Error[] = [];
    const { client } = fakeTypesenseClient({
      multiSearch: (search) =>
        String(search.collection) === 'labels'
          ? { code: 503, error: 'lookup failed' }
          : labelLookup({ 'https://term/1': { label: 'Cartography' } })(search),
    });

    const labels = await fetchLabels(
      client,
      [
        { source: labelsSource, iris: ['https://org/1'] },
        { source: termsSource, iris: ['https://term/1'] },
      ],
      (error) => errors.push(error),
    );

    // The failed source contributes nothing; the healthy one resolves.
    expect(labels.has('https://org/1')).toBe(false);
    expect(labels.get('https://term/1')).toEqual({ und: ['Cartography'] });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(
      /label lookup in .labels. failed \(503\): lookup failed/,
    );

    // An error entry without a status code is reported without a code suffix.
    const noCode: Error[] = [];
    const { client: clientWithoutCode } = fakeTypesenseClient({
      multiSearch: () => ({ error: 'lookup failed' }),
    });
    await fetchLabels(clientWithoutCode, group(['https://org/1']), (error) =>
      noCode.push(error),
    );
    expect(noCode[0].message).toMatch(
      /label lookup in .labels. failed: lookup failed/,
    );
  });
});

describe('und-locale text reconstruction', () => {
  it('gathers the und display field into the language map', () => {
    const result = parseSearchResponse(
      {
        found: 1,
        hits: [
          {
            document: {
              id: 'https://d/1',
              summary_und: 'Plain prose',
              bad_und: 1,
              publisher: 'https://o/1',
            },
          },
        ],
      },
      {
        name: 'Doc',
        type: 'urn:example:Doc',
        fields: [
          { name: 'summary', kind: 'text', locales: ['und'], output: true },
          // A non-string stored value for a text field is dropped.
          { name: 'bad', kind: 'text', locales: ['und'], output: true },
          // A single (non-array) stored reference IRI.
          {
            name: 'publisher',
            kind: 'reference',
            output: true,
            ref: { typeName: 'Organization', strategy: 'labelOnly' },
          },
        ],
      },
      new Map(),
    );
    expect(result.hits[0].document.summary).toEqual({ und: ['Plain prose'] });
    expect(result.hits[0].document).not.toHaveProperty('bad');
    expect(result.hits[0].document.publisher).toEqual({ id: 'https://o/1' });
  });
});

describe('schema binding', () => {
  // These reject before any client call is made.
  const noClient = {} as unknown as Client;
  const browse: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 1,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('rejects a search type outside the bound schema', async () => {
    const foreign: SearchType = {
      name: 'Other',
      type: 'urn:example:Other',
      fields: [],
    };
    const engine = createTypesenseSearchEngine(noClient, labelledSchema(), {
      collections: labelledCollections,
    });
    await expect(engine.search(foreign, browse)).rejects.toThrow(
      /not in this engine/,
    );
  });

  it('rejects a missing collection at construction, not on the first search', () => {
    const other: SearchType = {
      name: 'Other',
      type: 'urn:example:Other',
      fields: [],
    };
    expect(() =>
      createTypesenseSearchEngine(
        noClient,
        searchSchema(organization, schema, other),
        // The widened schema loses compile-time exhaustiveness; the
        // constructor still rejects the missing entry at startup.
        { collections: labelledCollections },
      ),
    ).toThrow(/No collection configured for search type “Other”/);
  });
});
