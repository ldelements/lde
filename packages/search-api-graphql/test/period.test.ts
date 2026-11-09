import { describe, expect, it } from 'vitest';
import { graphql, printSchema } from 'graphql';
import {
  searchSchema,
  type SearchQuery,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema } from '../src/build-schema.js';

/**
 * A `period` field on the GraphQL surface: served as stated, under the name it
 * is filtered and sorted by.
 */
const work = {
  name: 'Work',
  class: 'https://schema.org/CreativeWork',
  fields: [
    {
      name: 'dateCreated',
      kind: 'period',
      path: 'https://schema.org/dateCreated',
      array: true,
      output: true,
      filterable: true,
      sortable: true,
    },
    {
      name: 'temporalCoverage',
      kind: 'period',
      path: 'https://schema.org/temporalCoverage',
      output: true,
    },
  ],
} as const satisfies SearchType;

const schema = searchSchema(work);

describe('a period field', () => {
  const sdl = printSchema(buildGraphQLSchema(schema));

  it('is served as EDTF, a list for an array field', () => {
    expect(sdl).toMatch(
      /scalar EDTF @specifiedBy\(url: "https:\/\/www\.loc\.gov\/standards\/datetime\/"\)/,
    );
    expect(sdl).toMatch(/dateCreated: \[EDTF!\]!/);
    expect(sdl).toMatch(/temporalCoverage: EDTF\n/);
  });

  it('is filtered by a DateRange and sorted under its own name', () => {
    expect(sdl).toMatch(/input WorkWhere \{[^}]*dateCreated: DateRange/s);
    expect(sdl).toMatch(/enum WorkSortField \{[^}]*DATE_CREATED/s);
  });

  it('passes the values through and the range to the engine', async () => {
    let received: SearchQuery | undefined;
    const result: SearchResult = {
      total: 1,
      hits: [
        {
          id: 'https://ex/work/1',
          document: {
            dateCreated: ['1935/1955', '1620~'],
            temporalCoverage: '16XX',
          },
        },
        // A work its source left undated.
        { id: 'https://ex/work/2', document: {} },
      ],
      facets: {},
    };
    const response = await graphql({
      schema: buildGraphQLSchema(schema),
      source: `{
        works(where: { dateCreated: { min: "1940", max: "1950" } }) {
          items { dateCreated temporalCoverage }
        }
      }`,
      contextValue: {
        engine: {
          schema,
          async search(_type: SearchType, query: SearchQuery) {
            received = query;
            return result;
          },
          async searchFacets(
            _type: SearchType,
            queries: readonly SearchQuery[],
          ) {
            return queries.map(() => ({ facets: {} }));
          },
        },
        acceptLanguage: ['nl'],
      },
    });
    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({
      works: {
        items: [
          { dateCreated: ['1935/1955', '1620~'], temporalCoverage: '16XX' },
          { dateCreated: [], temporalCoverage: null },
        ],
      },
    });
    expect(received?.where).toEqual([
      { or: [{ field: 'dateCreated', range: { min: '1940', max: '1950' } }] },
    ]);
  });

  it('refuses a bound that is a period rather than a date', async () => {
    const response = await graphql({
      schema: buildGraphQLSchema(schema),
      source: `{ works(where: { dateCreated: { min: "1935/1955" } }) { items { dateCreated } } }`,
      contextValue: { acceptLanguage: ['nl'] },
    });
    expect(response.errors?.[0]?.message).toMatch(
      /ISO8601Date cannot represent/,
    );
  });
});
