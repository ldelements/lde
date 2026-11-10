import {
  isAbsoluteIri,
  isoToUnixSeconds,
  storableUnixSeconds,
  type StoredDate,
} from './schema.js';

/** What reading a value that is there, but not one its kind can store, gives:
 *  `onbekend` for an integer, `ja` for a boolean. */
export const UNREADABLE = Symbol('unreadable');

/**
 * One value read as a field’s kind: what the field stores, {@link UNREADABLE}
 * for a value it cannot store, or `undefined` for no value at all – a missing
 * or blank one, which states nothing to correct at the source.
 */
export type Reading<T> = T | typeof UNREADABLE | undefined;

/** The kinds that can refuse a value: the rest store any literal. */
export type ReadKind = 'integer' | 'number' | 'boolean' | 'date' | 'reference';

/**
 * Read one value – a literal from the graph, or whatever a `derive` returned –
 * as `kind` stores it. Both value routes read through here, so a kind accepts
 * and refuses the same values whichever route they came by.
 *
 * - `integer`: a finite number, or an `xsd:decimal` or `xsd:double` lexical
 *   form, truncated. `INF` and `NaN` are refused: an engine cannot store them.
 * - `number`: the same, untruncated.
 * - `boolean`: `true` or `false`, or the `xsd:boolean` lexical space
 *   (`true`/`false`/`1`/`0`).
 * - `date`: anything the `date` codec reads ({@link isoToUnixSeconds}), or
 *   Unix seconds as a number.
 * - `reference`: an absolute IRI.
 *
 * A string is read with surrounding whitespace collapsed, as XSD does.
 */
export function readValue(
  kind: ReadKind,
  value: unknown,
): Reading<number | boolean | string | StoredDate> {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = typeof value === 'string' ? value.trim() : undefined;
  if (text === '') {
    return undefined;
  }
  switch (kind) {
    case 'integer':
    case 'number': {
      const number =
        typeof value === 'number'
          ? value
          : text !== undefined && NUMERIC.test(text)
            ? Number(text)
            : Number.NaN;
      if (!Number.isFinite(number)) {
        return UNREADABLE;
      }
      return kind === 'integer' ? Math.trunc(number) : number;
    }
    case 'boolean':
      if (typeof value === 'boolean') {
        return value;
      }
      return text !== undefined && BOOLEAN.has(text)
        ? text === 'true' || text === '1'
        : UNREADABLE;
    case 'date': {
      if (typeof value === 'number') {
        // Truncated, as the codec truncates a string’s fractional seconds: the
        // field is an int64. `storableUnixSeconds` drops NaN.
        const seconds = storableUnixSeconds(Math.trunc(value));
        return seconds === undefined
          ? UNREADABLE
          : { seconds, precision: 'dateTime' };
      }
      return (
        (text === undefined ? undefined : isoToUnixSeconds(text)) ?? UNREADABLE
      );
    }
    case 'reference':
      return text !== undefined && isAbsoluteIri(text) ? text : UNREADABLE;
  }
}

/** The `xsd:decimal` and `xsd:double` lexical forms, `INF` and `NaN` aside. */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The `xsd:boolean` lexical space. */
const BOOLEAN: ReadonlySet<string> = new Set(['true', 'false', '1', '0']);
