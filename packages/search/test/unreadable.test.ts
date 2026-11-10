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
