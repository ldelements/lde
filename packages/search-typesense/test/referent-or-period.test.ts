/**
 * A lookup reading its literals as periods, in Typesense: its referents stored
 * as any lookup’s, its periods in an unindexed companion with int64 bounds
 * beside them, a range filter compiled to overlap on those bounds, and each
 * hit served as one list of periods and resolved referents.
 */
import { describe, expect, it } from 'vitest';
import {
  isoToUnixSeconds,
  lastSecondOf,
  searchSchema,
  type SearchQuery,
  type SearchType,
  type StoredDate,
} from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { buildSearchParams } from '../src/query-compiler.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { fakeTypesenseClient, filterByIds } from './fake-typesense-client.js';

const term: SearchType = {
  name: 'Term',
  class: 'https://schema.org/DefinedTerm',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    {
      name: 'temporalCoverage',
      kind: 'reference',
      output: true,
      array: true,
      ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
    },
  ],
};

const work: SearchType = {
  name: 'Work',
  class: 'https://schema.org/CreativeWork',
  fields: [
    {
      name: 'temporalCoverage',
      kind: 'reference',
      path: 'https://schema.org/temporalCoverage',
      array: true,
      required: true,
      output: true,
      filterable: true,
      sortable: true,
      ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
    },
    {
      name: 'about',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
    },
  ],
};

const schema = searchSchema(work, term);

const base: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 20,
  offset: 0,
  facets: [],
  locale: 'nl',
};

const first = (iso: string) => (isoToUnixSeconds(iso) as StoredDate).seconds;
const last = (iso: string) => lastSecondOf(isoToUnixSeconds(iso) as StoredDate);

const PERIOD = 'https://ex/term/19th-20th-century';

describe('the collection of a lookup reading its literals as periods', () => {
  const fields = buildCollectionDefinition(work, { schema }).fields ?? [];
  const named = (name: string) => fields.find((field) => field.name === name);

  it('declares the referents’ ids as a lookup’s, optional however required', () => {
    expect(named('temporalCoverage')).toMatchObject({
      type: 'string[]',
      optional: true,
    });
  });

  it('declares the periods stored but unindexed, and their bounds as int64', () => {
    expect(named('temporalCoverage_literal')).toEqual({
      name: 'temporalCoverage_literal',
      type: 'string[]',
      index: false,
      optional: true,
    });
    for (const bound of ['temporalCoverage_start', 'temporalCoverage_end']) {
      expect(named(bound)).toEqual({
        name: bound,
        type: 'int64',
        sort: true,
        optional: true,
      });
    }
  });
});

describe('querying a lookup reading its literals as periods', () => {
  it('filters a range by overlap with the periods', () => {
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                {
                  field: 'temporalCoverage',
                  range: { min: '1940', max: '1950' },
                },
              ],
            },
          ],
        },
        work,
        { schema },
      ).filter_by,
    ).toBe(
      `(temporalCoverage_start:<=${last('1950')} && temporalCoverage_end:>=${first('1940')})`,
    );
  });

  it('matches nothing for a membership filter, which its referents do not take', () => {
    // `validateQuery` refuses one first; this is the guard for a hand-built
    // query.
    expect(
      buildSearchParams(
        {
          ...base,
          where: [{ or: [{ field: 'temporalCoverage', in: [PERIOD] }] }],
        },
        work,
        { schema },
      ).filter_by,
    ).toBe('id:=[]');
  });

  it('sorts on the bound its direction reaches first', () => {
    expect(
      buildSearchParams(
        {
          ...base,
          orderBy: [{ field: 'temporalCoverage', direction: 'desc' }],
        },
        work,
        { schema },
      ).sort_by,
    ).toMatch(/^temporalCoverage_end:desc/);
  });
});

describe('a hit of a lookup reading its literals as periods', () => {
  const documents: Record<string, Record<string, unknown>> = {
    [PERIOD]: {
      id: PERIOD,
      label_nl: '19e/20e eeuw',
      temporalCoverage_literal: ['1801/2000'],
    },
  };

  function engine() {
    const lookups: Record<string, unknown>[] = [];
    const fake = fakeTypesenseClient({
      multiSearch: (search) => {
        if (search.include_fields === undefined) {
          return {
            found: 2,
            hits: [
              {
                document: {
                  id: 'https://ex/work/1',
                  temporalCoverage: [PERIOD],
                  temporalCoverage_literal: ['1935/1955', '1620~'],
                  about: PERIOD,
                },
              },
              {
                document: {
                  id: 'https://ex/work/2',
                  temporalCoverage_literal: ['16XX'],
                  about_literal: '1620~',
                },
              },
            ],
          };
        }
        lookups.push(search);
        const include = new Set(String(search.include_fields).split(','));
        const found = filterByIds(String(search.filter_by))
          .filter((id) => documents[id] !== undefined)
          .map((id) => ({
            document: Object.fromEntries(
              Object.entries(documents[id]).filter(([key]) => include.has(key)),
            ),
          }));
        return { found: found.length, hits: found };
      },
    });
    return {
      lookups,
      engine: createTypesenseSearchEngine(fake.client, schema, {
        collections: { Work: 'works', Term: 'terms' },
      }),
    };
  }

  it('serves the periods beside the resolved referents, as one list', async () => {
    const { engine: search, lookups } = engine();

    const result = await search.search(work as never, {
      ...base,
      resolve: {
        temporalCoverage: { fields: ['label', 'temporalCoverage'] },
        about: { fields: [] },
      },
    });

    expect(result.hits.map((hit) => hit.document)).toEqual([
      {
        temporalCoverage: [
          '1935/1955',
          '1620~',
          {
            id: PERIOD,
            label: { nl: ['19e/20e eeuw'] },
            // A referent’s own such field is fetched and served alike.
            temporalCoverage: ['1801/2000'],
          },
        ],
        about: { id: PERIOD },
      },
      { temporalCoverage: ['16XX'], about: '1620~' },
    ]);
    expect(String(lookups[0].include_fields).split(',').sort()).toEqual([
      'id',
      'label_nl',
      'temporalCoverage',
      'temporalCoverage_literal',
    ]);
  });
});
