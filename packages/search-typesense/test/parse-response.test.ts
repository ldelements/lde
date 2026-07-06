import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  searchSchema,
  type LocalizedValue,
  type SearchQuery,
  type SearchType,
} from '@lde/search';
import type { Client } from 'typesense';
import {
  createTypesenseSearchEngine,
  fetchLabels,
  parseSearchResponse,
} from '../src/search.js';

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
                // A scalar (non-array) stored reference value.
                {
                  document: { id: 'https://d/2', publisher: 'https://org/2' },
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
    const engine = createTypesenseSearchEngine(
      fakeClient(),
      searchSchema(schema),
      {
        collections: { Dataset: 'datasets' },
        labelsCollection: 'labels',
        onLabelError: (error) => {
          capturedError = error;
        },
      },
    );
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
                // A scalar (non-array) stored reference value.
                {
                  document: { id: 'https://d/2', publisher: 'https://org/2' },
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
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
      labelsCollection: 'labels',
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
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
      labelsCollection: 'labels',
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
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
      labelsCollection: 'labels',
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
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
      labelsCollection: 'labels',
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

/** The backtick-escaped ids of a `filter_by: id:[…]` clause — the wire form
 *  `escapeFilterValue` produces; shared by the label-lookup fakes. */
function filterByIds(filterBy: string): string[] {
  return [...filterBy.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

describe('createTypesenseSearchEngine searchFacets (multi_search batching)', () => {
  const facetBrowse: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 0,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  // A fake client whose multi_search answers each entry via `perEntry`,
  // recording every POST so the batching is observable.
  function fakeClient(
    perEntry: (
      search: Record<string, unknown>,
      index: number,
    ) => Record<string, unknown>,
  ) {
    const performs: Record<string, unknown>[][] = [];
    const client = {
      multiSearch: {
        perform: (request: { searches: Record<string, unknown>[] }) => {
          performs.push(request.searches);
          return Promise.resolve({
            results: request.searches.map(perEntry),
          });
        },
      },
    };
    return { client: client as unknown as Client, performs };
  }

  it('sends the whole batch as ONE multi_search and maps the results positionally', async () => {
    const { client, performs } = fakeClient((search) => ({
      found: 0,
      hits: [],
      facet_counts: [
        {
          field_name: search.facet_by,
          counts: [{ value: `${search.facet_by}-value`, count: 1 }],
        },
      ],
    }));
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
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
    const { client, performs } = fakeClient(() => ({ found: 0, hits: [] }));
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
    });
    await expect(engine.searchFacets(schema, [])).resolves.toEqual([]);
    expect(performs).toHaveLength(0);
  });

  it('reports a failed entry as an in-place error outcome, keeping its siblings', async () => {
    const { client } = fakeClient((_search, index) =>
      index === 1
        ? { code: 404, error: 'collection not found' }
        : { found: 0, hits: [], facet_counts: [] },
    );
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
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
    const { client } = fakeClient(() => ({ error: 'malformed query' }));
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
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
    let exportCalls = 0;
    const performs: Record<string, unknown>[][] = [];
    const client = {
      collections: () => ({
        documents: () => ({
          export: () => {
            exportCalls += 1;
            return Promise.resolve(
              JSON.stringify({
                id: 'https://org/1',
                label_nl: 'Het Utrechts Archief',
              }),
            );
          },
        }),
      }),
      multiSearch: {
        perform: (request: { searches: Record<string, unknown>[] }) => {
          performs.push(request.searches);
          return Promise.resolve({
            results: request.searches.map(() => ({
              found: 0,
              hits: [],
              facet_counts: [
                {
                  field_name: 'publisher',
                  counts: [{ value: 'https://org/1', count: 1 }],
                },
              ],
            })),
          });
        },
      },
    } as unknown as Client;
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
      labelsCollection: 'labels',
      labelCacheTtlMs: 60_000,
    });

    const outcomes = await engine.searchFacets(schema, [
      { ...facetBrowse, facets: ['publisher'] },
    ]);

    // ONE export populated the cache; the only multi_search is the facet
    // batch itself — no per-batch label lookup.
    expect(exportCalls).toBe(1);
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
    const { client, performs } = fakeClient((search, index) => {
      if (search.query_by === 'label') {
        const ids = filterByIds(String(search.filter_by));
        return {
          found: ids.length,
          hits: ids
            .filter((id) => labelDocs[id] !== undefined)
            .map((id) => ({ document: { id, ...labelDocs[id] } })),
        };
      }
      return {
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
      };
    });
    const engine = createTypesenseSearchEngine(client, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
      labelsCollection: 'labels',
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
  // A fake Typesense client whose multi_search returns the requested ids that
  // exist in `docsById`, recording each POST's per-search id-lists so batching
  // is observable. (Resolving via multi_search/POST avoids the GET query-string
  // limit that a large id-list would otherwise overflow.)
  function fakeClient(docsById: Record<string, Record<string, unknown>>) {
    const posts: string[][][] = [];
    const client = {
      multiSearch: {
        perform: (request: { searches: { readonly filter_by: string }[] }) => {
          const batches = request.searches.map((search) =>
            filterByIds(search.filter_by),
          );
          posts.push(batches);
          const results = batches.map((ids) => {
            const hits = ids
              .filter((id) => docsById[id] !== undefined)
              .map((id) => ({ document: { id, ...docsById[id] } }));
            return { found: hits.length, hits };
          });
          return Promise.resolve({ results });
        },
      },
    };
    return { client: client as unknown as Pick<Client, 'multiSearch'>, posts };
  }

  it('resolves labels via multi_search, merging per-locale variants', async () => {
    const { client, posts } = fakeClient({
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
    expect(posts).toHaveLength(1);
  });

  it('batches a large id-list under the per_page cap, in a single POST', async () => {
    const ids = Array.from(
      { length: 450 },
      (_unused, index) => `https://example.org/class/${index}`,
    );
    const docsById = Object.fromEntries(
      ids.map((id) => [id, { label_nl: id }]),
    );
    const { client, posts } = fakeClient(docsById);
    const labels = await fetchLabels(client, 'labels', ids);
    // 450 ids → batches of 200, 200, 50, bundled into one round-trip.
    expect(posts).toHaveLength(1);
    expect(posts[0].map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(labels.size).toBe(450);
  });

  it('makes no request for an empty id-list', async () => {
    const { client, posts } = fakeClient({});
    const labels = await fetchLabels(client, 'labels', []);
    expect(labels.size).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('throws on an inline multi_search error entry instead of returning no labels', async () => {
    // multi_search reports a failed entry inline (the call still resolves);
    // fetchLabels must throw so the engine's degradation path (onLabelError,
    // id-only references) engages instead of silently missing every label.
    const client = {
      multiSearch: {
        perform: () =>
          Promise.resolve({
            results: [{ code: 503, error: 'lookup failed' }],
          }),
      },
    } as unknown as Pick<Client, 'multiSearch'>;
    await expect(
      fetchLabels(client, 'labels', ['https://org/1']),
    ).rejects.toThrow(/label lookup failed \(503\): lookup failed/);

    // An error entry without a status code still throws.
    const clientWithoutCode = {
      multiSearch: {
        perform: () =>
          Promise.resolve({ results: [{ error: 'lookup failed' }] }),
      },
    } as unknown as Pick<Client, 'multiSearch'>;
    await expect(
      fetchLabels(clientWithoutCode, 'labels', ['https://org/1']),
    ).rejects.toThrow(/label lookup failed: lookup failed/);
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
    const engine = createTypesenseSearchEngine(noClient, searchSchema(schema), {
      collections: { Dataset: 'datasets' },
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
        searchSchema(schema, other),
        // The widened schema loses compile-time exhaustiveness; the
        // constructor still rejects the missing entry at startup.
        { collections: { Dataset: 'datasets' } },
      ),
    ).toThrow(/No collection configured for search type “Other”/);
  });
});
