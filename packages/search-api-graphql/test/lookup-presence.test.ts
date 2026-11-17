import { describe, expect, it } from 'vitest';
import { graphql, printSchema } from 'graphql';
import {
  defineSearchType,
  searchSchema,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema, type SearchContext } from '../src/build-schema.js';

const SCHEMA_ORG = 'https://schema.org/';
const VENLO = 'https://sws.geonames.org/2745707';
const KESSEL = 'https://ex/place/kessel';

const place = defineSearchType({
  name: 'Place',
  class: `${SCHEMA_ORG}Place`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `${SCHEMA_ORG}name`,
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'latitude',
      kind: 'number',
      path: `${SCHEMA_ORG}latitude`,
      output: true,
    },
    {
      name: 'longitude',
      kind: 'number',
      path: `${SCHEMA_ORG}longitude`,
      output: true,
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'material', kind: 'keyword', facetable: true, filterable: true },
    {
      name: 'contentLocation',
      kind: 'reference',
      path: `${SCHEMA_ORG}contentLocation`,
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: {
        strategy: 'lookup',
        target: 'Place',
        presenceLeaves: ['latitude', 'longitude'],
      },
    },
    {
      name: 'locationCreated',
      kind: 'reference',
      path: `${SCHEMA_ORG}locationCreated`,
      filterable: true,
      ref: { strategy: 'lookup', target: 'Place' },
    },
  ],
});

const schema = searchSchema(work, place);
const gqlSchema = buildGraphQLSchema(schema, {});
const printed = printSchema(gqlSchema);

function recordingEngine() {
  const searched: SearchQuery[] = [];
  const faceted: SearchQuery[] = [];
  const engine: SearchEngine = {
    schema,
    async search(_searchType: SearchType, query: SearchQuery) {
      searched.push(query);
      return { total: 0, hits: [], facets: {} } as SearchResult;
    },
    async searchFacets(_searchType, queries) {
      faceted.push(...queries);
      return queries.map(() => ({
        facets: {
          material: { buckets: [{ value: 'hout', count: 3 }], totalValues: 1 },
          contentLocation: {
            buckets: [
              { value: VENLO, count: 2 },
              { value: KESSEL, count: 1 },
            ],
            totalValues: 2,
          },
          'contentLocation.latitude.exists': {
            buckets: [
              { value: 'true', count: 2, is: true },
              { value: 'false', count: 1, is: false },
            ],
          },
        },
      })) as never;
    },
  };
  return { engine, searched, faceted };
}

async function run(source: string) {
  const recording = recordingEngine();
  const response = await graphql({
    schema: gqlSchema,
    source,
    contextValue: {
      engine: recording.engine,
      acceptLanguage: ['nl'],
    } as SearchContext,
  });
  return { response, ...recording };
}

describe('one facet object per field', () => {
  it('keeps the plain facet type for a field counting only its own values', () => {
    expect(printed).toMatch(/material\([^)]*\): ValueFacet!/);
  });

  it('gives a field counting more an object holding everything counted on it', () => {
    expect(printed).toMatch(
      /contentLocation\(\s*"""[^"]*"""\s*limit: Int\s*\): WorkContentLocationFacet!/,
    );
    expect(printed).toMatch(
      /type WorkContentLocationFacet \{[^}]*buckets: \[IRIBucket!\]![^}]*totalValues: Int\s*latitude: WorkContentLocationLatitudeFacet!\s*longitude: WorkContentLocationLongitudeFacet!\s*\}/,
    );
    expect(printed).toMatch(
      /type WorkContentLocationLatitudeFacet \{[^}]*exists: \[BooleanBucket!\]!\s*\}/,
    );
  });

  it('caps the field’s own buckets with its limit, and counts its leaf beside them', async () => {
    const { response, faceted } = await run(
      `{ works { facets { contentLocation(limit: 1) { buckets { value count } totalValues latitude { exists { value count } } } } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(faceted.map((query) => query.facets)).toEqual([
      ['contentLocation', 'contentLocation.latitude.exists'],
    ]);
    expect(faceted[0]?.facetLimits).toEqual({ contentLocation: 1 });
    expect(response.data).toEqual({
      works: {
        facets: {
          contentLocation: {
            buckets: [
              { value: VENLO, count: 2 },
              { value: KESSEL, count: 1 },
            ],
            totalValues: 2,
            latitude: {
              exists: [
                { value: true, count: 2 },
                { value: false, count: 1 },
              ],
            },
          },
        },
      },
    });
  });

  it('refuses a limit out of range', async () => {
    const { response } = await run(
      `{ works { facets { contentLocation(limit: 0) { totalValues } } } }`,
    );

    expect(response.errors?.[0]?.message).toMatch(
      /limit must be between 1 and 100; got 0/,
    );
  });
});

describe('a lookup filtered on whether a referent’s leaf has a value', () => {
  it('takes a filter of its own, beside its ids', () => {
    expect(printed).toMatch(/contentLocation: WorkContentLocationFilter\n/);
    expect(printed).toMatch(
      /input WorkContentLocationFilter @oneOf \{[^}]*in: \[IRI!\][^}]*where: WorkContentLocationWhere\s*\}/,
    );
    expect(printed).toMatch(
      /input WorkContentLocationWhere \{[^}]*latitude: ExistsFilter\s*longitude: ExistsFilter\s*\}/,
    );
    // A lookup counting no leaf keeps its target’s filter.
    expect(printed).toMatch(/locationCreated: PlaceFilter\n/);
  });

  it('compiles `exists` on the leaf into a plain criterion on the root', async () => {
    const { response, searched } = await run(
      `{ works(where: { contentLocation: { where: { latitude: { exists: false } } } }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      {
        or: [{ field: 'contentLocation', leaf: 'latitude', exists: false }],
      },
    ]);
  });

  it('ANDs two leaves in one `where`, as sibling keys', async () => {
    const { response, searched } = await run(
      `{ works(where: { contentLocation: { where: { latitude: { exists: true }, longitude: { exists: false } } } }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      { or: [{ field: 'contentLocation', leaf: 'latitude', exists: true }] },
      { or: [{ field: 'contentLocation', leaf: 'longitude', exists: false }] },
    ]);
  });

  it('takes one leaf in an `or` alternative, and refuses two', async () => {
    const one = await run(
      `{ works(where: { or: [{ contentLocation: { where: { latitude: { exists: true } } } }, { material: { in: ["hout"] } }] }) { pagination { total } } }`,
    );
    expect(one.response.errors).toBeUndefined();
    expect(one.searched[0]?.where).toEqual([
      {
        or: [
          { field: 'contentLocation', leaf: 'latitude', exists: true },
          { field: 'material', in: ['hout'] },
        ],
      },
    ]);

    const two = await run(
      `{ works(where: { or: [{ contentLocation: { where: { latitude: { exists: true }, longitude: { exists: true } } } }] }) { pagination { total } } }`,
    );
    expect(two.response.errors?.[0]?.message).toMatch(
      /The condition on “contentLocation” states more than one criterion, so it is a conjunction/,
    );

    const none = await run(
      `{ works(where: { or: [{ contentLocation: { where: {} } }] }) { pagination { total } } }`,
    );
    expect(none.response.errors?.[0]?.message).toMatch(
      /The condition on “contentLocation” states no criterion, so it constrains nothing/,
    );
  });

  it('still filters by the ids it holds', async () => {
    const { response, searched } = await run(
      `{ works(where: { contentLocation: { in: ["${VENLO}"] } }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      { or: [{ field: 'contentLocation', in: [VENLO] }] },
    ]);
  });
});

describe('a numeric field counted by its range and its presence', () => {
  const dated = defineSearchType({
    name: 'Dated',
    class: `${SCHEMA_ORG}Event`,
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
      {
        name: 'startDate',
        kind: 'date',
        facetable: true,
        filterable: true,
        presence: true,
      },
    ],
  });
  const datedSchema = searchSchema(dated);
  const datedPrinted = printSchema(buildGraphQLSchema(datedSchema, {}));

  it('holds the range facet’s parts and `exists` in one object', async () => {
    expect(datedPrinted).toMatch(
      /type DatedStartDateFacet \{[^}]*all: DateExtent[^}]*matching: DateExtent[^}]*buckets: \[DateBucket!\]![^}]*exists: \[BooleanBucket!\]!\s*\}/,
    );
    const loaded: string[] = [];
    const engine: SearchEngine = {
      schema: datedSchema,
      async search() {
        return { total: 0, hits: [], facets: {} } as SearchResult;
      },
      async searchFacets(_searchType, queries) {
        loaded.push(...queries.flatMap((query) => query.facets));
        return queries.map(() => ({
          facets: {
            startDate: { buckets: [], extent: { min: 0, max: 86400 } },
            'startDate.exists': {
              buckets: [{ value: 'true', count: 1, is: true }],
            },
          },
        })) as never;
      },
    };
    const response = await graphql({
      schema: buildGraphQLSchema(datedSchema, {}),
      source: `{ dateds { facets { startDate { matching { min max } exists { value count } } } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] } as SearchContext,
    });

    expect(response.errors).toBeUndefined();
    expect(loaded).toEqual(['startDate', 'startDate.exists']);
    expect(response.data).toEqual({
      dateds: {
        facets: {
          startDate: {
            matching: {
              min: '1970-01-01T00:00:00Z',
              max: '1970-01-02T00:00:00Z',
            },
            exists: [{ value: true, count: 1 }],
          },
        },
      },
    });
  });
});

describe('a lookup with presence leaves on a joined type', () => {
  it('keeps its ids’ filter through the join, which reads no companion', () => {
    const item = defineSearchType({
      name: 'Item',
      class: `${SCHEMA_ORG}Product`,
      fields: [
        {
          name: 'work',
          kind: 'reference',
          filterable: true,
          labelSource: 'Work',
          joinable: true,
        },
      ],
    });
    const joinedPrinted = printSchema(
      buildGraphQLSchema(searchSchema(work, place, item), {}),
    );

    expect(joinedPrinted).toMatch(
      /input WorkJoinedWhere \{[^}]*contentLocation: PlaceFilter\n/,
    );
  });
});

describe('a keyword field counted by its values and its presence', () => {
  it('serves its literal buckets beside `exists`', () => {
    const tagged = defineSearchType({
      name: 'Tagged',
      class: `${SCHEMA_ORG}Thing`,
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          name: 'material',
          kind: 'keyword',
          facetable: true,
          filterable: true,
          presence: true,
        },
      ],
    });
    expect(printSchema(buildGraphQLSchema(searchSchema(tagged), {}))).toMatch(
      /type TaggedMaterialFacet \{[^}]*buckets: \[ValueBucket!\]![^}]*totalValues: Int[^}]*exists: \[BooleanBucket!\]!\s*\}/,
    );
  });
});
