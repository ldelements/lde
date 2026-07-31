import { describe, expect, it } from 'vitest';
import { graphql, printSchema } from 'graphql';
import {
  searchSchema,
  type FacetsOutcome,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
  type RootType,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema, type SearchContext } from '../src/build-schema.js';

const schema: SearchType = {
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
      output: true,
    },
    {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      filterable: true,
      output: true,
      ref: { typeName: 'Organization', strategy: 'labelOnly' },
    },
    {
      name: 'size',
      kind: 'integer',
      filterable: true,
      sortable: true,
      facetable: true,
      output: true,
      facetRanges: [
        { key: '0', min: 1, max: 10 },
        { key: '1', min: 10 },
      ],
    },
    { name: 'datePosted', kind: 'date', sortable: true, output: true },
    { name: 'score', kind: 'number', output: true },
    {
      name: 'terminologySource',
      kind: 'reference',
      array: true,
      facetable: true,
      output: true,
      ref: { typeName: 'Term', strategy: 'labelOnly' },
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

/** A fake engine that records the queries it received and returns a canned
 *  result; each query in a `searchFacets` batch answers with the canned
 *  facets. */
function fakeEngine(result: SearchResult): {
  engine: SearchEngine;
  received: () => SearchQuery;
  facetBatches: () => readonly (readonly SearchQuery[])[];
} {
  let captured: SearchQuery;
  const batches: (readonly SearchQuery[])[] = [];
  return {
    engine: {
      schema: searchSchema(schema),
      async search(_searchType, query) {
        captured = query;
        return result;
      },
      async searchFacets(_searchType, queries) {
        batches.push(queries);
        return queries.map(() => ({ facets: result.facets }));
      },
    },
    received: () => captured,
    facetBatches: () => batches,
  };
}

/** A `searchFacets` stub for bespoke engines whose test selects no facets. */
const noFacets = async (
  _searchType: SearchType,
  queries: readonly SearchQuery[],
): Promise<readonly FacetsOutcome[]> => queries.map(() => ({ facets: {} }));

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

const datasetOptions = {};

async function run(
  source: string,
  context: SearchContext,
  variables?: Record<string, unknown>,
) {
  return graphql({
    schema: buildGraphQLSchema(searchSchema(schema), datasetOptions),
    source,
    contextValue: context,
    variableValues: variables,
  });
}

describe('buildGraphQLSchema', () => {
  it('resolves a query, mapping the result to the typed output', async () => {
    const { engine, received } = fakeEngine(canned);
    const result = await run(
      `{
        datasets(query: "kaart") {
          pagination {
            total
            page
            perPage
          }
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
          facets { keyword { value count } }
        }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );

    expect(result.errors).toBeUndefined();
    const data = result.data?.datasets as Record<string, unknown>;
    expect(data.pagination).toEqual({ total: 1, page: 1, perPage: 20 });
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
    expect(data.facets).toEqual({
      keyword: [{ value: 'kaarten', count: 3 }],
    });
    // The free-text arg became the query text.
    expect(received().text).toBe('kaart');
  });

  it('rejects out-of-bounds paging before it reaches the engine', async () => {
    const { engine } = fakeEngine(canned);
    const context = { engine, acceptLanguage: ['nl'] };
    const badPage = await run(
      `{ datasets(page: 0) { pagination { total } } }`,
      context,
    );
    expect(badPage.errors?.[0]?.message).toMatch(/page must be at least 1/);
    const badPerPage = await run(
      `{ datasets(perPage: 101) { pagination { total } } }`,
      context,
    );
    expect(badPerPage.errors?.[0]?.message).toMatch(
      /perPage must be between 0 and 100/,
    );
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
      `{ datasets { items { title { language value } datePosted } } }`,
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
    // An absent date resolves to null (the non-numeric branch).
    expect(item.datePosted).toBeNull();
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
      `{ datasets { facets {
        publisher { value count label { language value } }
        keyword { value count label { language value } }
      } } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    const facets = (result.data?.datasets as Record<string, unknown>)
      .facets as {
      publisher: unknown[];
      keyword: unknown[];
    };
    expect(facets.publisher).toEqual([
      {
        value: 'https://org/1',
        count: 2,
        label: [{ language: 'nl', value: 'Het Utrechts Archief' }],
      },
    ]);
    expect(facets.keyword).toEqual([
      { value: 'kaarten', count: 3, label: null },
    ]);
  });

  it('exposes range-facet bucket bounds, null for value facets and open ends', async () => {
    const { engine } = fakeEngine({
      total: 0,
      hits: [],
      facets: {
        size: [
          { value: '0', count: 2, min: 1, max: 10 },
          // Open-ended top bin: lower bound only.
          { value: '1', count: 5, min: 10 },
        ],
        keyword: [{ value: 'kaarten', count: 3 }],
      },
    });
    const result = await run(
      `{ datasets { facets {
        size { min max count }
        keyword { value count }
      } } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    const facets = (result.data?.datasets as Record<string, unknown>)
      .facets as {
      size: unknown[];
      keyword: unknown[];
    };
    // RangeBuckets carry their half-open bounds (max null = open-ended top bin).
    expect(facets.size).toEqual([
      { min: 1, max: 10, count: 2 },
      { min: 10, max: null, count: 5 },
    ]);
    // A value facet's ValueBuckets carry no bounds.
    expect(facets.keyword).toEqual([{ value: 'kaarten', count: 3 }]);
  });

  it('resolves every selected facet key through ONE batched engine dispatch, returning [] where the engine has none', async () => {
    const { engine, facetBatches } = fakeEngine({
      total: 0,
      hits: [],
      facets: { keyword: [{ value: 'kaarten', count: 1 }] },
    });
    const result = await run(
      `{ datasets { facets {
        keyword { value count }
        publisher { value count }
        terminologySource { value count }
        status { value count }
        iiif { value count }
        size { min max count }
      } } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    const facets = (result.data?.datasets as Record<string, unknown>)
      .facets as Record<string, unknown[]>;
    expect(facets.keyword).toEqual([{ value: 'kaarten', count: 1 }]);
    // Keys the engine returned nothing for resolve to an empty list.
    for (const key of [
      'publisher',
      'terminologySource',
      'status',
      'iiif',
      'size',
    ]) {
      expect(facets[key]).toEqual([]);
    }
    // Unfiltered browse: the whole selection collapses to a single facet-only
    // query inside a single searchFacets dispatch.
    expect(facetBatches()).toHaveLength(1);
    const [batch] = facetBatches();
    expect(batch).toHaveLength(1);
    expect(batch[0].facets).toEqual([
      'keyword',
      'publisher',
      'terminologySource',
      'status',
      'iiif',
      'size',
    ]);
    expect(batch[0].limit).toBe(0);
  });

  it('computes a facet with its own where-filter removed (skip-own-filter)', async () => {
    const { engine, facetBatches } = fakeEngine({
      total: 0,
      hits: [],
      facets: { keyword: [{ value: 'kaarten', count: 1 }] },
    });
    await run(
      `{ datasets(where: { keyword: { in: ["x"] }, status: { in: ["valid"] } }) {
        facets { keyword { value count } }
      } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    // The keyword facet query is run with the keyword filter dropped (so its
    // other options still count), but other filters (status) retained.
    const [batch] = facetBatches();
    expect(batch).toHaveLength(1);
    const facetQuery = batch[0];
    expect(facetQuery.facets).toEqual(['keyword']);
    expect(
      facetQuery.where.find((filter) => filter.field === 'keyword'),
    ).toBeUndefined();
    expect(facetQuery.where).toContainEqual({ field: 'status', in: ['valid'] });
  });

  it('groups the selected facets by effective where: unfiltered facets share one query, each own-filtered facet gets its own', async () => {
    const { engine, facetBatches } = fakeEngine({
      total: 0,
      hits: [],
      facets: {},
    });
    await run(
      `{ datasets(where: { status: { in: ["valid"] } }) {
        facets {
          keyword { value count }
          publisher { value count }
          status { value count }
        }
      } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    // One dispatch: keyword + publisher (no own filter) share the untouched
    // where; status (own-filtered) needs its own query with that filter dropped.
    expect(facetBatches()).toHaveLength(1);
    const [batch] = facetBatches();
    expect(batch).toHaveLength(2);
    expect(batch[0].facets).toEqual(['keyword', 'publisher']);
    expect(batch[0].where).toEqual([{ field: 'status', in: ['valid'] }]);
    expect(batch[1].facets).toEqual(['status']);
    expect(batch[1].where).toEqual([]);
  });

  it('degrades a failed facet batch to empty lists without failing the whole query', async () => {
    // A facet is supplementary: its computation runs through the batched
    // searchFacets dispatch. Fail only that, leaving the listing search
    // untouched.
    const failedFacets: string[] = [];
    const engine: SearchEngine = {
      schema: searchSchema(schema),
      async search() {
        return canned;
      },
      async searchFacets() {
        throw new Error('facet backend unavailable');
      },
    };
    const result = await run(
      `{ datasets {
        pagination { total }
        items { id }
        facets { keyword { value count } status { value count } }
      } }`,
      {
        engine,
        acceptLanguage: ['nl'],
        onFacetError: (field) => failedFacets.push(field),
      },
    );

    // No top-level error: the failed facets degraded rather than nulling the
    // non-null result and discarding the items.
    expect(result.errors).toBeUndefined();
    const data = result.data?.datasets as Record<string, unknown>;
    expect((data.pagination as Record<string, unknown>).total).toBe(1);
    expect((data.items as Record<string, unknown>[])[0].id).toBe('https://d/1');
    // Every facet in the failed batch degraded to an empty list, and the
    // cause was reported once per selected field.
    expect((data.facets as Record<string, unknown[]>).keyword).toEqual([]);
    expect((data.facets as Record<string, unknown[]>).status).toEqual([]);
    expect(failedFacets.sort()).toEqual(['keyword', 'status']);
  });

  it('guards perPage: 0, resolving page to 1 rather than failing on NaN', async () => {
    const { engine } = fakeEngine(canned);
    const result = await run(
      `{ datasets(perPage: 0) { pagination { page total } } }`,
      {
        engine,
        acceptLanguage: ['nl'],
      },
    );
    expect(result.errors).toBeUndefined();
    const data = result.data?.datasets as Record<string, unknown>;
    expect((data.pagination as Record<string, unknown>).page).toBe(1);
  });

  it('maps where, orderBy and pagination into the SearchQuery', async () => {
    const { engine, received } = fakeEngine(canned);
    await run(
      `{
        datasets(
          where: { status: { in: ["valid"] }, keyword: {}, size: { min: 1, max: 9 }, iiif: true }
          orderBy: { field: SIZE, direction: ASC }
          page: 3
          perPage: 10
        ) { pagination { total } }
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
    // Facets are requested per key via selection, not an arg; the listing query
    // carries none.
    expect(query.facets).toEqual([]);
    expect(query.limit).toBe(10);
    expect(query.offset).toBe(20);
  });

  it('maps a where on the undeclared `id` into an IRI membership filter', async () => {
    const { engine, received } = fakeEngine(canned);
    await run(
      `{
        datasets(where: { id: { in: ["https://id.example.org/a", "urn:b"] } }) {
          pagination { total }
        }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );
    expect(received().where).toEqual([
      { field: 'id', in: ['https://id.example.org/a', 'urn:b'] },
    ]);

    // An empty StringFilter compiles to an empty membership, as for any field.
    const empty = fakeEngine(canned);
    await run(`{ datasets(where: { id: {} }) { pagination { total } } }`, {
      engine: empty.engine,
      acceptLanguage: ['nl'],
    });
    expect(empty.received().where).toEqual([{ field: 'id', in: [] }]);
  });

  it('falls back to the und locale when no Accept-Language is given', async () => {
    const { engine, received } = fakeEngine(canned);
    await run(`{ datasets { pagination { total } } }`, {
      engine,
      acceptLanguage: [],
    });
    expect(received().locale).toBe('und');
  });

  it('applies queryDefaults before calling the engine', async () => {
    let captured: SearchQuery | undefined;
    const engine: SearchEngine = {
      schema: searchSchema(schema),
      async search(_searchType, query) {
        captured = query;
        return canned;
      },
      searchFacets: noFacets,
    };
    const gqlSchema = buildGraphQLSchema(searchSchema(schema), {
      types: {
        [schema.name]: {
          queryDefaults: (query) => ({
            ...query,
            where: [...query.where, { field: 'status', in: ['valid'] }],
            orderBy: [{ field: 'relevance', direction: 'desc' }],
          }),
        },
      },
    });
    await graphql({
      schema: gqlSchema,
      source: `{ datasets { pagination { total } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] },
    });
    expect(captured?.where).toEqual([{ field: 'status', in: ['valid'] }]);
    expect(captured?.orderBy).toEqual([
      { field: 'relevance', direction: 'desc' },
    ]);
  });

  it('derives nullability: required scalar non-null, optional scalar nullable, arrays/booleans non-null', () => {
    const sdl = printSchema(
      buildGraphQLSchema(searchSchema(schema), datasetOptions),
    );
    expect(sdl).toMatch(/status: String!/); // required
    expect(sdl).toMatch(/size: Int\b(?!!)/); // optional → nullable
    expect(sdl).toMatch(/title: \[LanguageString!\]!/);
    expect(sdl).toMatch(/keyword: \[String!\]!/);
    expect(sdl).toMatch(/iiif: Boolean!/);
    expect(sdl).toMatch(/publisher: Organization\b(?!!)/); // optional reference
  });

  it('builds the where, orderBy enum and keyed facets object from the field model', () => {
    const sdl = printSchema(
      buildGraphQLSchema(searchSchema(schema), datasetOptions),
    );
    expect(sdl).toMatch(/enum DatasetSortField/);
    expect(sdl).toMatch(/RELEVANCE/);
    expect(sdl).toMatch(/SIZE/);
    // Facets are a keyed object, one field per facetable field, typed by kind.
    expect(sdl).toMatch(/type DatasetFacets/);
    expect(sdl).toMatch(/keyword: \[ValueBucket!\]!/);
    expect(sdl).toMatch(/size: \[RangeBucket!\]!/);
    expect(sdl).toMatch(/input DatasetWhere/);
    expect(sdl).toMatch(/status: StringFilter/);
    expect(sdl).toMatch(/size: IntRange/);
  });

  describe('multiple root types in one schema', () => {
    const PERSON: SearchType = {
      name: 'Person',
      class: 'https://schema.org/Person',
      fields: [
        {
          name: 'name',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 5 },
          sortable: true,
        },
        {
          name: 'affiliation',
          kind: 'reference',
          facetable: true,
          output: true,
          ref: { typeName: 'Agent', strategy: 'labelOnly' },
        },
      ],
    };
    const CREATIVE_WORK: SearchType = {
      name: 'CreativeWork',
      class: 'https://schema.org/CreativeWork',
      fields: [
        {
          name: 'title',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 5 },
        },
        {
          name: 'publisher',
          kind: 'reference',
          facetable: true,
          output: true,
          ref: { typeName: 'Agent', strategy: 'labelOnly' },
        },
        { name: 'pageCount', kind: 'integer', filterable: true, output: true },
      ],
    };
    const twoTypeSchema = buildGraphQLSchema(
      searchSchema(PERSON, CREATIVE_WORK),
      {
        types: {
          [PERSON.name]: { queryField: 'people' },
        },
      },
    );

    it('exposes one root field per type, each with its own derived types', () => {
      const sdl = printSchema(twoTypeSchema);
      expect(sdl).toMatch(/people\([\s\S]*?\): PersonSearchResult!/);
      expect(sdl).toMatch(
        /creativeWorks\([\s\S]*?\): CreativeWorkSearchResult!/,
      );
      expect(sdl).toMatch(/enum PersonSortField/);
      expect(sdl).toMatch(/input CreativeWorkWhere/);
      // Person declares no filterable field, yet still gets a `where` input:
      // `id` is filterable on every type, so no type is unaddressable by IRI.
      expect(sdl).toMatch(/input PersonWhere \{\s*id: StringFilter\s*\}/);
      // The shared reference shape is emitted once, reused by both types.
      expect(sdl.match(/^type Agent /gm)).toHaveLength(1);
      // One shared Pagination type across every ‹Type›SearchResult, so a
      // client pager fragment on Pagination serves all root types.
      expect(sdl.match(/^type Pagination /gm)).toHaveLength(1);
      expect(sdl.match(/pagination: Pagination!/g)).toHaveLength(2);
    });

    it('routes each root field through the schema-bound engine', async () => {
      const searchedTypes: string[] = [];
      const engine: SearchEngine = {
        schema: searchSchema(PERSON, CREATIVE_WORK),
        async search(searchType: RootType): Promise<SearchResult> {
          searchedTypes.push(searchType.class);
          return { total: 0, hits: [], facets: {} };
        },
        searchFacets: noFacets,
      };
      const result = await graphql({
        schema: twoTypeSchema,
        source: `{ people { pagination { total } } creativeWorks { pagination { total } } }`,
        contextValue: { engine, acceptLanguage: ['nl'] },
      });
      expect(result.errors).toBeUndefined();
      expect(searchedTypes).toEqual([PERSON.class, CREATIVE_WORK.class]);
    });

    it('builds without any options: names come from the search types', () => {
      const sdl = printSchema(
        buildGraphQLSchema(searchSchema(PERSON, CREATIVE_WORK)),
      );
      expect(sdl).toMatch(/persons\([\s\S]*?\): PersonSearchResult!/);
      expect(sdl).toMatch(
        /creativeWorks\([\s\S]*?\): CreativeWorkSearchResult!/,
      );
    });

    it('serves a labelOnly reference to a root type under ‹Name›Reference', () => {
      const withReferenceToRoot: SearchType = {
        name: 'CreativeWork',
        class: 'https://schema.org/CreativeWork',
        fields: [
          {
            name: 'author',
            kind: 'reference',
            output: true,
            // Person is also a root type in this schema – the labelOnly way to
            // carry an id plus a label resolved from the Person collection.
            ref: { typeName: 'Person', strategy: 'labelOnly' },
          },
        ],
      };
      const sdl = printSchema(
        buildGraphQLSchema(searchSchema(PERSON, withReferenceToRoot)),
      );
      // The root type keeps its name; the reference is served under a derived
      // name, since GraphQL type names must be unique.
      expect(sdl.match(/^type Person /gm)).toHaveLength(1);
      expect(sdl).toMatch(/author: PersonReference/);
      expect(sdl).toMatch(
        /type PersonReference \{\s+id: String!\s+name: \[LanguageString!\]!\s+\}/,
      );
    });

    it('throws when the derived reference name is itself taken', () => {
      const takenDerivedName: SearchType = {
        name: 'PersonReference',
        class: 'https://example.org/PersonReference',
        fields: [{ name: 'name', kind: 'keyword', output: true }],
      };
      const withReferenceToRoot: SearchType = {
        name: 'CreativeWork',
        class: 'https://schema.org/CreativeWork',
        fields: [
          {
            name: 'author',
            kind: 'reference',
            output: true,
            ref: { typeName: 'Person', strategy: 'labelOnly' },
          },
        ],
      };
      expect(() =>
        buildGraphQLSchema(
          searchSchema(PERSON, takenDerivedName, withReferenceToRoot),
        ),
      ).toThrow(
        /Reference type “Person”.*would be served as “PersonReference”, which collides/,
      );
    });

    it('rejects a duplicate root type name at declaration time', () => {
      const alsoPerson: SearchType = {
        name: 'Person',
        class: 'https://example.org/OtherPerson',
        fields: [{ name: 'name', kind: 'keyword', output: true }],
      };
      // searchSchema() rejects the duplicate; SearchSchema is branded, so a
      // hand-built Map cannot even be passed to buildGraphQLSchema.
      expect(() => searchSchema(PERSON, alsoPerson)).toThrow(
        /Duplicate search type name “Person”/,
      );
      // @ts-expect-error – a hand-built map is not a (branded) SearchSchema
      void (() => buildGraphQLSchema(new Map([[PERSON.class, PERSON]])));
    });

    it('throws on options for an unknown type and on a root-field clash', () => {
      expect(() =>
        buildGraphQLSchema(searchSchema(PERSON), {
          types: {
            Unknown: { queryField: 'unknowns' },
          },
        }),
      ).toThrow(/not in the search schema/);
      expect(() =>
        buildGraphQLSchema(searchSchema(PERSON, CREATIVE_WORK), {
          types: {
            [PERSON.name]: { queryField: 'items' },
            [CREATIVE_WORK.name]: { queryField: 'items' },
          },
        }),
      ).toThrow(/Duplicate root query field/);
    });
  });
});

describe('und-locale text output', () => {
  it('serves untagged text as a LanguageString list with a null language', async () => {
    const doc: SearchType = {
      name: 'Doc',
      class: 'urn:example:Doc',
      fields: [
        { name: 'summary', kind: 'text', locales: ['und'], output: true },
      ],
    };
    const gqlSchema = buildGraphQLSchema(searchSchema(doc));
    expect(printSchema(gqlSchema)).toMatch(/summary: \[LanguageString!\]!/);
    const engine: SearchEngine = {
      schema: searchSchema(doc),
      async search(): Promise<SearchResult> {
        return {
          total: 1,
          facets: {},
          hits: [
            {
              id: 'https://d/1',
              document: { summary: { und: ['Plain prose'] } },
            },
          ],
        };
      },
      searchFacets: noFacets,
    };
    const result = await graphql({
      schema: gqlSchema,
      source: `{ docs { items { summary { language value } } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] },
    });
    expect(result.errors).toBeUndefined();
    const items = (
      result.data?.docs as {
        items: { summary: { language: string | null; value: string }[] }[];
      }
    ).items;
    expect(items[0].summary).toEqual([
      { language: null, value: 'Plain prose' },
    ]);
  });
});

describe('nested inline references', () => {
  const MEDIA_OBJECT: SearchType = {
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
      {
        name: 'caption',
        kind: 'text',
        locales: ['nl'],
        output: true,
        path: 'https://schema.org/caption',
      },
      // No Role: pruned before the writer, so it is no part of the API either.
      { name: 'rawWidth', kind: 'keyword', path: 'https://schema.org/width' },
    ],
  };
  const CREATIVE_WORK_WITH_MEDIA: SearchType = {
    name: 'CreativeWork',
    class: 'https://schema.org/CreativeWork',
    fields: [
      {
        name: 'media',
        kind: 'reference',
        array: true,
        output: true,
        path: 'https://schema.org/associatedMedia',
        ref: { typeName: 'MediaObject', strategy: 'inline' },
      },
    ],
  };
  const nestedSchema = searchSchema(CREATIVE_WORK_WITH_MEDIA, MEDIA_OBJECT);

  it('builds the reference type from the Reference Type’s output fields', () => {
    const sdl = printSchema(buildGraphQLSchema(nestedSchema));
    expect(sdl).toMatch(/media: \[MediaObject!\]!/);
    // Each field is typed by exactly the per-kind rules a root type’s fields
    // get. `id` is nullable: a referent needs no identity, so a blank-node one
    // nests without one.
    expect(sdl).toMatch(
      /type MediaObject \{\s+id: String\s+contentUrl: \[String!\]!\s+width: Int\s+caption: \[LanguageString!\]!\s+\}/,
    );
    // An Internal Field inside a Reference Type stays out of the API.
    expect(sdl).not.toMatch(/rawWidth/);
  });

  it('serves a nested object’s fields directly, one referent at a time', async () => {
    const { engine } = fakeEngine({
      total: 1,
      hits: [
        {
          id: 'https://ex/w/1',
          document: {
            media: [
              {
                id: 'https://ex/m/1',
                contentUrl: ['https://ex/1.jpg'],
                width: 4096,
                caption: { nl: ['Voorkant'] },
              },
              // A blank-node referent: no id, and no width.
              { contentUrl: ['https://ex/2.jpg'] },
            ],
          },
        },
      ],
      facets: {},
    });
    const result = await graphql({
      schema: buildGraphQLSchema(nestedSchema),
      source: `{
        creativeWorks {
          items {
            id
            media { id contentUrl width caption { language value } }
          }
        }
      }`,
      contextValue: { engine, acceptLanguage: ['nl'] },
    });

    expect(result.errors).toBeUndefined();
    // The response shape matches the data's shape: each referent's values stay
    // together instead of arriving as parallel arrays to pair by index.
    expect(result.data).toEqual({
      creativeWorks: {
        items: [
          {
            id: 'https://ex/w/1',
            media: [
              {
                id: 'https://ex/m/1',
                contentUrl: ['https://ex/1.jpg'],
                width: 4096,
                caption: [{ language: 'nl', value: 'Voorkant' }],
              },
              {
                id: null,
                contentUrl: ['https://ex/2.jpg'],
                width: null,
                caption: [],
              },
            ],
          },
        ],
      },
    });
  });

  it('serves a reference type that itself nests one', () => {
    const thumbnail: SearchType = {
      name: 'Thumbnail',
      fields: [
        {
          name: 'contentUrl',
          kind: 'keyword',
          output: true,
          path: 'https://schema.org/contentUrl',
        },
      ],
    };
    const media: SearchType = {
      name: 'MediaObject',
      fields: [
        {
          name: 'thumbnail',
          kind: 'reference',
          output: true,
          path: 'https://schema.org/thumbnail',
          ref: { typeName: 'Thumbnail', strategy: 'inline' },
        },
      ],
    };
    const sdl = printSchema(
      buildGraphQLSchema(
        searchSchema(CREATIVE_WORK_WITH_MEDIA, media, thumbnail),
      ),
    );
    expect(sdl).toMatch(
      /type MediaObject \{\s+id: String\s+thumbnail: Thumbnail\s+\}/,
    );
    expect(sdl).toMatch(
      /type Thumbnail \{\s+id: String\s+contentUrl: String\s+\}/,
    );
  });
});
