/**
 * A lookup that reads its literals as periods (`literal: 'period'`): one field
 * holding both forms a profile allows for a property – a period stated as a
 * value, and a reference to a named one.
 */
import { describe, expect, it } from 'vitest';
import {
  missingRequiredFields,
  projectDocument,
  type UnreadableValue,
} from '../src/project.js';
import {
  defineSearchType,
  filterOperatorFor,
  physicalFields,
  searchSchema,
  validateSearchType,
  type ReferenceField,
  type SearchField,
  type SearchType,
} from '../src/schema.js';
import { validateQuery, type SearchQuery } from '../src/query.js';

const SCHEMA_ORG = 'https://schema.org/';
const ID = 'https://ex/work/1';
const PERIOD = 'https://ex/term/19th-20th-century';
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;
const seconds = (iso: string) => Date.parse(iso) / 1000;

const term = defineSearchType({
  name: 'Term',
  class: `${SCHEMA_ORG}DefinedTerm`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `${SCHEMA_ORG}name`,
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
});

const temporalCoverage: ReferenceField = {
  name: 'temporalCoverage',
  kind: 'reference',
  path: `${SCHEMA_ORG}temporalCoverage`,
  array: true,
  output: true,
  filterable: true,
  sortable: true,
  ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
};

function workType(fields: readonly SearchField[]): SearchType {
  return defineSearchType({
    name: 'Work',
    class: `${SCHEMA_ORG}CreativeWork`,
    fields,
  });
}

/** Project a work stating `values` for the field, and what it reports. */
function project(
  values: readonly unknown[],
  field: ReferenceField = temporalCoverage,
) {
  const work = workType([field]);
  const unread: UnreadableValue[] = [];
  const document = projectDocument(
    { '@id': ID, [alias('Work', field.name)]: values },
    work,
    searchSchema(work, term),
    { onUnreadable: (value) => unread.push(value) },
  );
  return { document, unread, work };
}

describe('a lookup reading its literals as periods', () => {
  it('stores its referents as a lookup does, and its literals as periods', () => {
    const { document, unread } = project([
      { '@id': PERIOD },
      { '@value': '1935/1955' },
      '1620~',
    ]);

    expect(document.temporalCoverage).toEqual([PERIOD]);
    expect(document.temporalCoverage_literal).toEqual(['1935/1955', '1620~']);
    // The stretch the periods cover between them; the referent bounds nothing.
    expect(document.temporalCoverage_start).toBe(
      seconds('1620-01-01T00:00:00Z'),
    );
    expect(document.temporalCoverage_end).toBe(seconds('1955-12-31T23:59:59Z'));
    expect(unread).toEqual([]);
  });

  it('stores a referent alone with no periods, and so no bounds', () => {
    const { document } = project([{ '@id': PERIOD }]);

    expect(document.temporalCoverage).toEqual([PERIOD]);
    expect(document.temporalCoverage_literal).toBeUndefined();
    expect(document.temporalCoverage_start).toBeUndefined();
  });

  it('reports a literal no reader can parse, instead of dropping it as no IRI', () => {
    const { document, unread } = project([
      { '@value': '19e/20e eeuw' },
      { '@id': PERIOD },
    ]);

    expect(document.temporalCoverage).toEqual([PERIOD]);
    expect(document.temporalCoverage_literal).toBeUndefined();
    expect(unread).toEqual([
      { field: 'temporalCoverage', value: '19e/20e eeuw', id: ID },
    ]);
  });

  describe('when single-valued', () => {
    const single: ReferenceField = { ...temporalCoverage, array: false };

    it('keeps a literal stated first, and not the referent behind it', () => {
      const { document } = project(
        [{ '@value': '1935/1955' }, { '@id': PERIOD }],
        single,
      );

      expect(document.temporalCoverage_literal).toBe('1935/1955');
      expect(document.temporalCoverage).toBeUndefined();
    });

    it('keeps a referent stated first, and not the literal behind it', () => {
      const { document } = project(
        [{ '@id': PERIOD }, { '@value': '1935/1955' }],
        single,
      );

      expect(document.temporalCoverage).toBe(PERIOD);
      expect(document.temporalCoverage_literal).toBeUndefined();
      expect(document.temporalCoverage_start).toBeUndefined();
    });

    it('passes over a literal no reader can parse to the value behind it', () => {
      const { document, unread } = project(
        [{ '@value': '19e eeuw' }, { '@id': PERIOD }],
        single,
      );

      expect(document.temporalCoverage).toBe(PERIOD);
      expect(unread).toEqual([
        { field: 'temporalCoverage', value: '19e eeuw', id: ID },
      ]);
    });
  });

  it('stores nothing single-valued from a blank node and an unreadable literal', () => {
    const { document, unread } = project(
      [{}, { '@value': 'onbekend' }, { '@value': 'onbekend' }],
      { ...temporalCoverage, array: false },
    );

    expect(document.temporalCoverage).toBeUndefined();
    expect(document.temporalCoverage_literal).toBeUndefined();
    // Reported once, however often it is stated.
    expect(unread).toEqual([
      { field: 'temporalCoverage', value: 'onbekend', id: ID },
    ]);
  });

  it('counts a period alone as a value of a required field', () => {
    const required: ReferenceField = {
      ...temporalCoverage,
      array: false,
      required: true,
    };
    const { document, work } = project([{ '@value': '1935' }], required);

    expect(missingRequiredFields(document, work)).toEqual([]);
  });

  it('stores its periods in a companion beside the referents’ ids', () => {
    expect(physicalFields(temporalCoverage).period).toEqual({
      values: 'temporalCoverage_literal',
      start: 'temporalCoverage_start',
      end: 'temporalCoverage_end',
    });
  });

  it('reserves the companion’s name', () => {
    const issues = validateSearchType(
      workType([
        temporalCoverage,
        { name: 'temporalCoverage_literal', kind: 'keyword', output: true },
      ]),
    );

    expect(issues).toContainEqual({
      field: 'temporalCoverage_literal',
      reason: 'reserved-field-name',
    });
  });
});

describe('filtering a lookup that reads its literals as periods', () => {
  const work = workType([temporalCoverage]);
  const schema = searchSchema(work, term);
  const query = (where: SearchQuery['where']): SearchQuery => ({
    where,
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  });

  it('takes a period’s range, never the ids its referents hold', () => {
    expect(filterOperatorFor(temporalCoverage)).toBe('range');
    expect(
      validateQuery(
        query([{ or: [{ field: 'temporalCoverage', in: [PERIOD] }] }]),
        work,
        schema,
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: 'temporalCoverage',
        reason: 'operator-mismatch',
      }),
    );
  });

  it('reads its bounds as a period’s, refusing one the codec cannot read', () => {
    expect(
      validateQuery(
        query([
          {
            or: [
              {
                field: 'temporalCoverage',
                range: { min: '1940', max: 'later' },
              },
            ],
          },
        ]),
        work,
        schema,
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: 'temporalCoverage',
        reason: 'unparseable-bound',
      }),
    );
  });
});

describe('declaring a lookup that reads its literals as periods', () => {
  const issuesOf = (field: Record<string, unknown>) =>
    validateSearchType(
      workType([{ ...temporalCoverage, ...field } as SearchField]),
    ).map((issue) => issue.reason);

  it('is valid filterable and sortable', () => {
    expect(issuesOf({})).toEqual([]);
  });

  it('refuses facetable, as a period is refused it', () => {
    expect(issuesOf({ facetable: true })).toContain('period-not-facetable');
  });

  it('refuses a literal kind it does not know', () => {
    expect(
      issuesOf({
        ref: { strategy: 'lookup', target: 'Term', literal: 'keyword' },
      }),
    ).toContain('unknown-literal-kind');
  });

  it('refuses local, whose referents are stored as objects', () => {
    expect(
      issuesOf({
        ref: {
          strategy: 'lookup',
          target: 'Term',
          literal: 'period',
          local: true,
        },
      }),
    ).toContain('literal-with-local');
  });

  it('refuses joinable, whose filter is on ids', () => {
    expect(issuesOf({ joinable: true })).toContain('literal-with-joinable');
  });

  it('refuses one nested in a Reference Type', () => {
    const coverage = defineSearchType({
      name: 'Coverage',
      fields: [{ ...temporalCoverage, filterable: false, sortable: false }],
    });
    const work = workType([
      {
        name: 'coverage',
        kind: 'reference',
        path: `${SCHEMA_ORG}spatialCoverage`,
        output: true,
        ref: { strategy: 'inline', typeName: 'Coverage' },
      },
    ]);

    expect(() => searchSchema(work, term, coverage)).toThrow(
      /reads a literal as a “period”/,
    );
  });
});
