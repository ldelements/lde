import { describe, expect, it } from 'vitest';
import { compileFilter, type QueryableLookup } from '../src/index.js';

const queryables: QueryableLookup = (property) =>
  ({
    about: { array: true },
    genre: {},
    // Stored as nested objects; the filter compares their `id`.
    maker: {
      array: true,
      read: (record: Readonly<Record<string, unknown>>) =>
        (record.maker as { id: string }[] | undefined)?.map(({ id }) => id),
    },
    secret: { reason: 'property “secret” is not for filters.' },
  })[property];

const about = (op: string, ...values: string[]) => ({
  op,
  args: [{ property: 'about' }, values],
});
const genre = (op: string, value: unknown) => ({
  op,
  args: [{ property: 'genre' }, value],
});

function matches(filter: unknown, record: Record<string, unknown>): boolean {
  const compiled = compileFilter(filter, queryables);
  if (!compiled.ok) {
    throw new Error(compiled.problems.join('\n'));
  }
  return compiled.matches(record);
}

function problemsOf(filter: unknown): readonly string[] {
  const compiled = compileFilter(filter, queryables);
  return compiled.ok ? [] : compiled.problems;
}

describe('compileFilter', () => {
  it('wants every value for a_contains and any value for a_overlaps', () => {
    const record = { about: ['pottery', 'plates'] };

    expect(matches(about('a_contains', 'pottery'), record)).toBe(true);
    expect(matches(about('a_contains', 'pottery', 'glass'), record)).toBe(
      false,
    );
    expect(matches(about('a_overlaps', 'pottery', 'glass'), record)).toBe(true);
    expect(matches(about('a_overlaps', 'glass'), record)).toBe(false);
  });

  it('compares a single-valued property with = and in', () => {
    const record = { genre: 'plate' };

    expect(matches(genre('=', 'plate'), record)).toBe(true);
    expect(matches(genre('=', 'cup'), record)).toBe(false);
    expect(matches(genre('in', ['cup', 'plate']), record)).toBe(true);
    expect(matches(genre('in', ['cup']), record)).toBe(false);
  });

  it('matches nothing on a property without a value', () => {
    for (const record of [{}, { about: null, genre: null }, { about: [] }]) {
      expect(matches(about('a_contains', 'pottery'), record)).toBe(false);
      expect(matches(about('a_overlaps', 'pottery'), record)).toBe(false);
      expect(matches(genre('=', 'plate'), record)).toBe(false);
      expect(matches(genre('in', ['plate']), record)).toBe(false);
    }
  });

  it('compares strings only, whatever a record holds', () => {
    expect(matches(about('a_overlaps', '7'), { about: [7, { id: '7' }] })).toBe(
      false,
    );
  });

  it('reads a property the way its queryable says', () => {
    const filter = {
      op: 'a_contains',
      args: [{ property: 'maker' }, ['https://ex/maker/1']],
    };

    expect(matches(filter, { maker: [{ id: 'https://ex/maker/1' }] })).toBe(
      true,
    );
    expect(matches(filter, {})).toBe(false);
  });

  it('combines filters with and and or', () => {
    const record = { about: ['pottery'], genre: 'plate' };
    const passing = about('a_contains', 'pottery');
    const failing = genre('=', 'cup');

    expect(matches({ op: 'and', args: [passing, failing] }, record)).toBe(
      false,
    );
    expect(matches({ op: 'and', args: [passing, passing] }, record)).toBe(true);
    expect(matches({ op: 'or', args: [failing, passing] }, record)).toBe(true);
    expect(matches({ op: 'or', args: [failing, failing] }, record)).toBe(false);
  });
});

describe('a filter compileFilter refuses', () => {
  it('is anything but a CQL2 JSON object', () => {
    for (const filter of ['about = x', null, [], { op: '=' }]) {
      expect(problemsOf(filter)).toEqual([
        `a filter is a CQL2 JSON object with “op” and “args”, got ${JSON.stringify(filter)}.`,
      ]);
    }
  });

  it('uses an operator outside the subset', () => {
    expect(problemsOf({ op: 'not', args: [genre('=', 'cup')] })).toEqual([
      'operator "not" is not supported; use “and”, “or”, “=”, “in”, “a_contains” or “a_overlaps”.',
    ]);
  });

  it('combines fewer than two filters', () => {
    expect(problemsOf({ op: 'and', args: [genre('=', 'cup')] })).toEqual([
      '“and” needs two or more filters.',
    ]);
  });

  it('reports a mistake inside a combination once, where it is', () => {
    expect(
      problemsOf({
        op: 'or',
        args: [genre('=', 'cup'), { op: 'like', args: [] }],
      }),
    ).toEqual([
      'operator "like" is not supported; use “and”, “or”, “=”, “in”, “a_contains” or “a_overlaps”.',
    ]);
  });

  it('has arguments of the wrong shape, and reports each', () => {
    expect(
      problemsOf({ op: '=', args: ['plate', { property: 'genre' }] }),
    ).toEqual([
      '“=” takes two arguments, a { "property": … } and nothing else first, got ["plate",{"property":"genre"}].',
      '“=” compares a property to one string, got {"property":"genre"}.',
    ]);
    // One mistake, one problem: a missing value is not reported twice.
    expect(problemsOf({ op: '=', args: [{ property: 'genre' }] })).toEqual([
      '“=” takes two arguments, a { "property": … } and nothing else first, got [{"property":"genre"}].',
    ]);
    expect(problemsOf({ op: 'in', args: [{ property: 'genre' }] })).toEqual([
      '“in” takes two arguments, a { "property": … } and nothing else first, got [{"property":"genre"}].',
    ]);
    expect(problemsOf(about('a_contains'))).toEqual([
      '“a_contains” compares a property to a list of one or more strings, got [].',
    ]);
    expect(problemsOf(genre('in', 'plate'))).toEqual([
      '“in” compares a property to a list of one or more strings, got "plate".',
    ]);
  });

  it('holds a key it does not know, so nothing is silently ignored', () => {
    expect(problemsOf({ ...genre('=', 'plate'), not: true })).toEqual([
      'a filter holds “op” and “args” only, got “not” as well.',
    ]);
    expect(
      problemsOf({
        op: '=',
        args: [{ property: 'genre', casei: true }, 'plate'],
      }),
    ).toEqual([
      '“=” takes two arguments, a { "property": … } and nothing else first, got [{"property":"genre","casei":true},"plate"].',
    ]);
  });

  it('names a property the lookup does not know or refuses', () => {
    expect(problemsOf({ op: '=', args: [{ property: 'topic' }, 'x'] })).toEqual(
      ['no property “topic” can be filtered on.'],
    );
    expect(
      problemsOf({ op: 'in', args: [{ property: 'secret' }, ['x']] }),
    ).toEqual(['property “secret” is not for filters.']);
  });

  it('uses an operator that does not fit the property', () => {
    expect(problemsOf({ op: '=', args: [{ property: 'about' }, 'x'] })).toEqual(
      [
        '“=” compares one value, but “about” is an array; use “a_contains” or “a_overlaps”.',
      ],
    );
    expect(problemsOf(genre('a_overlaps', ['x']))).toEqual([
      '“a_overlaps” compares lists, but “genre” holds one value; use “=” or “in”.',
    ]);
  });
});
