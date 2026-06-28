import { describe, expect, it } from 'vitest';
import { graphql, printSchema } from 'graphql';
import type {
  SearchEngine,
  SearchQuery,
  SearchResult,
  SearchSchema,
} from '@lde/search';
import { buildSearchSchema, type SearchContext } from '../src/build-schema.js';

const schema: SearchSchema = {
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
      output: true,
    },
    {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      filterable: true,
      output: true,
      ref: { type: 'Organization', strategy: 'labelOnly' },
    },
    {
      name: 'size',
      kind: 'integer',
      filterable: true,
      sortable: true,
      output: true,
    },
    { name: 'datePosted', kind: 'date', sortable: true, output: true },
    { name: 'score', kind: 'number', output: true },
    {
      name: 'terminologySource',
      kind: 'reference',
      array: true,
      facetable: true,
      output: true,
      ref: { type: 'Term', strategy: 'labelOnly' },
    },
    {
      name: 'status',
      kind: 'keyword',
      facetable: true,
      filterable: true,
      required: true,
      output: true,
    },
    {
      name: 'iiif',
      kind: 'boolean',
      facetable: true,
      filterable: true,
      output: true,
    },
  ],
};

/** A fake engine that records the query it received and returns a canned result. */
function fakeEngine(result: SearchResult): {
  engine: SearchEngine;
  received: () => SearchQuery;
} {
  let captured: SearchQuery;
  return {
    engine: {
      async search(query) {
        captured = query;
        return result;
      },
    },
    received: () => captured,
  };
}

const canned: SearchResult = {
  total: 1,
  hits: [
    {
      id: 'https://d/1',
      document: {
        title: { nl: ['Titel'], en: ['Title'] },
        keyword: ['kaarten'],
        publisher: {
          id: 'https://org/1',
          label: { nl: ['Het Utrechts Archief'] },
        },
        size: 1234,
        datePosted: 1_700_000_000,
        score: 4.5,
        terminologySource: [
          { id: 'https://term/1', label: { nl: ['Kaarten'] } },
        ],
        status: 'valid',
        iiif: true,
      },
    },
  ],
  facets: { keyword: [{ value: 'kaarten', count: 3 }] },
};

async function run(
  source: string,
  context: SearchContext,
  variables?: Record<string, unknown>,
) {
  return graphql({
    schema: buildSearchSchema(schema, { typeName: 'Dataset' }),
    source,
    contextValue: context,
    variableValues: variables,
  });
}

describe('buildSearchSchema', () => {
  it('resolves a query, mapping the result to the typed output', async () => {
    const { engine, received } = fakeEngine(canned);
    const result = await run(
      `{
        datasets(query: "kaart") {
          total
          page
          perPage
          items {
            id
            title { language value }
            keyword
            publisher { id name { language value } }
            terminologySource { id name { language value } }
            size
            datePosted
            score
            status
            iiif
          }
          facets { field buckets { value count } }
        }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );

    expect(result.errors).toBeUndefined();
    const data = result.data?.datasets as Record<string, unknown>;
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    const item = (data.items as Record<string, unknown>[])[0];
    expect(item.id).toBe('https://d/1');
    expect(item.title).toEqual([
      { language: 'nl', value: 'Titel' },
      { language: 'en', value: 'Title' },
    ]);
    expect(item.keyword).toEqual(['kaarten']);
    expect(item.publisher).toEqual({
      id: 'https://org/1',
      name: [{ language: 'nl', value: 'Het Utrechts Archief' }],
    });
    expect(item.size).toBe(1234);
    expect(item.datePosted).toBe('2023-11-14T22:13:20.000Z');
    expect(item.score).toBe(4.5);
    expect(item.terminologySource).toEqual([
      { id: 'https://term/1', name: [{ language: 'nl', value: 'Kaarten' }] },
    ]);
    expect(item.iiif).toBe(true);
    expect(data.facets).toEqual([
      { field: 'KEYWORD', buckets: [{ value: 'kaarten', count: 3 }] },
    ]);
    // The free-text arg became the query text.
    expect(received().text).toBe('kaart');
  });

  it('orders the output list best-first for the requested language', async () => {
    const { engine } = fakeEngine(canned);
    const result = await run(
      `{ datasets { items { title { language value } } } }`,
      { engine, acceptLanguage: ['en'] },
    );
    const item = (
      (result.data?.datasets as Record<string, unknown>).items as Record<
        string,
        unknown
      >[]
    )[0];
    expect(item.title).toEqual([
      { language: 'en', value: 'Title' },
      { language: 'nl', value: 'Titel' },
    ]);
  });

  it('places untagged (und) values last with a null language', async () => {
    const { engine } = fakeEngine({
      total: 1,
      facets: {},
      hits: [
        {
          id: 'x',
          document: { title: { nl: ['Titel'], und: ['Naamloos'] } },
        },
      ],
    });
    const result = await run(
      `{ datasets { items { title { language value } } } }`,
      { engine, acceptLanguage: ['en'] },
    );
    const item = (
      (result.data?.datasets as Record<string, unknown>).items as Record<
        string,
        unknown
      >[]
    )[0];
    expect(item.title).toEqual([
      { language: 'nl', value: 'Titel' },
      { language: null, value: 'Naamloos' },
    ]);
  });

  it('labels reference-facet buckets, leaving plain-facet buckets null', async () => {
    const { engine } = fakeEngine({
      total: 0,
      hits: [],
      facets: {
        publisher: [
          {
            value: 'https://org/1',
            count: 2,
            label: { nl: ['Het Utrechts Archief'] },
          },
        ],
        keyword: [{ value: 'kaarten', count: 3 }],
      },
    });
    const result = await run(
      `{ datasets { facets { field buckets { value count label { language value } } } } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    const facets = (result.data?.datasets as Record<string, unknown>)
      .facets as { field: string; buckets: unknown[] }[];
    const publisher = facets.find((facet) => facet.field === 'PUBLISHER');
    const keyword = facets.find((facet) => facet.field === 'KEYWORD');
    expect(publisher?.buckets).toEqual([
      {
        value: 'https://org/1',
        count: 2,
        label: [{ language: 'nl', value: 'Het Utrechts Archief' }],
      },
    ]);
    expect(keyword?.buckets).toEqual([
      { value: 'kaarten', count: 3, label: null },
    ]);
  });

  it('maps where, orderBy, facets and pagination into the SearchQuery', async () => {
    const { engine, received } = fakeEngine(canned);
    await run(
      `{
        datasets(
          where: { status: { in: ["valid"] }, keyword: {}, size: { min: 1, max: 9 }, iiif: true }
          orderBy: { field: SIZE, direction: ASC }
          page: 3
          perPage: 10
          facets: [KEYWORD, PUBLISHER]
        ) { total }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );

    const query = received();
    expect(query.where).toContainEqual({ field: 'status', in: ['valid'] });
    // An empty StringFilter compiles to an empty membership.
    expect(query.where).toContainEqual({ field: 'keyword', in: [] });
    expect(query.where).toContainEqual({
      field: 'size',
      range: { min: 1, max: 9 },
    });
    expect(query.where).toContainEqual({ field: 'iiif', is: true });
    expect(query.orderBy).toEqual([{ field: 'size', direction: 'asc' }]);
    expect(query.facets).toEqual(['keyword', 'publisher']);
    expect(query.limit).toBe(10);
    expect(query.offset).toBe(20);
  });

  it('falls back to the und locale when no Accept-Language is given', async () => {
    const { engine, received } = fakeEngine(canned);
    await run(`{ datasets { total } }`, { engine, acceptLanguage: [] });
    expect(received().locale).toBe('und');
  });

  it('applies queryDefaults before calling the engine', async () => {
    let captured: SearchQuery | undefined;
    const engine: SearchEngine = {
      async search(query) {
        captured = query;
        return canned;
      },
    };
    const gqlSchema = buildSearchSchema(schema, {
      typeName: 'Dataset',
      queryDefaults: (query) => ({
        ...query,
        where: [...query.where, { field: 'status', in: ['valid'] }],
        orderBy: [{ field: 'relevance', direction: 'desc' }],
      }),
    });
    await graphql({
      schema: gqlSchema,
      source: `{ datasets { total } }`,
      contextValue: { engine, acceptLanguage: ['nl'] },
    });
    expect(captured?.where).toEqual([{ field: 'status', in: ['valid'] }]);
    expect(captured?.orderBy).toEqual([
      { field: 'relevance', direction: 'desc' },
    ]);
  });

  it('derives nullability: required scalar non-null, optional scalar nullable, arrays/booleans non-null', () => {
    const sdl = printSchema(buildSearchSchema(schema, { typeName: 'Dataset' }));
    expect(sdl).toMatch(/status: String!/); // required
    expect(sdl).toMatch(/size: Int\b(?!!)/); // optional → nullable
    expect(sdl).toMatch(/title: \[LanguageString!\]!/);
    expect(sdl).toMatch(/keyword: \[String!\]!/);
    expect(sdl).toMatch(/iiif: Boolean!/);
    expect(sdl).toMatch(/publisher: Organization\b(?!!)/); // optional reference
  });

  it('builds the where, orderBy and facet enums from the field model', () => {
    const sdl = printSchema(buildSearchSchema(schema, { typeName: 'Dataset' }));
    expect(sdl).toMatch(/enum DatasetSortField/);
    expect(sdl).toMatch(/RELEVANCE/);
    expect(sdl).toMatch(/SIZE/);
    expect(sdl).toMatch(/enum DatasetFacetField/);
    expect(sdl).toMatch(/input DatasetWhere/);
    expect(sdl).toMatch(/status: StringFilter/);
    expect(sdl).toMatch(/size: IntRange/);
  });
});
