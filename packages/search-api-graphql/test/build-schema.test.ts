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
            publisher { id label { language value } }
            terminologySource { id label { language value } }
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
      label: [{ language: 'nl', value: 'Het Utrechts Archief' }],
    });
    expect(item.size).toBe(1234);
    expect(item.datePosted).toBe('2023-11-14T22:13:20.000Z');
    expect(item.score).toBe(4.5);
    expect(item.terminologySource).toEqual([
      { id: 'https://term/1', label: [{ language: 'nl', value: 'Kaarten' }] },
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

  it('refuses to serve a non-IRI under IRI, naming the index rather than the query', async () => {
    // An index written before the projection dropped blank-node referents. The
    // field is typed `IRI`, and the coarse discovery strategy reads that as the
    // promise that the value is a selection key – serving `_:b0` under it would
    // make the promise false exactly where a consumer acts on it.
    const { engine } = fakeEngine({
      total: 0,
      hits: [],
      facets: { publisher: [{ value: '_:b0', count: 1 }] },
    });
    const result = await run(
      `{ datasets { facets { publisher { value } } } }`,
      {
        engine,
        acceptLanguage: ['nl'],
      },
    );
    expect(result.errors?.[0]?.message).toMatch(
      /IRI cannot serialize “_:b0”.*reindex/is,
    );
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

  it('serves boolean-facet buckets as real booleans, ready to send straight back as a filter', async () => {
    const { engine, received } = fakeEngine({
      total: 0,
      hits: [],
      facets: {
        iiif: [
          { value: 'true', is: true, count: 1071 },
          { value: 'false', is: false, count: 342 },
        ],
      },
    });
    const result = await run(
      `{ datasets { facets { iiif { value count } } } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    const facets = (result.data?.datasets as Record<string, unknown>)
      .facets as { iiif: { value: boolean; count: number }[] };
    expect(facets.iiif).toEqual([
      { value: true, count: 1071 },
      { value: false, count: 342 },
    ]);
    // The bucket a client picked is exactly what its filter takes: no reparsing.
    await run(
      `query ($iiif: Boolean) { datasets(where: { iiif: $iiif }) { pagination { total } } }`,
      { engine, acceptLanguage: ['nl'] },
      { iiif: facets.iiif[0].value },
    );
    expect(received().where).toEqual([{ or: [{ field: 'iiif', is: true }] }]);
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
      facetQuery.where.find((filter) =>
        filter.or.some((criterion) => criterion.field === 'keyword'),
      ),
    ).toBeUndefined();
    expect(facetQuery.where).toContainEqual({
      or: [{ field: 'status', in: ['valid'] }],
    });
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
    expect(batch[0].where).toEqual([
      { or: [{ field: 'status', in: ['valid'] }] },
    ]);
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
    expect(query.where).toContainEqual({
      or: [{ field: 'status', in: ['valid'] }],
    });
    // An empty filter compiles to an empty membership.
    expect(query.where).toContainEqual({ or: [{ field: 'keyword', in: [] }] });
    expect(query.where).toContainEqual({
      or: [{ field: 'size', range: { min: 1, max: 9 } }],
    });
    expect(query.where).toContainEqual({ or: [{ field: 'iiif', is: true }] });
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
      { or: [{ field: 'id', in: ['https://id.example.org/a', 'urn:b'] }] },
    ]);

    // An empty filter compiles to an empty membership, as for any field.
    const empty = fakeEngine(canned);
    await run(`{ datasets(where: { id: {} }) { pagination { total } } }`, {
      engine: empty.engine,
      acceptLanguage: ['nl'],
    });
    expect(empty.received().where).toEqual([{ or: [{ field: 'id', in: [] }] }]);
  });

  it('maps `or` into one clause holding every alternative, ANDed with its siblings', async () => {
    // The entity-page query: one IRI across the document's own identity and its
    // reference fields, answered by a single search.
    const { engine, received } = fakeEngine(canned);
    await run(
      `{
        datasets(where: {
          or: [{ id: { in: ["urn:vg"] } }, { publisher: { in: ["urn:vg"] } }]
          status: { in: ["valid"] }
        }) {
          pagination { total }
        }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );
    // One clause for the disjunction…
    expect(received().where).toContainEqual({
      or: [
        { field: 'id', in: ['urn:vg'] },
        { field: 'publisher', in: ['urn:vg'] },
      ],
    });
    // …and a separate clause for the sibling key, so the two AND.
    expect(received().where).toContainEqual({
      or: [{ field: 'status', in: ['valid'] }],
    });
  });

  it('maps `and` into further clauses, so a query can carry two disjunctions', async () => {
    const { engine, received } = fakeEngine(canned);
    await run(
      `{
        datasets(where: {
          and: [
            { or: [{ publisher: { in: ["urn:vg"] } }, { keyword: { in: ["urn:vg"] } }] }
            { or: [{ status: { in: ["valid"] } }, { size: { min: 100 } }] }
          ]
        }) {
          pagination { total }
        }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );
    // Two independent disjunctions, ANDed – the shape a single `or` cannot hold.
    expect(received().where).toEqual([
      {
        or: [
          { field: 'publisher', in: ['urn:vg'] },
          { field: 'keyword', in: ['urn:vg'] },
        ],
      },
      {
        or: [
          { field: 'status', in: ['valid'] },
          { field: 'size', range: { min: 100, max: undefined } },
        ],
      },
    ]);
  });

  it('treats `and` over plain criteria as identical to sibling keys', async () => {
    // Sibling keys already AND, so `and` is optional for plain criteria – it
    // earns its keep only when a query needs a SECOND `or` (above). Pinned
    // because the reference docs state the two forms are the same query.
    const siblings = fakeEngine(canned);
    await run(
      `{
        datasets(where: { status: { in: ["valid"] }, keyword: { in: ["atlas"] } }) {
          pagination { total }
        }
      }`,
      { engine: siblings.engine, acceptLanguage: ['nl'] },
    );
    const explicit = fakeEngine(canned);
    await run(
      `{
        datasets(where: { and: [
          { status: { in: ["valid"] } }
          { keyword: { in: ["atlas"] } }
        ] }) {
          pagination { total }
        }
      }`,
      { engine: explicit.engine, acceptLanguage: ['nl'] },
    );
    // Same clauses, and `where` is a conjunction – so the order they arrive in
    // carries no meaning. Sibling keys emit in field-declaration order, `and`
    // in the order written.
    const clauses = (query: SearchQuery) =>
      [...query.where].map((filter) => JSON.stringify(filter)).sort();
    expect(clauses(explicit.received())).toEqual(clauses(siblings.received()));
  });

  it('treats an explicit `where: null` as no filter at all', async () => {
    const { engine, received } = fakeEngine(canned);
    const result = await run(
      `{ datasets(where: null) { pagination { total } } }`,
      { engine, acceptLanguage: ['nl'] },
    );
    expect(result.errors).toBeUndefined();
    expect(received().where).toEqual([]);
  });

  it('nests `and` to any depth, flattening it into one conjunction', async () => {
    // `and` carries further `Where`s, so it is recursive – safe, because a
    // conjunction inside a conjunction collapses, and an `and` can never sit
    // inside an `or` (which holds only criteria).
    const { engine, received } = fakeEngine(canned);
    await run(
      `{
        datasets(where: {
          status: { in: ["valid"] }
          and: [{ and: [{ keyword: { in: ["atlas"] } }] }]
        }) {
          pagination { total }
        }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );
    expect(received().where).toEqual([
      { or: [{ field: 'status', in: ['valid'] }] },
      { or: [{ field: 'keyword', in: ['atlas'] }] },
    ]);
  });

  it('rejects a criterion naming two fields: a criterion is an atom', async () => {
    // `@oneOf` is what keeps `where` a flat conjunction of disjunctions – a
    // two-key criterion would be a conjunction nested inside an `or`, which the
    // IR cannot represent and skip-own-filter could not reason about. Caught by
    // GraphQL validation, before any resolver runs.
    const { engine } = fakeEngine(canned);
    const result = await run(
      `{
        datasets(where: {
          or: [{ status: { in: ["valid"] }, keyword: { in: ["atlas"] } }]
        }) {
          pagination { total }
        }
      }`,
      { engine, acceptLanguage: ['nl'] },
    );
    expect(result.errors?.[0]?.message).toMatch(/exactly one key/i);
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
            where: [
              ...query.where,
              { or: [{ field: 'status', in: ['valid'] }] },
            ],
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
    expect(captured?.where).toEqual([
      { or: [{ field: 'status', in: ['valid'] }] },
    ]);
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
    expect(sdl).toMatch(/iiif: \[BooleanBucket!\]!/);
    expect(sdl).toMatch(/input DatasetWhere/);
    expect(sdl).toMatch(/status: KeywordFilter/);
    expect(sdl).toMatch(/size: IntRange/);
  });

  it('buckets a reference facet on IRI, so a bucket feeds the filter that selects it', () => {
    const sdl = printSchema(
      buildGraphQLSchema(searchSchema(schema), datasetOptions),
    );
    // The round trip a consumer actually makes: read `publisher`’s bucket
    // `value`, send it back as `where: { publisher: { in: [...] } }`. Both sides
    // are `IRI`, so no `String`-to-`IRI` boundary sits in the middle – the same
    // contract BooleanBucket keeps for `is`.
    expect(sdl).toMatch(/publisher: \[IriBucket!\]!/);
    expect(sdl).toMatch(/type IriBucket \{\s+value: IRI!/);
    expect(sdl).toMatch(/publisher: OrganizationFilter/);
    // A literal-keyed facet keeps the literal-keyed bucket.
    expect(sdl).toMatch(/type ValueBucket \{\s+value: String!/);
  });

  it('gives a boolean facet a real boolean value and no label to interpret', () => {
    const sdl = printSchema(
      buildGraphQLSchema(searchSchema(schema), datasetOptions),
    );
    expect(sdl).toContain(
      ['type BooleanBucket {', '  value: Boolean!', '  count: Int!', '}'].join(
        '\n',
      ),
    );
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
      // A type declaring no filterable field is still addressable by IRI –
      // through the `id` key, and through the `or`/`and` combinators, whose
      // criteria then offer `id` alone.
      const personWhere = sdl.slice(sdl.indexOf('input PersonWhere {'));
      expect(personWhere.slice(0, personWhere.indexOf('\n}'))).toContain(
        'id: PersonFilter',
      );
      expect(sdl).toMatch(/input PersonWhere \{[^}]*or: \[PersonCriterion!\]/);
      // `and` carries further `Where`s, so there is no second clause type.
      expect(sdl).toMatch(/input PersonWhere \{[^}]*and: \[PersonWhere!\]/);
      expect(sdl).not.toContain('PersonClause');
      // A criterion is an atom, and for a type with no filterable field the
      // only atom available is the IRI lookup.
      expect(sdl).toMatch(
        /input PersonCriterion @oneOf \{\s*id: PersonFilter\s*\}/,
      );
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
        /type PersonReference \{\s+id: IRI!\s+label: \[LanguageString!\]!\s+\}/,
      );
    });

    it('serves the resolved label under the label source’s own label field name', () => {
      const namedLabel: SearchType = { ...PERSON, labelField: 'name' };
      const withReferenceToRoot: SearchType = {
        name: 'CreativeWork',
        class: 'https://schema.org/CreativeWork',
        fields: [
          {
            name: 'author',
            kind: 'reference',
            output: true,
            labelSource: 'Person',
            ref: { typeName: 'Person', strategy: 'labelOnly' },
          },
        ],
      };
      const sdl = printSchema(
        buildGraphQLSchema(searchSchema(namedLabel, withReferenceToRoot)),
      );
      expect(sdl).toMatch(
        /type PersonReference \{\s+id: IRI!\s+name: \[LanguageString!\]!\s+\}/,
      );
    });

    it('throws when fields sharing a reference type disagree on the label word', () => {
      // One emitted type cannot serve two words, and which one won would
      // otherwise come down to declaration order.
      const namedLabel: SearchType = { ...PERSON, labelField: 'name' };
      const organization: SearchType = {
        name: 'Organization',
        class: 'https://schema.org/Organization',
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
      const twoSources: SearchType = {
        name: 'CreativeWork',
        class: 'https://schema.org/CreativeWork',
        fields: [
          {
            name: 'creator',
            kind: 'reference',
            output: true,
            labelSource: 'Person',
            ref: { typeName: 'Agent', strategy: 'labelOnly' },
          },
          {
            name: 'publisher',
            kind: 'reference',
            output: true,
            labelSource: 'Organization',
            ref: { typeName: 'Agent', strategy: 'labelOnly' },
          },
        ],
      };
      expect(() =>
        buildGraphQLSchema(searchSchema(namedLabel, organization, twoSources)),
      ).toThrow(
        /“CreativeWork.creator” serves its label as “name”, but “Agent” is already served with “label”/,
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
      /type MediaObject \{\s+id: IRI\s+contentUrl: \[String!\]!\s+width: Int\s+caption: \[LanguageString!\]!\s+\}/,
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
          array: true,
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
      /type MediaObject \{\s+id: IRI\s+thumbnail: Thumbnail\s+\}/,
    );
    expect(sdl).toMatch(
      /type Thumbnail \{\s+id: IRI\s+contentUrl: \[String!\]!\s+\}/,
    );
  });
});

describe('field descriptions', () => {
  // A declaration is the only place a schema author can speak: the module is
  // plain data, mounted, with no hook to decorate the built schema afterwards.
  // So `description` has to reach every surface the field appears on, or it
  // reaches the reader in some places and not others.
  const described = {
    name: 'CreativeWork',
    class: 'https://schema.org/CreativeWork',
    fields: [
      {
        name: 'creator',
        kind: 'reference',
        description:
          'Creators identified by URI. Absent where the publisher named one inline; see creatorName.',
        filterable: true,
        output: true,
        ref: { typeName: 'Person', strategy: 'labelOnly' },
        labelSource: 'Person',
      },
      {
        name: 'creatorName',
        kind: 'text',
        description:
          'Every creator’s name as published, including those with no URI. Free text, not a facet.',
        locales: ['nl'],
        output: true,
        searchable: { weight: 3 },
      },
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
    ],
  } satisfies SearchType;

  // A label source must exist and expose an `output`, `searchable` `label`.
  const person = {
    name: 'Person',
    class: 'https://schema.org/Person',
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
    ],
  } satisfies SearchType;

  const sdl = () =>
    printSchema(buildGraphQLSchema(searchSchema(described, person)));

  it('describes an output field', () => {
    expect(sdl()).toMatch(
      /"""\s+Every creator’s name as published[^"]*"""\s+creatorName:/,
    );
  });

  it('describes the same field where it is filtered on', () => {
    // The `where` input names the field a second time; a reader filtering by it
    // is the one most likely to need telling what it covers.
    expect(sdl()).toMatch(
      /"""\s+Creators identified by URI[^"]*"""\s+creator: PersonFilter/,
    );
  });

  it('leaves a field without one undescribed', () => {
    // Not merely “the field is there”: assert no description block precedes it,
    // or this would pass whether or not one had been emitted.
    expect(sdl()).not.toMatch(/"""[^"]*"""\s+label: \[LanguageString/);
    expect(sdl()).toMatch(/\n {2}label: \[LanguageString!\]!/);
  });
});

describe('discovering which fields accept an IRI', () => {
  // Two collections, plus the fields a consumer has to be able to tell apart:
  // references to an indexed target (`about`, `material`, `creator`), a
  // reference to a target no collection serves (`license`), and a literal field
  // whose values look nothing like IRIs (`identifier`).
  const term: RootType = {
    name: 'Term',
    class: 'https://schema.org/DefinedTerm',
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
    ],
  };
  const person: RootType = {
    name: 'Person',
    class: 'https://schema.org/Person',
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
    ],
  };
  const work: RootType = {
    name: 'CreativeWork',
    class: 'https://schema.org/CreativeWork',
    fields: [
      { name: 'identifier', kind: 'keyword', filterable: true, output: true },
      {
        name: 'about',
        kind: 'reference',
        array: true,
        filterable: true,
        output: true,
        labelSource: 'Term',
        ref: { typeName: 'Term', strategy: 'labelOnly' },
      },
      {
        name: 'material',
        kind: 'reference',
        array: true,
        filterable: true,
        output: true,
        labelSource: 'Term',
        ref: { typeName: 'Term', strategy: 'labelOnly' },
      },
      {
        name: 'creator',
        kind: 'reference',
        array: true,
        filterable: true,
        output: true,
        labelSource: 'Person',
        ref: { typeName: 'Person', strategy: 'labelOnly' },
      },
      {
        name: 'license',
        kind: 'reference',
        array: true,
        filterable: true,
        output: true,
        ref: { strategy: 'idOnly' },
      },
      // Single-valued, so the flat IRI is the value rather than a list of them.
      {
        name: 'iiifManifest',
        kind: 'reference',
        output: true,
        ref: { strategy: 'idOnly' },
      },
    ],
  };
  const built = buildGraphQLSchema(searchSchema(term, person, work));

  /**
   * ONE introspection round-trip, of the kind a consumer already sends – no
   * bespoke endpoint, no metadata query, no directives (applied directives are
   * absent from standard introspection anyway). Everything below is derived
   * from this result; not one domain name is written into the traversal.
   */
  const INTROSPECTION = `{
    __schema {
      queryType { fields { name args { name type { name ofType { name } } } } }
      types {
        name
        inputFields { name type { name ofType { name kind ofType { name ofType { name } } } } }
      }
    }
  }`;

  interface TypeRef {
    readonly name: string | null;
    readonly kind?: string;
    readonly ofType?: TypeRef | null;
  }
  interface InputType {
    readonly name: string;
    readonly inputFields:
      readonly { readonly name: string; readonly type: TypeRef }[] | null;
  }

  /** The innermost named type of a possibly wrapped reference. */
  const named = (type: TypeRef | null | undefined): string | undefined =>
    type == null ? undefined : (type.name ?? named(type.ofType));

  async function introspect() {
    const result = await graphql({ schema: built, source: INTROSPECTION });
    expect(result.errors).toBeUndefined();
    const data = result.data as unknown as {
      __schema: {
        queryType: {
          fields: readonly {
            name: string;
            args: readonly { name: string; type: TypeRef }[];
          }[];
        };
        types: readonly InputType[];
      };
    };
    const byName = new Map(
      data.__schema.types.map((type) => [type.name, type]),
    );
    /** The `‹Type›Criterion` a root field reaches through its `where` argument:
     *  `where` → the Where input → its `or` key → the criterion element type.
     *  Structural throughout; no name is pattern-matched. */
    const criterionOf = (
      rootField:
        { args: readonly { name: string; type: TypeRef }[] } | undefined,
    ) => {
      const whereType = byName.get(
        named(rootField?.args.find((arg) => arg.name === 'where')?.type) ?? '',
      );
      const or = whereType?.inputFields?.find((field) => field.name === 'or');
      return byName.get(named(or?.type) ?? '');
    };
    /** The element type of a filter input's `in` key, or undefined when the
     *  filter has none (a range or a boolean). */
    const elementOf = (filterName: string | undefined) =>
      named(
        byName
          .get(filterName ?? '')
          ?.inputFields?.find((field) => field.name === 'in')?.type,
      );
    return { data, byName, criterionOf, elementOf };
  }

  it('answers the coarse strategy: every field that accepts an IRI, with no origin collection', async () => {
    // What a consumer holding an IRI of unknown provenance needs: select every
    // criterion field whose filter takes IRIs. No knowledge of the domain, and
    // no idea which collection the IRI came from.
    const { data, criterionOf, elementOf } = await introspect();
    const iriFields = new Map<string, string[]>();
    for (const rootField of data.__schema.queryType.fields) {
      const criterion = criterionOf(rootField);
      iriFields.set(
        rootField.name,
        (criterion?.inputFields ?? [])
          .filter((field) => elementOf(named(field.type)) === 'IRI')
          .map((field) => field.name),
      );
    }

    // Every reference field is found – whether or not its target is a
    // collection – and `identifier`, which keys on a literal, is not.
    expect(iriFields.get('creativeWorks')).toEqual([
      'id',
      'about',
      'material',
      'creator',
      'license',
    ]);
    expect(iriFields.get('terms')).toEqual(['id']);
  });

  it('answers the refined strategy: the fields that could reference the collection being browsed', async () => {
    // The consumer knows only which root field it queried – an opaque string to
    // it. It resolves that collection to its filter type through `‹Type›Where.id`,
    // then selects the criterion fields of every collection whose filter is the
    // SAME type. The type name is compared, never parsed.
    const { data, criterionOf } = await introspect();
    const browsing = data.__schema.queryType.fields.find(
      (field) => field.name === 'terms',
    );
    const idFilter = named(
      criterionOf(browsing)?.inputFields?.find((field) => field.name === 'id')
        ?.type,
    );

    const referencing = new Map<string, string[]>();
    for (const rootField of data.__schema.queryType.fields) {
      referencing.set(
        rootField.name,
        (criterionOf(rootField)?.inputFields ?? [])
          .filter((field) => named(field.type) === idFilter)
          .map((field) => field.name),
      );
    }

    // Only the Term-valued references – `creator` points at Person and
    // `license` at a target no collection serves, so neither is offered.
    expect(referencing.get('creativeWorks')).toEqual(['about', 'material']);
    // The collection's own identity is the other half of the entity-page query:
    // `or: [{ id: $iri }, { about: $iri }, { material: $iri }]`.
    expect(referencing.get('terms')).toEqual(['id']);
  });

  it('rejects a value that is not an IRI, instead of matching nothing', async () => {
    // The mistake this exists to catch: a readable token pasted into a field
    // that keys on identity. Previously valid against the schema, and silently
    // empty.
    const engine: SearchEngine = {
      schema: searchSchema(term, person, work),
      async search() {
        throw new Error('the engine must never be reached');
      },
      searchFacets: noFacets,
    };
    const result = await graphql({
      schema: built,
      source: `{ creativeWorks(where: { material: { in: ["boerenbont"] } }) { pagination { total } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] },
    });
    expect(result.errors?.[0]?.message).toMatch(
      /IRI cannot represent “boerenbont”/,
    );
    // …while the literal-keyed field beside it takes the very same value.
    const ok = await graphql({
      schema: built,
      source: `{ creativeWorks(where: { identifier: { in: ["boerenbont"] } }) { pagination { total } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] },
    });
    expect(ok.errors?.[0]?.message).not.toMatch(/IRI cannot represent/);
  });

  it('carries IRIs through variables and back out as a flat list', async () => {
    // The other half of the round-trip: a consumer declares `[IRI!]` (not
    // `[String!]` – GraphQL checks variable usage nominally), and an idOnly
    // reference comes back as the bare IRIs it holds rather than as objects
    // wrapping them.
    const engine: SearchEngine = {
      schema: searchSchema(term, person, work),
      async search(): Promise<SearchResult> {
        return {
          total: 2,
          hits: [
            {
              id: 'https://works/1',
              document: {
                license: [
                  { id: 'https://creativecommons.org/licenses/by/4.0/' },
                  // A referent carrying no IRI drops out, rather than nulling
                  // the non-null list and with it the whole hit.
                  {},
                ],
                iiifManifest: { id: 'https://works/1/manifest.json' },
              },
            },
            // A work asserting no licence: the list is empty, never null.
            { id: 'https://works/2', document: {} },
          ],
          facets: {},
        };
      },
      searchFacets: noFacets,
    };
    const result = await graphql({
      schema: built,
      source: `query ($iris: [IRI!]) {
        creativeWorks(where: { material: { in: $iris } }) {
          items { id license iiifManifest }
        }
      }`,
      variableValues: { iris: ['https://id.example.org/term/1'] },
      contextValue: { engine, acceptLanguage: ['nl'] },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      creativeWorks: {
        items: [
          {
            id: 'https://works/1',
            license: ['https://creativecommons.org/licenses/by/4.0/'],
            iiifManifest: 'https://works/1/manifest.json',
          },
          // A work asserting neither: an empty list, and a null scalar.
          { id: 'https://works/2', license: [], iiifManifest: null },
        ],
      },
    });
  });

  it('refuses a type whose filter name would collide with a built-in one', async () => {
    // graphql-js would reject the duplicate too, but only once the whole schema
    // is assembled and without naming the declaration that caused it.
    const keyword: RootType = {
      name: 'Keyword',
      class: 'https://example.org/Keyword',
      fields: [],
    };
    expect(() => buildGraphQLSchema(searchSchema(keyword))).toThrow(
      /“Keyword” would be filtered through “KeywordFilter”/,
    );

    // …and equally when the clash is with a type the declaration itself emits:
    // a reference served as `TermFilter` beside a root type `Term`.
    const clashing: RootType = {
      name: 'Term',
      class: 'https://example.org/Term',
      fields: [
        {
          name: 'seeAlso',
          kind: 'reference',
          output: true,
          ref: { typeName: 'TermFilter', strategy: 'labelOnly' },
        },
      ],
    };
    expect(() => buildGraphQLSchema(searchSchema(clashing))).toThrow(
      /“Term” would be filtered through “TermFilter”/,
    );
  });
});
