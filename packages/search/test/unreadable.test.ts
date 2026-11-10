/**
 * What a typed field could not read, reported through
 * `ProjectionContext.onUnreadable` so a run can say what the index lost.
 */
import { describe, expect, it } from 'vitest';
import { projectDocument, type UnreadableValue } from '../src/project.js';
import {
  defineSearchType,
  searchSchema,
  type SearchField,
  type SearchType,
} from '../src/schema.js';

const WORK = 'https://schema.org/CreativeWork';
const ID = 'https://ex/work/1';
const alias = (type: string, field: string) => `urn:lde:${type}/${field}`;

function workType(fields: readonly SearchField[]): SearchType {
  return { name: 'Work', class: WORK, fields };
}

/** Project one node of `type` and collect what it reports. */
function unreadOf(
  node: Record<string, unknown>,
  type: SearchType,
  schema?: Parameters<typeof projectDocument>[2],
): UnreadableValue[] {
  const unread: UnreadableValue[] = [];
  projectDocument({ '@id': ID, ...node }, type, schema, {
    onUnreadable: (value) => unread.push(value),
  });
  return unread;
}

describe('a value a typed field reads from the graph', () => {
  it.each<[SearchField['kind'], string]>([
    ['integer', 'onbekend'],
    ['number', 'veel'],
    ['date', 'Z.j'],
    ['period', '1987/1897'],
    ['boolean', 'ja'],
    // `Number()` reads these; no XSD numeric type does, and an engine cannot
    // store infinity.
    ['integer', '0x1F'],
    ['number', 'Infinity'],
    ['number', 'INF'],
  ])('is reported when a %s field cannot read it', (kind, value) => {
    const field = {
      name: 'value',
      kind,
      path: 'https://ex/value',
      output: true,
    } as SearchField;
    expect(
      unreadOf(
        { [alias('Work', 'value')]: { '@value': value } },
        workType([field]),
      ),
    ).toEqual([{ field: 'value', value, id: ID }]);
  });

  it.each<[SearchField['kind'], string]>([
    ['integer', '1234'],
    ['number', '12.5'],
    ['date', '1935-05-01'],
    ['period', '1935/1955'],
    ['boolean', 'false'],
    ['boolean', '0'],
    ['keyword', 'anything at all'],
  ])('is not reported when a %s field reads it', (kind, value) => {
    const field = {
      name: 'value',
      kind,
      path: 'https://ex/value',
      output: true,
    } as SearchField;
    expect(
      unreadOf(
        { [alias('Work', 'value')]: { '@value': value } },
        workType([field]),
      ),
    ).toEqual([]);
  });

  it.each<SearchField['kind']>(['date', 'integer', 'number', 'boolean'])(
    'is neither stored nor reported by a %s field when it is blank',
    (kind) => {
      const field = {
        name: 'value',
        kind,
        path: 'https://ex/value',
        output: true,
      } as SearchField;
      const node = { [alias('Work', 'value')]: { '@value': '  ' } };
      expect(unreadOf(node, workType([field]))).toEqual([]);
      // `Number('  ')` is 0, which is not what the source said.
      expect(
        projectDocument({ '@id': ID, ...node }, workType([field])),
      ).toEqual({ id: ID });
    },
  );

  it('is reported for each value of an array period that states no period', () => {
    const field: SearchField = {
      name: 'temporalCoverage',
      kind: 'period',
      array: true,
      path: 'https://schema.org/temporalCoverage',
      output: true,
    };
    expect(
      unreadOf(
        {
          [alias('Work', 'temporalCoverage')]: [
            { '@value': '1935' },
            { '@value': 'Z.j' },
            { '@value': '[Begin 20e eeuw]' },
          ],
        },
        workType([field]),
      ),
    ).toEqual([
      { field: 'temporalCoverage', value: 'Z.j', id: ID },
      { field: 'temporalCoverage', value: '[Begin 20e eeuw]', id: ID },
    ]);
  });

  it('is reported when a reference reaches a literal, but not a blank node', () => {
    const field: SearchField = {
      name: 'creator',
      kind: 'reference',
      array: true,
      path: 'https://schema.org/creator',
      output: true,
    };
    expect(
      unreadOf(
        {
          [alias('Work', 'creator')]: [
            { '@id': 'https://ex/person/1' },
            { '@value': 'Jan Jansen' },
            { '@value': ' ' },
            {},
          ],
        },
        workType([field]),
      ),
    ).toEqual([{ field: 'creator', value: 'Jan Jansen', id: ID }]);
  });

  it('is reported under a dotted name for a field of a nested referent', () => {
    const person = defineSearchType({
      name: 'Person',
      fields: [
        {
          name: 'birthDate',
          kind: 'date',
          path: 'https://schema.org/birthDate',
          output: true,
        },
      ],
    });
    const work = defineSearchType({
      name: 'Work',
      class: WORK,
      fields: [
        {
          name: 'creator',
          kind: 'reference',
          path: 'https://schema.org/creator',
          output: true,
          ref: { typeName: 'Person', strategy: 'inline' },
        },
      ],
    });
    expect(
      unreadOf(
        {
          [alias('Work', 'creator')]: {
            '@id': 'https://ex/person/1',
            [alias('Person', 'birthDate')]: { '@value': 'onbekend' },
          },
        },
        work,
        searchSchema(work, person),
      ),
    ).toEqual([{ field: 'creator.birthDate', value: 'onbekend', id: ID }]);
  });
});

describe('a value a derive returns', () => {
  it.each<[SearchField['kind'], unknown, string]>([
    ['date', 'Z.j', 'Z.j'],
    ['date', Number.NaN, 'NaN'],
    ['period', 'onbekend', 'onbekend'],
    ['period', 42, '42'],
    ['reference', 'not an IRI', 'not an IRI'],
    ['integer', Number.NaN, 'NaN'],
    ['number', Number.NaN, 'NaN'],
    ['integer', 'abc', 'abc'],
    ['number', Number.POSITIVE_INFINITY, 'Infinity'],
    ['boolean', 'ja', 'ja'],
    ['boolean', 1, '1'],
    ['date', true, 'true'],
  ])('is reported when a %s field cannot read %s', (kind, derived, value) => {
    const field = {
      name: 'value',
      kind,
      output: true,
      derive: () => derived,
    } as SearchField;
    expect(unreadOf({}, workType([field]))).toEqual([
      { field: 'value', value, id: ID },
    ]);
  });

  it.each<[SearchField['kind'], unknown, unknown]>([
    ['integer', 12.7, 12],
    ['integer', ' 12 ', 12],
    ['number', '1.5e3', 1500],
    ['boolean', true, true],
    ['boolean', '0', false],
    ['reference', 'https://ex/a', 'https://ex/a'],
    ['reference', ['https://ex/a', 'not an IRI'], ['https://ex/a']],
    ['integer', [1, 'x', 3], [1, 3]],
  ])(
    'is stored as the read route stores it: %s %j',
    (kind, derived, stored) => {
      const field = {
        name: 'value',
        kind,
        output: true,
        derive: () => derived,
      } as SearchField;
      expect(projectDocument({ '@id': ID }, workType([field])).value).toEqual(
        stored,
      );
    },
  );

  it('stores a date from its first readable value, as one instant', () => {
    const field: SearchField = {
      name: 'value',
      kind: 'date',
      output: true,
      derive: () => ['Z.j', '1935-05-01', '1940-01-01'],
    };
    const unread: UnreadableValue[] = [];
    const document = projectDocument(
      { '@id': ID },
      workType([field]),
      undefined,
      {
        onUnreadable: (value) => unread.push(value),
      },
    );
    expect(document.value).toBe(Date.parse('1935-05-01T00:00:00Z') / 1000);
    expect(unread).toEqual([{ field: 'value', value: 'Z.j', id: ID }]);
  });

  it('is not reported when the derive returns nothing', () => {
    const field: SearchField = {
      name: 'value',
      kind: 'date',
      output: true,
      derive: () => undefined,
    };
    expect(unreadOf({}, workType([field]))).toEqual([]);
  });
});

describe('a boolean field', () => {
  const field: SearchField = {
    name: 'open',
    kind: 'boolean',
    path: 'https://ex/open',
    output: true,
  };
  const project = (value: string) =>
    projectDocument(
      { '@id': ID, [alias('Work', 'open')]: { '@value': value } },
      workType([field]),
    );

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('stores %s as %s', (value, stored) => {
    expect(project(value).open).toBe(stored);
  });

  it('collapses surrounding whitespace, as xsd:boolean does', () => {
    expect(project(' true\n').open).toBe(true);
  });

  it('leaves out a value outside the xsd:boolean lexical space instead of storing false', () => {
    expect(project('ja')).toEqual({ id: ID });
  });
});

describe('a projection without a receiver', () => {
  it('projects as before', () => {
    const field: SearchField = {
      name: 'value',
      kind: 'integer',
      path: 'https://ex/value',
      output: true,
    };
    expect(
      projectDocument(
        { '@id': ID, [alias('Work', 'value')]: { '@value': 'onbekend' } },
        workType([field]),
      ),
    ).toEqual({ id: ID });
  });
});
