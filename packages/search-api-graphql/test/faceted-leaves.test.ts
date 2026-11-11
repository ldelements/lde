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
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

const mediaObject = defineSearchType({
  name: 'MediaObject',
  fields: [
    {
      name: 'license',
      kind: 'reference',
      output: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
    },
    { name: 'encodingFormat', kind: 'keyword', output: true, filterable: true },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'associatedMedia',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      ref: {
        strategy: 'inline',
        typeName: 'MediaObject',
        facetedLeaves: ['license'],
      },
    },
  ],
});

const schema = searchSchema(work, mediaObject);
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
          'associatedMedia.license': {
            buckets: [{ value: CC_BY, count: 2 }],
          },
        },
      })) as never;
    },
  };
  return { engine, searched, faceted };
}

describe('a root type faceted on its entries’ leaves', () => {
  it('serves the facet under the reference it is reached through', () => {
    const printed = printSchema(gqlSchema);

    expect(printed).toMatch(
      /type WorkFacets \{\s*associatedMedia: WorkAssociatedMediaFacets!\s*\}/,
    );
    expect(printed).toMatch(
      /type WorkAssociatedMediaFacets \{\s*license: \[IRIBucket!\]!\s*\}/,
    );
  });

  it('asks the engine for the facet by its path', async () => {
    const { engine, faceted } = recordingEngine();

    const response = await graphql({
      schema: gqlSchema,
      source: `{ works { facets { associatedMedia { license { value count } } } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] } as SearchContext,
    });

    expect(response.errors).toBeUndefined();
    expect(faceted.map((query) => query.facets)).toEqual([
      ['associatedMedia.license'],
    ]);
    expect(response.data).toEqual({
      works: {
        facets: { associatedMedia: { license: [{ value: CC_BY, count: 2 }] } },
      },
    });
  });

  it('selects a bucket through a condition on one entry', async () => {
    const { engine, searched } = recordingEngine();

    const response = await graphql({
      schema: gqlSchema,
      source: `{ works(where: { associatedMedia: { where: { license: { in: ["${CC_BY}"] } } } }) { pagination { total } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] } as SearchContext,
    });

    expect(response.errors).toBeUndefined();
    expect(searched[0]?.where).toEqual([
      {
        or: [
          {
            field: 'associatedMedia',
            entry: [{ field: 'license', in: [CC_BY] }],
          },
        ],
      },
    ]);
  });
});
