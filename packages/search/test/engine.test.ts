import { describe, expect, it } from 'vitest';
import { engineFor } from '../src/engine.js';
import type { EngineFor, SearchEngine, SearchResult } from '../src/engine.js';
import type { SearchQuery } from '../src/query.js';
import { defineSearchType } from '../src/schema.js';
import type { SearchType } from '../src/schema.js';

const schema: SearchType = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [{ name: 'title', kind: 'text', localized: true, locales: ['nl'] }],
};

// A fake engine: the port is implementable and the result types compose into a
// logical document (language map + reference) the way a real engine returns.
const fake: SearchEngine = {
  async search(query: SearchQuery): Promise<SearchResult> {
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

    const result = await fake.search(query, schema);

    expect(result.total).toBe(1);
    expect(result.hits[0].id).toBe('https://example/dataset/1');
    expect(result.hits[0].document.title).toEqual({
      nl: ['Erfgoed'],
      und: ['kaart'],
    });
    expect(result.facets.keyword).toEqual([{ value: 'kaarten', count: 3 }]);
  });
});

describe('typed facet and document keys', () => {
  it('keys facets and the result document by the schema’s field names', async () => {
    // Captured as a literal (`as const satisfies`) so the `facetable`/`output`
    // flags survive and the `…Of` helpers can read the field names off the type.
    const datasetSchema = {
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
        { name: 'status', kind: 'keyword', facetable: true },
      ],
    } as const satisfies SearchType;

    // facets ⊂ { format, status }, document keys ⊂ { title }. These object
    // literals would not compile if the helpers widened to `string`/`never`.
    const engine: EngineFor<typeof datasetSchema> = {
      async search() {
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

    const result = await engine.search(
      {
        where: [],
        orderBy: [],
        limit: 10,
        offset: 0,
        facets: ['format'],
        locale: 'nl',
      },
      datasetSchema,
    );

    expect(result.facets.format).toEqual([{ value: 'text/turtle', count: 2 }]);
    expect(result.hits[0].document.title).toEqual({ nl: ['Titel'] });
  });

  it('accepts only the search type it was narrowed to', () => {
    // `defineSearchType` captures the literal (no `as const` needed): the
    // `facetable: true` flag must survive for `FacetFieldsOf` to see it.
    const datasetSchema = defineSearchType({
      name: 'Dataset',
      type: 'http://www.w3.org/ns/dcat#Dataset',
      fields: [{ name: 'format', kind: 'keyword', facetable: true }],
    });
    const organizationSchema = defineSearchType({
      name: 'Organization',
      type: 'http://xmlns.com/foaf/0.1/Organization',
      fields: [{ name: 'sector', kind: 'keyword', facetable: true }],
    });
    const query: SearchQuery = {
      where: [],
      orderBy: [],
      limit: 10,
      offset: 0,
      facets: [],
      locale: 'nl',
    };

    // `engineFor` narrows a generic adapter (plain `SearchEngine`) to any
    // `EngineFor` — the same instance, identity at runtime.
    const engine: EngineFor<typeof datasetSchema> = engineFor(
      datasetSchema,
      fake,
    );
    expect(engine).toBe(fake);

    void engine.search(query, datasetSchema);
    // @ts-expect-error — a mismatched search type is rejected at compile time
    void engine.search(query, organizationSchema);
  });
});
