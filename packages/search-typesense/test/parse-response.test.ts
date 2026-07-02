import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalizedValue, SearchQuery, SearchType } from '@lde/search';
import type { Client } from 'typesense';
import {
  createTypesenseSearchEngine,
  fetchLabels,
  parseSearchResponse,
} from '../src/search.js';

const schema: SearchType = {
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      kind: 'text',
      localized: true,
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
      ref: { type: 'http://xmlns.com/foaf/0.1/Agent', strategy: 'labelOnly' },
    },
    { name: 'size', kind: 'integer', output: true },
    { name: 'datePosted', kind: 'date', output: true },
    { name: 'iiif', kind: 'boolean', facetable: true, output: true },
    // A non-output field is never reconstructed into the logical document.
    { name: 'status', kind: 'keyword', facetable: true, filterable: true },
  ],
};

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

  // A fake client whose document search succeeds but whose label lookup
  // (multi_search) rejects, so the engine must degrade to id-only references.
  function fakeClient(): Client {
    return {
      collections: () => ({
        documents: () => ({
          search: () =>
            Promise.resolve({
              found: 1,
              hits: [
                {
                  document: { id: 'https://d/1', publisher: ['https://org/1'] },
                },
              ],
            }),
        }),
      }),
      multiSearch: {
        perform: () =>
          Promise.reject(new Error('labels collection unavailable')),
      },
    } as unknown as Client;
  }

  it('degrades to id-only references when the label lookup fails, reporting the cause', async () => {
    let capturedError: unknown;
    const engine = createTypesenseSearchEngine(fakeClient(), {
      collection: 'datasets',
      labelsCollection: 'labels',
      onLabelError: (error) => {
        capturedError = error;
      },
    });
    const result = await engine.search(baseQuery, schema);
    // The reference is present but unlabelled: the failed lookup degraded
    // rather than failing the whole search.
    expect(result.hits[0].document.publisher).toEqual([
      { id: 'https://org/1' },
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

  // A fake client whose document search always returns one hit referencing
  // `https://org/1`, and whose `labels` collection export is driven by
  // `exportImpl`. Counters make the export-call count observable.
  function fakeClient(exportImpl: () => Promise<string>) {
    let exportCalls = 0;
    const client = {
      collections: () => ({
        documents: () => ({
          search: () =>
            Promise.resolve({
              found: 1,
              hits: [
                {
                  document: { id: 'https://d/1', publisher: ['https://org/1'] },
                },
              ],
            }),
          export: () => {
            exportCalls += 1;
            return exportImpl();
          },
        }),
      }),
    };
    return {
      client: client as unknown as Client,
      exportCalls: () => exportCalls,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the collection once for concurrent searches (single-flight)', async () => {
    const { client, exportCalls } = fakeClient(() =>
      Promise.resolve(labelsJsonl),
    );
    const engine = createTypesenseSearchEngine(client, {
      collection: 'datasets',
      labelsCollection: 'labels',
      labelCacheTtlMs: 60_000,
    });

    const results = await Promise.all([
      engine.search(baseQuery, schema),
      engine.search(baseQuery, schema),
      engine.search(baseQuery, schema),
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
    const engine = createTypesenseSearchEngine(client, {
      collection: 'datasets',
      labelsCollection: 'labels',
      labelCacheTtlMs: 60_000,
    });

    await engine.search(baseQuery, schema);
    await engine.search(baseQuery, schema);

    expect(exportCalls()).toBe(1);
  });

  it('reloads the collection after the TTL expires', async () => {
    vi.useFakeTimers();
    const { client, exportCalls } = fakeClient(() =>
      Promise.resolve(labelsJsonl),
    );
    const engine = createTypesenseSearchEngine(client, {
      collection: 'datasets',
      labelsCollection: 'labels',
      labelCacheTtlMs: 1000,
    });

    await engine.search(baseQuery, schema);
    expect(exportCalls()).toBe(1);

    // Within the TTL: still cached.
    vi.advanceTimersByTime(500);
    await engine.search(baseQuery, schema);
    expect(exportCalls()).toBe(1);

    // Past the TTL: reload.
    vi.advanceTimersByTime(600);
    await engine.search(baseQuery, schema);
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
    const engine = createTypesenseSearchEngine(client, {
      collection: 'datasets',
      labelsCollection: 'labels',
      labelCacheTtlMs: 60_000,
      onLabelError: (error) => {
        capturedError = error;
      },
    });

    // First load fails: id-only reference, error reported, nothing cached.
    const failed = await engine.search(baseQuery, schema);
    expect(failed.hits[0].document.publisher).toEqual([
      { id: 'https://org/1' },
    ]);
    expect(capturedError).toBeInstanceOf(Error);
    expect(exportCalls()).toBe(1);

    // Next search retries the load (the failure was not cached) and resolves.
    const recovered = await engine.search(baseQuery, schema);
    expect(recovered.hits[0].document.publisher).toEqual([
      { id: 'https://org/1', label: { nl: ['Het Utrechts Archief'] } },
    ]);
    expect(exportCalls()).toBe(2);
  });
});

describe('fetchLabels', () => {
  // A fake Typesense client whose multi_search returns the requested ids that
  // exist in `docsById`, recording the id-list of each POST so batching is
  // observable. (Resolving via multi_search/POST avoids the GET query-string
  // limit that a large id-list would otherwise overflow.)
  function fakeClient(docsById: Record<string, Record<string, unknown>>) {
    const calls: string[][] = [];
    const client = {
      multiSearch: {
        perform: (request: { searches: { readonly filter_by: string }[] }) => {
          const ids = [
            ...request.searches[0].filter_by.matchAll(/`([^`]+)`/g),
          ].map((match) => match[1]);
          calls.push(ids);
          const hits = ids
            .filter((id) => docsById[id] !== undefined)
            .map((id) => ({ document: { id, ...docsById[id] } }));
          return Promise.resolve({ results: [{ found: hits.length, hits }] });
        },
      },
    };
    return { client: client as unknown as Pick<Client, 'multiSearch'>, calls };
  }

  it('resolves labels via multi_search, merging per-locale variants', async () => {
    const { client, calls } = fakeClient({
      'https://org/1': { label: 'KB', label_nl: 'KB' },
      // Only a default label (no locale variant) → untagged (`und`) fallback.
      'https://org/3': { label: 'Untagged' },
    });
    const labels = await fetchLabels(client, 'labels', [
      'https://org/1',
      'https://org/2',
      'https://org/3',
    ]);
    expect(labels.get('https://org/1')).toEqual({ nl: ['KB'] });
    expect(labels.get('https://org/3')).toEqual({ und: ['Untagged'] });
    // An IRI absent from the collection yields no entry.
    expect(labels.has('https://org/2')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('batches a large id-list under the per_page cap, one POST per batch', async () => {
    const ids = Array.from(
      { length: 450 },
      (_unused, index) => `https://example.org/class/${index}`,
    );
    const docsById = Object.fromEntries(
      ids.map((id) => [id, { label_nl: id }]),
    );
    const { client, calls } = fakeClient(docsById);
    const labels = await fetchLabels(client, 'labels', ids);
    // 450 ids → batches of 200, 200, 50.
    expect(calls.map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(labels.size).toBe(450);
  });

  it('makes no request for an empty id-list', async () => {
    const { client, calls } = fakeClient({});
    const labels = await fetchLabels(client, 'labels', []);
    expect(labels.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
