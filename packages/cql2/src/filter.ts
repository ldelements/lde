/**
 * The part of [CQL2 JSON](https://docs.ogc.org/is/21-065r2/21-065r2.html) this
 * package reads: the property first, then the value or values it is compared
 * to.
 *
 * - `=` and `in` read a single-valued property: it equals the value, or one of
 *   the values.
 * - `a_contains` and `a_overlaps` read an array property: it holds every one
 *   of the values, or at least one.
 * - `and` and `or` combine two or more of these.
 *
 * A property without a value matches none of them. Negation is left out for
 * that reason: what `not` means for a record that lacks the value must be the
 * same here as in any engine that runs the same filter as a query.
 */
export type Cql2Expression =
  | {
      readonly op: 'and' | 'or';
      readonly args: readonly Cql2Expression[];
    }
  | {
      readonly op: '=';
      readonly args: readonly [Cql2Property, string];
    }
  | {
      readonly op: 'in' | 'a_contains' | 'a_overlaps';
      readonly args: readonly [Cql2Property, readonly string[]];
    };

/** A property of the record a filter is tested against, by name. */
export interface Cql2Property {
  readonly property: string;
}

/** What a filter is tested against: values by property name. */
export type Cql2Record = Readonly<Record<string, unknown>>;

/**
 * A property a filter may name – what OGC API calls a queryable. It says what
 * the filter needs to know to be checked and tested: whether the property
 * holds a list, and how its values are read where they are not simply the
 * strings under its name.
 */
export interface Queryable {
  /** Whether the property holds a list, and so takes the array operators. */
  readonly array?: boolean;
  /**
   * The property’s value or values in a record. Defaults to what the record
   * holds under the property’s name. Whatever it returns, only strings are
   * compared; anything else counts as no value.
   */
  readonly read?: (record: Cql2Record) => unknown;
}

/** Why a filter may not name a property, as a sentence to report. */
export interface Unqueryable {
  readonly reason: string;
}

/**
 * Says for a property name whether a filter may use it. `undefined` is an
 * unknown property; an {@link Unqueryable} is a known one a filter may not
 * read, with the caller’s own reason.
 */
export type QueryableLookup = (
  property: string,
) => Queryable | Unqueryable | undefined;

/** Whether a record passes a filter. */
export type FilterTest = (record: Cql2Record) => boolean;

/** A filter that was checked: its test, or everything wrong with it. */
export type CompiledFilter =
  | { readonly ok: true; readonly matches: FilterTest }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Check a CQL2 JSON filter and compile it into a test for one record.
 *
 * The filter is data from outside the program, so nothing about it is assumed.
 * Every mistake is collected, not only the first: a value that is not a CQL2
 * JSON object, an operator outside {@link Cql2Expression}, arguments of the
 * wrong shape, a property the lookup does not know or refuses, and an operator
 * that does not fit the property (`=` on a list, `a_contains` on a single
 * value).
 */
export function compileFilter(
  filter: unknown,
  queryables: QueryableLookup,
): CompiledFilter {
  const problems: string[] = [];
  const matches = compileExpression(filter, queryables, problems);
  return matches === undefined || problems.length > 0
    ? { ok: false, problems }
    : { ok: true, matches };
}

function compileExpression(
  expression: unknown,
  queryables: QueryableLookup,
  problems: string[],
): FilterTest | undefined {
  if (!isObject(expression) || !Array.isArray(expression.args)) {
    problems.push(
      `a filter is a CQL2 JSON object with “op” and “args”, got ${JSON.stringify(expression)}.`,
    );
    return undefined;
  }
  const { op, args } = expression as { op: unknown; args: unknown[] };
  const unknownKeys = unknownKeysOf(expression, ['op', 'args']);
  if (unknownKeys.length > 0) {
    // Ignoring one would apply a filter that says less than its author meant.
    problems.push(
      `a filter holds “op” and “args” only, got ${unknownKeys.map((key) => `“${key}”`).join(', ')} as well.`,
    );
    return undefined;
  }
  switch (op) {
    case 'and':
    case 'or': {
      if (args.length < 2) {
        problems.push(`“${op}” needs two or more filters.`);
        return undefined;
      }
      const tests = args
        .map((arg) => compileExpression(arg, queryables, problems))
        .filter((test) => test !== undefined);
      if (tests.length < args.length) {
        return undefined;
      }
      return op === 'and'
        ? (record) => tests.every((test) => test(record))
        : (record) => tests.some((test) => test(record));
    }
    case '=': {
      const read = propertyReader(op, args, false, queryables, problems);
      const [, expected] = args;
      if (args.length === 2 && typeof expected !== 'string') {
        problems.push(
          `“=” compares a property to one string, got ${JSON.stringify(expected)}.`,
        );
        return undefined;
      }
      return read === undefined || typeof expected !== 'string'
        ? undefined
        : (record) => read(record).includes(expected);
    }
    case 'in':
    case 'a_contains':
    case 'a_overlaps': {
      const read = propertyReader(op, args, op !== 'in', queryables, problems);
      const [, expected] = args;
      if (!isNonEmptyStringList(expected)) {
        if (args.length === 2) {
          problems.push(
            `“${op}” compares a property to a list of one or more strings, got ${JSON.stringify(expected)}.`,
          );
        }
        return undefined;
      }
      if (read === undefined) {
        return undefined;
      }
      return op === 'a_contains'
        ? (record) => {
            const values = read(record);
            return expected.every((value) => values.includes(value));
          }
        : (record) => {
            const values = read(record);
            return expected.some((value) => values.includes(value));
          };
    }
    default:
      problems.push(
        `operator ${JSON.stringify(op)} is not supported; use “and”, “or”, “=”, “in”, “a_contains” or “a_overlaps”.`,
      );
      return undefined;
  }
}

/**
 * A reader for the property an operator’s first argument names, if the filter
 * may use it: a property the lookup knows and does not refuse, and a list
 * exactly when the operator compares lists.
 */
function propertyReader(
  op: string,
  args: readonly unknown[],
  comparesLists: boolean,
  queryables: QueryableLookup,
  problems: string[],
): ((record: Cql2Record) => readonly string[]) | undefined {
  const [property] = args;
  if (
    args.length !== 2 ||
    !isObject(property) ||
    typeof property.property !== 'string' ||
    unknownKeysOf(property, ['property']).length > 0
  ) {
    problems.push(
      `“${op}” takes two arguments, a { "property": … } and nothing else first, got ${JSON.stringify(args)}.`,
    );
    return undefined;
  }
  const name = property.property;
  const queryable = queryables(name);
  if (queryable === undefined) {
    problems.push(`no property “${name}” can be filtered on.`);
    return undefined;
  }
  if ('reason' in queryable) {
    problems.push(queryable.reason);
    return undefined;
  }
  if ((queryable.array === true) !== comparesLists) {
    problems.push(
      comparesLists
        ? `“${op}” compares lists, but “${name}” holds one value; use “=” or “in”.`
        : `“${op}” compares one value, but “${name}” is an array; use “a_contains” or “a_overlaps”.`,
    );
    return undefined;
  }
  const { read } = queryable;
  return read === undefined
    ? (record) => strings(record[name])
    : (record) => strings(read(record));
}

/** A value or a list of values, as the strings among them. */
function strings(value: unknown): readonly string[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string => typeof entry === 'string',
  );
}

function unknownKeysOf(
  value: Record<string, unknown>,
  known: readonly string[],
): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string')
  );
}
