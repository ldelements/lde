/**
 * A `period` field: values stored as stated, and the stretch they cover stored
 * as two bounds a filter and a sort read.
 */
import { describe, expect, it } from 'vitest';
import { projectDocument } from '../src/project.js';
import {
  physicalFields,
  searchSchema,
  validateSearchType,
  type SearchField,
  type SearchType,
} from '../src/schema.js';
import { OPEN_END, OPEN_START } from '../src/period.js';
import { validateQuery, type SearchQuery } from '../src/query.js';

const WORK = 'https://schema.org/CreativeWork';
const key = (field: string) => `urn:lde:Work/${field}`;
const seconds = (iso: string) => Date.parse(iso) / 1000;

function workType(fields: readonly SearchField[]): SearchType {
  return { name: 'Work', class: WORK, fields };
}

const dateCreated: SearchField = {
  name: 'dateCreated',
  kind: 'period',
  path: 'https://schema.org/dateCreated',
  output: true,
  filterable: true,
  sortable: true,
};

/** Project one value of `dateCreated`, as the extraction emits it. */
function project(value: string, field: SearchField = dateCreated) {
  return projectDocument(
    {
      '@id': 'https://ex/work/1',
      [key(field.name)]: { '@value': value },
    },
    workType([field]),
  );
}

describe('the stretch a period value covers', () => {
  it.each([
    ['1935', '1935-01-01T00:00:00Z', '1935-12-31T23:59:59Z'],
    ['1935/1955', '1935-01-01T00:00:00Z', '1955-12-31T23:59:59Z'],
    ['1606-07-15/1607', '1606-07-15T00:00:00Z', '1607-12-31T23:59:59Z'],
    ['1620~', '1620-01-01T00:00:00Z', '1620-12-31T23:59:59Z'],
    ['1620?', '1620-01-01T00:00:00Z', '1620-12-31T23:59:59Z'],
    ['1935~/1955', '1935-01-01T00:00:00Z', '1955-12-31T23:59:59Z'],
    ['162X', '1620-01-01T00:00:00Z', '1629-12-31T23:59:59Z'],
    ['16XX', '1600-01-01T00:00:00Z', '1699-12-31T23:59:59Z'],
    ['1889-06-15', '1889-06-15T00:00:00Z', '1889-06-15T23:59:59Z'],
    // A date-time is just that second, normalised to UTC as a `date` is.
    [
      '1999-05-03T14:30:00+02:00',
      '1999-05-03T12:30:00Z',
      '1999-05-03T12:30:00Z',
    ],
  ])('%s covers %s to %s', (value, start, end) => {
    const document = project(value);
    expect(document.dateCreated).toBe(value);
    expect(document.dateCreated_start).toBe(seconds(start));
    expect(document.dateCreated_end).toBe(seconds(end));
  });

  it('reads BCE years and deep time through the date codec', () => {
    const bce = project('-0430/-0403');
    expect(bce.dateCreated_start).toBeLessThan(bce.dateCreated_end as number);
    expect(bce.dateCreated_start).toBe(
      projectDocument(
        {
          '@id': 'https://ex/work/2',
          [key('dateCreated')]: { '@value': '-0430' },
        },
        workType([dateCreated]),
      ).dateCreated_start,
    );
    // edtf.js holds dates in `Date`, which a Carboniferous year is beyond.
    for (const value of [
      '-318000000',
      'Y-318000000',
      '-318000000/-300000000',
      'Y-318000000/Y-300000000',
      'Y-318000000/1650~',
    ]) {
      const deep = project(value);
      expect(deep.dateCreated).toBe(value);
      // Earlier than the earliest second `Date` holds: 8.64e15 ms before 1970.
      expect(deep.dateCreated_start).toBeLessThan(-8.64e12);
      expect(deep.dateCreated_end).toBeGreaterThan(
        deep.dateCreated_start as number,
      );
    }
  });

  it('reads a season as part of its year', () => {
    // Which months a season spans is edtf.js’s reading; that it stays inside
    // its year is what a filter on the year depends on.
    const document = project('1606-21');
    expect(document.dateCreated_start).toBeGreaterThanOrEqual(
      seconds('1606-01-01T00:00:00Z'),
    );
    expect(document.dateCreated_end).toBeLessThanOrEqual(
      seconds('1606-12-31T23:59:59Z'),
    );
    expect(document.dateCreated_start).toBeLessThan(
      document.dateCreated_end as number,
    );
  });

  it('stores an open or unknown bound as unbounded', () => {
    for (const value of ['1440/..', '1440/']) {
      const document = project(value);
      expect(document.dateCreated_start).toBe(seconds('1440-01-01T00:00:00Z'));
      expect(document.dateCreated_end).toBe(OPEN_END);
    }
    // Deep time on the other side too: edtf.js cannot read the interval
    // whole, so each side is read on its own.
    for (const value of ['-318000000/..', 'Y-318000000/']) {
      const document = project(value);
      expect(document.dateCreated_start).toBeLessThan(-8.64e12);
      expect(document.dateCreated_end).toBe(OPEN_END);
    }
    expect(project('../Y-318000000').dateCreated_start).toBe(OPEN_START);
    for (const value of ['../1607', '/1607']) {
      const document = project(value);
      expect(document.dateCreated_start).toBe(OPEN_START);
      expect(document.dateCreated_end).toBe(seconds('1607-12-31T23:59:59Z'));
    }
  });

  it('serves a value that states no period, but bounds nothing with it', () => {
    for (const value of [
      'ca. 1620',
      'onbekend',
      // EDTF Level 2, which this kind does not read: `1950S2` is some year of
      // 1900–1999, and a reader that took it for 1950 would bound it wrong.
      '1950S2',
      '[1667,1668]',
      '1955/1935',
      '1606/1607/1608',
      '../..',
      // A `Y` year is a year alone.
      'Y2020-05-01',
    ]) {
      const document = project(value);
      expect(document.dateCreated, value).toBe(value);
      expect(document, value).not.toHaveProperty('dateCreated_start');
      expect(document, value).not.toHaveProperty('dateCreated_end');
    }
  });
});

describe('a multi-valued period', () => {
  it('serves every value and covers them all between them', () => {
    const field = { ...dateCreated, array: true };
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [key('dateCreated')]: [
          { '@value': '1676' },
          { '@value': 'onbekend' },
          { '@value': '1686' },
          { '@value': '1668' },
        ],
      },
      workType([field]),
    );
    expect(document.dateCreated).toEqual(['1676', 'onbekend', '1686', '1668']);
    expect(document.dateCreated_start).toBe(seconds('1668-01-01T00:00:00Z'));
    expect(document.dateCreated_end).toBe(seconds('1686-12-31T23:59:59Z'));
  });
});

describe('a derived period', () => {
  it('stores what the derive returns as a read value is stored', () => {
    const document = projectDocument(
      { '@id': 'https://ex/work/1' },
      workType([
        { ...dateCreated, path: undefined, derive: () => '1935/1955' },
        {
          name: 'temporalCoverage',
          kind: 'period',
          array: true,
          output: true,
          filterable: true,
          derive: () => ['1600/1700', 42, '1650'],
        },
        { name: 'none', kind: 'period', output: true, derive: () => undefined },
      ]),
    );
    expect(document.dateCreated).toBe('1935/1955');
    expect(document.dateCreated_end).toBe(seconds('1955-12-31T23:59:59Z'));
    expect(document.temporalCoverage).toEqual(['1600/1700', '1650']);
    expect(document.temporalCoverage_start).toBe(
      seconds('1600-01-01T00:00:00Z'),
    );
    expect(document).not.toHaveProperty('none');
  });
});

describe('a single-valued period', () => {
  it('keeps its first value, and is bounded by that value alone', () => {
    const document = projectDocument(
      { '@id': 'https://ex/work/1' },
      workType([
        { ...dateCreated, path: undefined, derive: () => ['1620', '1700'] },
      ]),
    );
    expect(document.dateCreated).toBe('1620');
    expect(document.dateCreated_end).toBe(seconds('1620-12-31T23:59:59Z'));
  });

  it('skips a blank value rather than losing the one behind it', () => {
    const document = projectDocument(
      {
        '@id': 'https://ex/work/1',
        [key('dateCreated')]: [{ '@value': '  ' }, { '@value': '1935/1955' }],
      },
      workType([dateCreated]),
    );
    expect(document.dateCreated).toBe('1935/1955');
    expect(document.dateCreated_start).toBe(seconds('1935-01-01T00:00:00Z'));
  });
});

describe('the bound companions', () => {
  it('are stored for every period, whatever it declares', () => {
    // A deployment may sort on a field it does not expose as sortable.
    const outputOnly: SearchField = {
      ...dateCreated,
      filterable: false,
      sortable: false,
    };
    expect(physicalFields(outputOnly).period).toEqual({
      start: 'dateCreated_start',
      end: 'dateCreated_end',
    });
    const document = project('1935/1955', outputOnly);
    expect(document.dateCreated).toBe('1935/1955');
    expect(document.dateCreated_start).toBe(seconds('1935-01-01T00:00:00Z'));
  });

  it('may not be shadowed by a declared field', () => {
    const issues = validateSearchType(
      workType([
        dateCreated,
        { name: 'dateCreated_end', kind: 'keyword', path: 'https://ex/end' },
      ]),
    );
    expect(issues).toContainEqual({
      field: 'dateCreated_end',
      reason: 'reserved-field-name',
    });
  });
});

describe('declaring a period', () => {
  it('refuses a facet, which no engine counts from two bounds', () => {
    const issues = validateSearchType(
      workType([
        { ...dateCreated, facetable: true } as unknown as SearchField,
        {
          ...dateCreated,
          name: 'binned',
          facetRanges: [{ key: 'old', max: '1800' }],
        } as unknown as SearchField,
      ]),
    );
    expect(issues).toContainEqual({
      field: 'dateCreated',
      reason: 'period-not-facetable',
    });
    expect(issues).toContainEqual({
      field: 'binned',
      reason: 'facet-ranges-not-allowed',
    });
  });

  it('refuses a filterable period nested in a Reference Type', () => {
    const declare = (filterable: boolean) =>
      searchSchema(
        workType([
          {
            name: 'production',
            kind: 'reference',
            path: 'https://ex/production',
            array: true,
            output: true,
            ref: { strategy: 'inline', typeName: 'Production' },
          },
        ]),
        {
          name: 'Production',
          fields: [
            {
              name: 'period',
              kind: 'period',
              path: 'https://ex/period',
              output: true,
              filterable,
            },
          ],
        },
      );
    expect(() => declare(true)).toThrow(/filterable “period”/);
    expect(() => declare(false)).not.toThrow();
  });
});

describe('filtering a period', () => {
  const person: SearchType = {
    name: 'Person',
    class: 'https://schema.org/Person',
    fields: [
      {
        name: 'label',
        kind: 'text',
        path: 'https://schema.org/name',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
      {
        name: 'birthDate',
        kind: 'period',
        path: 'https://schema.org/birthDate',
        output: true,
        filterable: true,
      },
    ],
  };
  const work = workType([
    dateCreated,
    {
      name: 'creator',
      kind: 'reference',
      path: 'https://schema.org/creator',
      array: true,
      output: true,
      filterable: true,
      ref: { strategy: 'lookup', target: 'Person', local: true },
    },
  ]);
  const schema = searchSchema(work, person);
  const query = (where: SearchQuery['where']): SearchQuery => ({
    where,
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  });
  const range = { min: '1600', max: '1700' };

  it('accepts a range on the document that holds the period', () => {
    expect(
      validateQuery(
        query([{ or: [{ field: 'dateCreated', range }] }]),
        work,
        schema,
      ),
    ).toEqual([]);
    expect(
      validateQuery(
        query([{ or: [{ field: 'birthDate', range }] }]),
        person,
        schema,
      ),
    ).toEqual([]);
  });

  it('cannot reach a period inside a nested entry', () => {
    // A period is compared on the document that holds it. No route reaches
    // one inside an entry: a `local` lookup is neither walked nor welded, and
    // a Reference Type refuses a filterable period when the schema is built.
    const reasons = (where: SearchQuery['where']) =>
      validateQuery(query(where), work, schema).map((issue) => issue.reason);
    expect(
      reasons([{ or: [{ field: 'birthDate', on: ['creator'], range }] }]),
    ).toEqual(['unknown-join']);
    expect(
      reasons([
        {
          or: [{ field: 'creator', entry: [{ field: 'birthDate', range }] }],
        },
      ]),
    ).toEqual(['not-weldable']);
  });

  it('reads a bound as a date bound', () => {
    expect(
      validateQuery(
        query([
          { or: [{ field: 'dateCreated', range: { min: '1935/1955' } }] },
        ]),
        work,
        schema,
      ),
    ).toContainEqual(
      expect.objectContaining({
        reason: 'unparseable-bound',
        value: '1935/1955',
      }),
    );
  });
});
