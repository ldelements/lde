import { describe, expect, it } from 'vitest';
import type { SearchEngine, SearchResult } from '../src/engine.js';
import type { SearchQuery } from '../src/query.js';
import { defineSearchType, searchSchema } from '../src/schema.js';
import type { SearchType } from '../src/schema.js';

const datasetType: SearchType = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [{ name: 'title', kind: 'text', localized: true, locales: ['nl'] }],
};

// A fake engine: the port is implementable and the result types compose into a
// logical document (language map + reference) the way a real engine returns.
// The engine is bound to the whole schema at construction and exposes it.
const fake: SearchEngine = {
  schema: searchSchema(datasetType),
  async search(
    _searchType: SearchType,
    query: SearchQuery,
  ): Promise<SearchResult> {
    return {
      total: 1,
      hits: [
        {
          id: 'https://example/dataset/1',
          document: {
            title: { nl: ['Erfgoed'], und: [query.text ?? ''] },
            publisher: {
              id: 'https://example/org/1',
              label: { nl: ['Archief'] },
            },
            keyword: ['kaarten', 'atlas'],
          },
        },
      ],
      facets: { keyword: [{ value: 'kaarten', count: 3 }] },
    };
  },
};

describe('SearchEngine port', () => {
  it('returns logical hits, total and facets through the port', async () => {
    const query: SearchQuery = {
      text: 'kaart',
      where: [],
      orderBy: [{ field: 'relevance', direction: 'desc' }],
      limit: 20,
      offset: 0,
      facets: ['keyword'],
      locale: 'nl',
    };

    const result = await fake.search(datasetType, query);

    expect(fake.schema.get(datasetType.type)).toBe(datasetType);
    expect(result.total).toBe(1);
    expect(result.hits[0].id).toBe('https://example/dataset/1');
    expect(result.hits[0].document.title).toEqual({
      nl: ['Erfgoed'],
      und: ['kaart'],
    });
    expect(result.facets.keyword).toEqual([{ value: 'kaarten', count: 3 }]);
  });
});

describe('typed schema-bound engine', () => {
  it('accepts only its own types and keys results by the type passed', async () => {
    // Captured as literals (`defineSearchType` + `searchSchema`), so the
    // engine's accepted types and the per-call facet/document keys are read
    // off the declaration — the narrowing an adapter factory's `const` type
    // parameter performs for its callers.
    const dataset = defineSearchType({
      name: 'Dataset',
      type: 'http://www.w3.org/ns/dcat#Dataset',
      fields: [
        {
          name: 'title',
          kind: 'text',
          localized: true,
          locales: ['nl'],
          output: true,
        },
        { name: 'format', kind: 'keyword', array: true, facetable: true },
      ],
    });
    const person = defineSearchType({
      name: 'Person',
      type: 'https://schema.org/Person',
      fields: [{ name: 'status', kind: 'keyword', facetable: true }],
    });
    const organization = defineSearchType({
      name: 'Organization',
      type: 'http://xmlns.com/foaf/0.1/Organization',
      fields: [{ name: 'sector', kind: 'keyword', facetable: true }],
    });
    const schema = searchSchema(dataset, person);

    // Implemented string-keyed and cast once — the same shape an adapter
    // factory uses (the runtime object cannot know the literal keys).
    const untyped: SearchEngine = {
      schema,
      async search(): Promise<SearchResult> {
        return {
          total: 1,
          hits: [
            {
              id: 'https://example/d/1',
              document: { title: { nl: ['Titel'] } },
            },
          ],
          facets: { format: [{ value: 'text/turtle', count: 2 }] },
        };
      },
    };
    const engine = untyped as SearchEngine<
      readonly [typeof dataset, typeof person]
    >;

    const query: SearchQuery = {
      where: [],
      orderBy: [],
      limit: 10,
      offset: 0,
      facets: ['format'],
      locale: 'nl',
    };
    const result = await engine.search(dataset, query);

    expect(result.facets.format).toEqual([{ value: 'text/turtle', count: 2 }]);
    // @ts-expect-error — a facet key outside the declaration is a compile error
    void result.facets.formaat;
    expect(result.hits[0].document.title).toEqual({ nl: ['Titel'] });

    // @ts-expect-error — a type outside the engine's schema is a compile error
    void engine.search(organization, query);
  });
});
