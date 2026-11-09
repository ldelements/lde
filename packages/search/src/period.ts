import edtf from 'edtf';
import { isoToUnixSeconds, lastSecondOf } from './schema.js';

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
 * The stored start of a period with no known beginning (`../1607`, `/1607`).
 * Further back than any date the codec stores – deep time included – and still
 * an exact int64, so a period open at its start overlaps every range that
 * reaches back far enough to meet its end.
 */
export const OPEN_START = -(2 ** 62);

/** The stored end of a period with no known end (`1440/..`, `1440/`); the
 *  mirror of {@link OPEN_START}. */
export const OPEN_END = 2 ** 62;

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
 * | `1606-21`         | the season, as edtf.js reads it |
 * | `1440/..`, `1440/`| 1440 onwards, unbounded         |
 * | `../1607`         | everything up to the end of 1607 |
 *
 * **An unknown bound reads as an open one.** EDTF tells them apart (`1440/` is
 * an end nobody knows, `1440/..` one that has not come), but a range filter
 * must answer for both, and leaving a work out of every result it might belong
 * to costs a reader more than one extra hit.
 *
 * **Each side is read on its own**: an empty or `..` side is open, anything
 * the `date` codec reads goes to the codec, and the rest – qualifiers,
 * unspecified digits, seasons – to edtf.js. The codec comes first because
 * edtf.js holds dates in `Date` and so cannot hold deep-time years
 * (`Y-318000000/..`); a `Y` year is read by the codec without its `Y`. A value
 * open at both ends, or ending before it starts, is no period at all.
 */
export function periodOf(value: string): StoredPeriod | undefined {
  const sides = value.trim().split('/');
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
 * The period several values cover between them: the earliest start and the
 * latest end, or `undefined` when none states a period. One stored range per
 * document is what an engine can sort on and compare in a single clause, so a
 * work dated `1668`, `1676` and `1686` is stored as 1668 through 1686 – and a
 * range falling between its dates still matches it.
 */
export function periodOfAll(
  values: readonly string[],
): StoredPeriod | undefined {
  let covered: StoredPeriod | undefined;
  for (const value of values) {
    const period = periodOf(value);
    if (period === undefined) {
      continue;
    }
    covered =
      covered === undefined
        ? period
        : {
            start: Math.min(covered.start, period.start),
            end: Math.max(covered.end, period.end),
          };
  }
  return covered;
}

/** One side of an interval, or a whole plain value. */
function sideOf(text: string): StoredPeriod | undefined {
  // EDTF’s open (`..`) and unknown (empty) bounds, both read as open.
  if (text === '' || text === '..') {
    return { start: OPEN_START, end: OPEN_END };
  }
  const stored = isoToUnixSeconds(text.replace(DEEP_YEAR, '$1'));
  if (stored !== undefined) {
    return { start: stored.seconds, end: lastSecondOf(stored) };
  }
  let parsed: ReturnType<typeof edtf>;
  try {
    // Level 1 at most: the library defaults to Level 2, which would read
    // `1950S2` (some year in 1900–1999) as 1950 alone.
    parsed = edtf(text, { level: 1 });
  } catch {
    return undefined;
  }
  // edtf.js counts in milliseconds, its `max` the last millisecond covered.
  // A year `Date` cannot hold comes back `NaN`, which fails the `start <= end`
  // test in `periodOf`. Only an interval has an unknown (`null`) bound, and a
  // side is never one.
  return {
    start: Math.floor((parsed.min as number) / 1000),
    end: Math.floor((parsed.max as number) / 1000),
  };
}

/** An EDTF `Y` year – a year of any length, signed – read as the bare year
 *  the codec stores it as. */
const DEEP_YEAR = /^Y([+-]?\d+)$/;
