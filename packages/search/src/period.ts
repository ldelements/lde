import { isoToUnixSeconds, lastSecondOf, type StoredDate } from './schema.js';

/**
 * The stretch of time a `period` value covers, as stored: the first and the
 * last second it allows, both inclusive. An open or unknown bound is stored as
 * {@link OPEN_START} or {@link OPEN_END}, so the overlap test an engine runs
 * needs no special case for it.
 */
export interface StoredPeriod {
  readonly start: number;
  readonly end: number;
}

/**
 * The stored start of a period with no known beginning (`../1607`, `/1607`):
 * the earliest second the `date` codec stores (`storableUnixSeconds`),
 * so a period open at its start overlaps every range that reaches back far
 * enough to meet its end, however deep in time that range begins. It is the
 * double nearest −2⁶³ that an int64 holds; −2⁶³ itself serialises as
 * `-9223372036854776000`, which no int64 does.
 */
export const OPEN_START = -(2 ** 63 - 1024);

/** The stored end of a period with no known end (`1440/..`, `1440/`); the
 *  mirror of {@link OPEN_START}. */
export const OPEN_END = 2 ** 63 - 1024;

/**
 * The period one value covers, or `undefined` for a value that states none.
 *
 * A value is an [EDTF](https://www.loc.gov/standards/datetime/) Level 0 or 1
 * date or interval, or anything the `date` codec reads ({@link
 * isoToUnixSeconds}): an `xsd:date`, `xsd:gYear`, `xsd:dateTime` or a
 * deep-time year. What each covers, from its first second to its last:
 *
 * | Value             | Covers                          |
 * | ----------------- | ------------------------------- |
 * | `1935`            | all of 1935                     |
 * | `1935/1955`       | 1935 through 1955               |
 * | `1620~`, `1620?`  | all of 1620 – the qualifier is not a margin |
 * | `162X`            | 1620 through 1629               |
 * | `1620-XX`, `1606-21` | all of 1620, all of 1606 – a season is its year |
 * | `1440/..`, `1440/`| 1440 onwards, unbounded         |
 * | `../1607`         | everything up to the end of 1607 |
 *
 * **An unknown bound reads as an open one.** EDTF tells them apart (`1440/` is
 * an end nobody knows, `1440/..` one that has not come), but a range filter
 * must answer for both, and leaving a work out of every result it might belong
 * to costs a reader more than one extra hit.
 *
 * **Each side is read on its own**, through the `date` codec: an empty or `..`
 * side is open, and what only EDTF states is rewritten into a form the codec
 * reads – a qualifier dropped, an unspecified month or day dropped to the
 * coarser precision, a season read as its year (EDTF fixes no months for it),
 * unspecified year digits read as their lowest and highest. Anything else
 * EDTF Level 1 does not allow, such as Level 2’s `1950S2`, states no period.
 * A value open at both ends, or ending before it starts, is no period at all.
 */
export function periodOf(value: string): StoredPeriod | undefined {
  const sides = value.split('/');
  if (sides.length > 2) {
    return undefined;
  }
  const from = sideOf(sides[0]);
  // A plain date is its own first and last side.
  const to = sides.length === 1 ? from : sideOf(sides[1]);
  if (from === undefined || to === undefined) {
    return undefined;
  }
  const { start } = from;
  const { end } = to;
  const openAtBothEnds = start === OPEN_START && end === OPEN_END;
  return start <= end && !openAtBothEnds ? { start, end } : undefined;
}

/**
 * The period several periods cover between them: the earliest start and the
 * latest end. One stored range per document is what an engine can sort on and
 * compare in a single clause, so a work dated `1668`, `1676` and `1686` is
 * stored as 1668 through 1686 – and a range falling between its dates still
 * matches it.
 */
export function periodCovering(
  first: StoredPeriod,
  ...rest: readonly StoredPeriod[]
): StoredPeriod {
  return rest.reduce(
    (covered, period) => ({
      start: Math.min(covered.start, period.start),
      end: Math.max(covered.end, period.end),
    }),
    first,
  );
}

/** One side of an interval, or a whole plain value. */
function sideOf(text: string): StoredPeriod | undefined {
  const side = text.trim();
  // EDTF’s open (`..`) and unknown (empty) bounds, both read as open.
  if (side === '' || side === '..') {
    return { start: OPEN_START, end: OPEN_END };
  }
  // A plain date, the common case, needs no rewriting.
  const plain = isoToUnixSeconds(side.replace(DEEP_YEAR, '$1'));
  if (plain !== undefined) {
    return { start: plain.seconds, end: endOf(plain) };
  }
  // What only EDTF states, rewritten into a form the codec reads.
  const date = side
    .replace(HOURS_ONLY_SHIFT, '$1:00')
    .replace(QUALIFIER, '$1')
    .replace(DEEP_YEAR, '$1')
    .replace(UNSPECIFIED_MONTH_OR_SEASON, '$1')
    .replace(UNSPECIFIED_DAY, '$1');
  const [lowest, highest] = UNSPECIFIED_YEAR.test(date)
    ? [date.replaceAll('X', '0'), date.replaceAll('X', '9')]
    : [date, date];
  const first = isoToUnixSeconds(lowest);
  const last = isoToUnixSeconds(highest);
  return first === undefined || last === undefined
    ? undefined
    : { start: first.seconds, end: endOf(last) };
}

/** The last second a date covers, held to {@link OPEN_END}: the last year the
 *  codec stores would otherwise end past what an int64 holds. */
function endOf(date: StoredDate): number {
  return Math.min(lastSecondOf(date), OPEN_END);
}

/** A time shift of whole hours (`T10:10:10+05`), which EDTF allows and the
 *  codec reads only as `+05:00`. */
const HOURS_ONLY_SHIFT = /(T[\d:.]+[+-]\d{2})$/;

/** An EDTF Level 1 qualifier – `~` approximate, `?` uncertain, `%` both – on a
 *  date. It is part of what is known, not a margin, so the date is read
 *  without it. */
const QUALIFIER = /^([^T]+)[~?%]$/;

/** An EDTF `Y` year – a year of any length, signed – read as the bare year
 *  the codec stores it as. */
const DEEP_YEAR = /^Y([+-]?\d+)$/;

/** An unspecified month (`1620-XX`, `1620-XX-XX`) or a season (`1606-21` to
 *  `1606-24`), read as the year. */
const UNSPECIFIED_MONTH_OR_SEASON = /^([+-]?\d{4,})-(?:XX(?:-XX)?|2[1-4])$/;

/** An unspecified day (`1620-05-XX`), read as the month. */
const UNSPECIFIED_DAY = /^([+-]?\d{4,}-\d{2})-XX$/;

/** A year with unspecified trailing digits: `162X`, `16XX`. Not `XXXX`, which
 *  knows no more than `../..`. */
const UNSPECIFIED_YEAR = /^(?=.{4}$)\d+X+$/;
