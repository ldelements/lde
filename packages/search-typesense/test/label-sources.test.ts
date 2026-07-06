import { describe, expect, it } from 'vitest';
import { searchSchema, type SearchQuery, type SearchType } from '@lde/search';
import { createTypesenseSearchEngine } from '../src/search.js';
import {
  fakeTypesenseClient,
  filterByIds,
  labelLookup,
} from './fake-typesense-client.js';

// Per-reference label sources: each reference field resolves its labels from
// the collection of the SearchType its `labelSource` names.

const organization: SearchType = {
  name: 'Organization',
  type: 'https://example.org/Organization',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['und', 'nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
};

const term: SearchType = {
  name: 'Term',
  type: 'https://example.org/Term',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['und'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
};

const dataset: SearchType = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
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
      name: 'subject',
      kind: 'reference',
      array: true,
      facetable: true,
      output: true,
      ref: { typeName: 'Concept', strategy: 'labelOnly' },
      labelSource: 'Term',
    },
    // No labelSource: stays id-only, and no lookup is ever issued for it.
    {
      name: 'license',
      kind: 'reference',
      array: true,
      output: true,
      ref: { typeName: 'License', strategy: 'labelOnly' },
    },
  ],
};

const schema = searchSchema(organization, term, dataset);

const collections = {
  Organization: 'organizations',
  Term: 'terms',
  Dataset: 'datasets',
};

const baseQuery: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};

/** Answers label lookups per collection; other multi_search entries error. */
function labelSourcesLookup(
  perCollection: Record<string, Record<string, Record<string, unknown>>>,
): (search: Record<string, unknown>) => Record<string, unknown> {
  return (search) => {
    const docs = perCollection[String(search.collection)];
    if (docs === undefined) {
      return { error: `Unknown collection ${String(search.collection)}` };
    }
    return labelLookup(docs)(search);
  };
}

describe('per-reference label sources', () => {
  it('resolves each reference field from its own label source collection', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 1,
        hits: [
          {
            document: {
              id: 'https://d/1',
              publisher: ['https://org/1'],
              subject: ['https://term/1'],
              license: ['https://license/1'],
            },
          },
        ],
      },
      multiSearch: labelSourcesLookup({
        organizations: {
          // As projected: one display field per declared locale.
          'https://org/1': {
            label_und: 'Het Archief',
            label_nl: 'Het Archief',
          },
        },
        terms: {
          // A bare untagged `label` is the `und` fallback.
          'https://term/1': { label: 'Cartography' },
        },
      }),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(dataset, baseQuery);

    expect(result.hits[0].document.publisher).toEqual([
      {
        id: 'https://org/1',
        label: { und: ['Het Archief'], nl: ['Het Archief'] },
      },
    ]);
    expect(result.hits[0].document.subject).toEqual([
      { id: 'https://term/1', label: { und: ['Cartography'] } },
    ]);
    // No label source: id-only, and its IRI never travelled in a lookup.
    expect(result.hits[0].document.license).toEqual([
      { id: 'https://license/1' },
    ]);
    const requestedIds = fake.performs
      .flat()
      .flatMap((search) => filterByIds(String(search.filter_by)));
    expect(requestedIds).not.toContain('https://license/1');
    // Each source was asked in its own collection, in ONE round-trip.
    expect(fake.performs).toHaveLength(1);
    const byCollection = new Map(
      fake.performs.flat().map((search) => [String(search.collection), search]),
    );
    expect(
      filterByIds(String(byCollection.get('organizations')?.filter_by)),
    ).toEqual(['https://org/1']);
    expect(filterByIds(String(byCollection.get('terms')?.filter_by))).toEqual([
      'https://term/1',
    ]);
  });

  it('degrades a dangling reference to id-only', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 1,
        hits: [
          {
            document: {
              id: 'https://d/1',
              publisher: ['https://org/vanished'],
            },
          },
        ],
      },
      multiSearch: labelSourcesLookup({ organizations: {}, terms: {} }),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(dataset, baseQuery);

    expect(result.hits[0].document.publisher).toEqual([
      { id: 'https://org/vanished' },
    ]);
  });

  it('labels facet buckets from the facet field’s own source', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 0,
        hits: [],
        facet_counts: [
          {
            field_name: 'publisher',
            counts: [{ value: 'https://org/1', count: 2 }],
          },
          {
            field_name: 'subject',
            counts: [{ value: 'https://term/1', count: 5 }],
          },
        ],
      },
      multiSearch: labelSourcesLookup({
        organizations: {
          'https://org/1': { label_nl: 'Het Archief' },
        },
        terms: {
          'https://term/1': { label: 'Cartography' },
        },
      }),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(dataset, {
      ...baseQuery,
      facets: ['publisher', 'subject'],
    });

    expect(result.facets.publisher).toEqual([
      { value: 'https://org/1', count: 2, label: { nl: ['Het Archief'] } },
    ]);
    expect(result.facets.subject).toEqual([
      { value: 'https://term/1', count: 5, label: { und: ['Cartography'] } },
    ]);
  });

  it('splits many ids into batches per source, still one round-trip', async () => {
    const iris = Array.from(
      { length: 401 },
      (_, index) => `https://org/${index}`,
    );
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 1,
        hits: [{ document: { id: 'https://d/1', publisher: iris } }],
      },
      multiSearch: labelSourcesLookup({ organizations: {}, terms: {} }),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    await engine.search(dataset, baseQuery);

    expect(fake.performs).toHaveLength(1);
    const batches = fake.performs[0];
    expect(batches).toHaveLength(3); // 401 ids in batches of 200
    expect(
      batches.every((search) => search.collection === 'organizations'),
    ).toBe(true);
  });

  it('serves cached labels merged across both source collections', async () => {
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 1,
        hits: [
          {
            document: {
              id: 'https://d/1',
              publisher: ['https://org/1'],
              subject: ['https://term/1'],
            },
          },
        ],
      },
      // Trailing newline: the export stream ends on a line boundary.
      exportJsonl: (collection) =>
        Promise.resolve(
          collection === 'organizations'
            ? `${JSON.stringify({ id: 'https://org/1', label_nl: 'Het Archief' })}\n`
            : `${JSON.stringify({ id: 'https://term/1', label_und: 'Cartography' })}\n`,
        ),
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
      labelCacheTtlMs: 60_000,
    });

    const result = await engine.search(dataset, baseQuery);

    // Both collections were exported once; no per-search lookup travelled.
    expect(fake.exportCalls()).toBe(2);
    expect(fake.performs).toHaveLength(0);
    expect(result.hits[0].document.publisher).toEqual([
      { id: 'https://org/1', label: { nl: ['Het Archief'] } },
    ]);
    expect(result.hits[0].document.subject).toEqual([
      { id: 'https://term/1', label: { und: ['Cartography'] } },
    ]);
  });

  it('issues no lookup at all for a schema without label sources', async () => {
    const bare = searchSchema({
      name: 'Dataset',
      type: 'http://www.w3.org/ns/dcat#Dataset',
      fields: [
        {
          name: 'license',
          kind: 'reference',
          array: true,
          output: true,
          ref: { typeName: 'License', strategy: 'labelOnly' },
        },
      ],
    });
    const fake = fakeTypesenseClient({
      searchResponse: {
        found: 1,
        hits: [{ document: { id: 'https://d/1', license: ['https://l/1'] } }],
      },
    });
    const engine = createTypesenseSearchEngine(fake.client, bare, {
      collections: { Dataset: 'datasets' },
    });

    const result = await engine.search(bare.get(dataset.type)!, baseQuery);

    expect(result.hits[0].document.license).toEqual([{ id: 'https://l/1' }]);
    expect(fake.performs).toHaveLength(0);
  });
});
