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

const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA_ORG}Person`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'dateCreated',
      kind: 'date',
      output: true,
      filterable: true,
      presence: true,
    },
    { name: 'material', kind: 'keyword', filterable: true, presence: true },
    {
      name: 'creator',
      kind: 'reference',
      filterable: true,
      presence: true,
      ref: { strategy: 'lookup', target: 'Person' },
    },
    { name: 'image', kind: 'keyword', array: true, presence: true },
  ],
});

const schema = searchSchema(work, person);
const gqlSchema = buildGraphQLSchema(schema, {});

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
          'dateCreated.exists': {
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

describe('a field filtered on whether it has a value', () => {
  const printed = printSchema(gqlSchema);

  it('gives a filterable field a variant of its own filter with `exists`', () => {
    expect(printed).toMatch(
      /input DateRangeOrExists \{[^}]*min: ISO8601Date[^}]*max: ISO8601Date[^}]*exists: Boolean[^}]*\}/,
    );
    expect(printed).toMatch(/dateCreated: DateRangeOrExists/);
    expect(printed).toMatch(/material: KeywordFilterOrExists/);
    expect(printed).toMatch(/creator: PersonFilterOrExists/);
  });

  it('gives a field declaring presence alone an input with `exists` only', () => {
    expect(printed).toMatch(/input ExistsFilter \{[^}]*exists: Boolean\s*\}/);
    expect(printed).toMatch(/image: ExistsFilter/);
  });

  it('compiles `exists` into a criterion of its own', async () => {
    const { response, searched } = await run(
      `{ works(where: { dateCreated: { exists: false }, image: { exists: true } }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      { or: [{ field: 'dateCreated', exists: false }] },
      { or: [{ field: 'image', exists: true }] },
    ]);
  });

  it('reads the field’s other keys when `exists` is unset or null', async () => {
    const { response, searched } = await run(
      `{ works(where: { dateCreated: { min: "1900", exists: null }, image: {} }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      { or: [{ field: 'dateCreated', range: { min: '1900' } }] },
    ]);
  });

  it('takes `exists` as an alternative inside `or`', async () => {
    const { response, searched } = await run(
      `{ works(where: { or: [{ dateCreated: { exists: false } }, { dateCreated: { min: "1900" } }] }) { pagination { total } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      {
        or: [
          { field: 'dateCreated', exists: false },
          { field: 'dateCreated', range: { min: '1900' } },
        ],
      },
    ]);
  });

  it('refuses `exists` beside another key, naming the rewrite', async () => {
    const { response, searched } = await run(
      `{ works(where: { dateCreated: { exists: true, min: "1900" } }) { pagination { total } } }`,
    );

    expect(searched).toEqual([]);
    expect(response.errors?.[0]?.message).toMatch(
      /“dateCreated” sets “exists” together with “min”.*and: \[\{ dateCreated: \{ exists: true \} \}, \{ dateCreated: \{ min: … \} \}\]/,
    );
    expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});

describe('a field faceted on whether it has a value', () => {
  it('serves the facet under the field it counts', () => {
    const printed = printSchema(gqlSchema);

    expect(printed).toMatch(/dateCreated: WorkDateCreatedFacet!/);
    expect(printed).toMatch(
      /type WorkDateCreatedFacet \{[^}]*exists: \[BooleanBucket!\]!\s*\}/,
    );
  });

  it('asks the engine for the facet by its name, and serves boolean buckets', async () => {
    const { response, faceted } = await run(
      `{ works { facets { dateCreated { exists { value count } } } } }`,
    );

    expect(response.errors).toBeUndefined();
    expect(faceted.map((query) => query.facets)).toEqual([
      ['dateCreated.exists'],
    ]);
    expect(response.data).toEqual({
      works: {
        facets: {
          dateCreated: {
            exists: [
              { value: true, count: 2 },
              { value: false, count: 1 },
            ],
          },
        },
      },
    });
  });
});

describe('the shared presence filter', () => {
  it('claims its name, so a root type named “Exists” is refused clearly', () => {
    const exists = defineSearchType({
      name: 'Exists',
      class: `${SCHEMA_ORG}Thing`,
      fields: [{ name: 'title', kind: 'keyword', output: true }],
    });

    expect(() => buildGraphQLSchema(searchSchema(exists), {})).toThrow(
      /would be filtered through “ExistsFilter”, which is already the name of another type/,
    );
  });
});

describe('a filter’s presence variant', () => {
  it('claims its name, so a type of that name is refused clearly', () => {
    const clashing = defineSearchType({
      name: 'DateRangeOrExists',
      class: `${SCHEMA_ORG}Thing`,
      fields: [{ name: 'title', kind: 'keyword', output: true }],
    });

    expect(() =>
      buildGraphQLSchema(searchSchema(work, person, clashing), {}),
    ).toThrow(
      /Filter “DateRange” would take “exists” through “DateRangeOrExists”, which is already the name of another type/,
    );
  });
});

describe('a field declaring presence on a joined type', () => {
  const dataset = defineSearchType({
    name: 'Dataset',
    class: 'https://example.org/Dataset',
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
      { name: 'issued', kind: 'date', filterable: true, presence: true },
      { name: 'image', kind: 'keyword', presence: true },
    ],
  });
  const joined = defineSearchType({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields: [
      {
        name: 'dataset',
        kind: 'reference',
        filterable: true,
        labelSource: 'Dataset',
        joinable: true,
      },
    ],
  });
  const printed = printSchema(
    buildGraphQLSchema(searchSchema(dataset, joined), {}),
  );

  it('keeps `exists` in the type’s own where', () => {
    expect(printed).toMatch(
      /input DatasetWhere \{[^}]*issued: DateRangeOrExists[^}]*image: ExistsFilter/,
    );
  });

  it('leaves presence out of the where reached through a join, which reads no companion', () => {
    expect(printed).toMatch(
      /input DatasetReferenceFilter[^}]*where: DatasetJoinedWhere/,
    );
    const joinedWhere = /input DatasetJoinedWhere \{([^}]*)\}/.exec(printed);
    expect(joinedWhere?.[1]).toMatch(/issued: DateRange\n/);
    expect(joinedWhere?.[1]).not.toMatch(/image|exists|OrExists/);
    expect(printed).toMatch(
      /input DatasetJoinedCriterion @oneOf \{[^}]*issued: DateRange\n[^}]*\}/,
    );
  });
});
