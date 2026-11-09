/**
 * A `period` field in Typesense: its values stored unindexed, its bounds as
 * int64 companions, a range filter compiled to overlap, and a sort that reads
 * the bound its direction reaches first.
 */
import { describe, expect, it } from 'vitest';
import {
  isoToUnixSeconds,
  lastSecondOf,
  type SearchField,
  type SearchQuery,
  type SearchType,
  type StoredDate,
  searchSchema,
} from '@lde/search';
import { buildSearchParams } from '../src/query-compiler.js';
import { parseSearchResponse } from '../src/search.js';
import { buildCollectionDefinition } from '../src/collection-definition.js';

const work: SearchType = {
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
    { name: 'genre', kind: 'keyword', filterable: true },
  ] satisfies SearchField[],
};

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

function filterBy(range: { min?: string; max?: string }): string | undefined {
  return buildSearchParams(
    { ...base, where: [{ or: [{ field: 'dateCreated', range }] }] },
    work,
  ).filter_by;
}

describe('a range filter on a period', () => {
  it('matches every period that overlaps the range', () => {
    expect(filterBy({ min: '1940', max: '1950' })).toBe(
      `(dateCreated_start:<=${last('1950')} && dateCreated_end:>=${first('1940')})`,
    );
  });

  it('compares one bound when the range states one', () => {
    expect(filterBy({ min: '1940' })).toBe(
      `dateCreated_end:>=${first('1940')}`,
    );
    expect(filterBy({ max: '1950-06' })).toBe(
      `dateCreated_start:<=${last('1950-06')}`,
    );
  });

  it('states no constraint without a usable bound', () => {
    expect(filterBy({})).toBeUndefined();
  });

  it('keeps the overlap whole beside another criterion in an or', () => {
    expect(
      buildSearchParams(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'dateCreated', range: { min: '1940', max: '1950' } },
                { field: 'genre', in: ['portret'] },
              ],
            },
          ],
        },
        work,
      ).filter_by,
    ).toBe(
      `((dateCreated_start:<=${last('1950')} && dateCreated_end:>=${first('1940')}) || genre:=[\`portret\`])`,
    );
  });
});

describe('sorting on a period', () => {
  it('orders ascending on where a period starts, descending on where it ends', () => {
    const sortBy = (direction: 'asc' | 'desc') =>
      buildSearchParams(
        { ...base, orderBy: [{ field: 'dateCreated', direction }] },
        work,
      ).sort_by;
    expect(sortBy('asc')).toBe('dateCreated_start:asc');
    expect(sortBy('desc')).toBe('dateCreated_end:desc');
  });
});

describe('the collection a period is stored in', () => {
  it('stores the values unindexed and indexes the bounds for sorting', () => {
    const fields = buildCollectionDefinition(work).fields ?? [];
    const named = (name: string) => fields.find((field) => field.name === name);
    expect(named('dateCreated')).toMatchObject({
      type: 'string[]',
      index: false,
      optional: true,
    });
    expect(named('dateCreated_start')).toMatchObject({
      type: 'int64',
      sort: true,
      optional: true,
    });
    expect(named('dateCreated_end')).toMatchObject({
      type: 'int64',
      sort: true,
      optional: true,
    });
  });

  it('declares bounds for a period served for display alone too', () => {
    // A deployment may sort on a field it does not expose as sortable.
    const fields = buildCollectionDefinition(work).fields ?? [];
    expect(
      fields.find((field) => field.name === 'temporalCoverage'),
    ).toMatchObject({ type: 'string', index: false });
    expect(
      fields
        .filter((field) => field.name.startsWith('temporalCoverage_'))
        .map((field) => field.name),
    ).toEqual(['temporalCoverage_start', 'temporalCoverage_end']);
  });
});

describe('sorting on a period nothing declares sortable', () => {
  it('still sorts on its bounds', () => {
    expect(
      buildSearchParams(
        {
          ...base,
          orderBy: [{ field: 'temporalCoverage', direction: 'desc' }],
        },
        work,
      ).sort_by,
    ).toBe('temporalCoverage_end:desc');
  });
});

describe('a period read back from a hit', () => {
  it('is the values as stored, without the bounds', () => {
    const { hits } = parseSearchResponse(
      {
        found: 2,
        hits: [
          {
            document: {
              id: 'https://ex/work/1',
              dateCreated: ['1935/1955', '1620~'],
              dateCreated_start: 0,
              dateCreated_end: 1,
              temporalCoverage: '16XX',
            },
          },
          // A stored value of the wrong shape is no value.
          { document: { id: 'https://ex/work/2', temporalCoverage: 1620 } },
        ],
      } as never,
      work,
      new Map(),
      searchSchema(work),
    );
    expect(hits[0].document).toEqual({
      dateCreated: ['1935/1955', '1620~'],
      temporalCoverage: '16XX',
    });
    expect(hits[1].document).not.toHaveProperty('temporalCoverage');
  });
});
