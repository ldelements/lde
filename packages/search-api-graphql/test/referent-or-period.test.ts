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
 * A lookup reading its literals as periods on the GraphQL surface: one list of
 * entries, each a period or a reference, filtered by the periods alone.
 */
const term = {
  name: 'Term',
  class: 'https://schema.org/DefinedTerm',
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: 'https://schema.org/name',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
} as const satisfies SearchType;

const work = {
  name: 'Work',
  class: 'https://schema.org/CreativeWork',
  fields: [
    {
      name: 'temporalCoverage',
      kind: 'reference',
      path: 'https://schema.org/temporalCoverage',
      array: true,
      output: true,
      filterable: true,
      sortable: true,
      ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
    },
    {
      name: 'about',
      kind: 'reference',
      path: 'https://schema.org/about',
      output: true,
      ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
    },
  ],
} as const satisfies SearchType;

const schema = searchSchema(work, term);

const PERIOD = 'https://ex/term/19th-20th-century';

describe('a lookup reading its literals as periods', () => {
  const sdl = printSchema(buildGraphQLSchema(schema));

  it('is served as entries that are a period or a reference', () => {
    expect(sdl).toMatch(
      /type TermOrPeriod \{[^}]*value: EDTF\n[^}]*reference: TermReference\n/s,
    );
    expect(sdl).toMatch(/temporalCoverage: \[TermOrPeriod!\]!/);
    // Shared by every such field naming the target.
    expect(sdl).toMatch(/about: TermOrPeriod\n/);
  });

  it('refuses a declared type that takes the entry type’s name', () => {
    const termOrPeriod = {
      name: 'TermOrPeriod',
      class: 'https://ex/TermOrPeriod',
      fields: [{ name: 'note', kind: 'keyword', output: true }],
    } as const satisfies SearchType;

    expect(() =>
      buildGraphQLSchema(searchSchema(termOrPeriod, work, term)),
    ).toThrow(/would be served as “TermOrPeriod”/);
  });

  it('is filtered by a DateRange and sorted under its own name', () => {
    expect(sdl).toMatch(/input WorkWhere \{[^}]*temporalCoverage: DateRange/s);
    expect(sdl).toMatch(/enum WorkSortField \{[^}]*TEMPORAL_COVERAGE/s);
  });

  it('serves each entry in its own form, and resolves what is selected of a referent', async () => {
    let received: SearchQuery | undefined;
    const result: SearchResult = {
      total: 1,
      hits: [
        {
          id: 'https://ex/work/1',
          document: {
            temporalCoverage: [
              '1935/1955',
              { id: PERIOD, label: { nl: ['19e/20e eeuw'] } },
            ],
            about: { id: PERIOD },
          },
        },
        { id: 'https://ex/work/2', document: { about: '1620~' } },
      ],
      facets: {},
    };
    const response = await graphql({
      schema: buildGraphQLSchema(schema),
      source: `{
        works(where: { temporalCoverage: { min: "1940", max: "1950" } }) {
          items {
            temporalCoverage { value reference { id label { value } } }
            about { value reference { id } }
          }
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
          {
            temporalCoverage: [
              { value: '1935/1955', reference: null },
              {
                value: null,
                reference: { id: PERIOD, label: [{ value: '19e/20e eeuw' }] },
              },
            ],
            about: { value: null, reference: { id: PERIOD } },
          },
          {
            temporalCoverage: [],
            about: { value: '1620~', reference: null },
          },
        ],
      },
    });
    expect(received?.where).toEqual([
      {
        or: [
          { field: 'temporalCoverage', range: { min: '1940', max: '1950' } },
        ],
      },
    ]);
    // What is selected under `reference` is what the engine resolves.
    expect(received?.resolve).toEqual({
      temporalCoverage: { fields: ['label'] },
      about: { fields: [] },
    });
  });
});
