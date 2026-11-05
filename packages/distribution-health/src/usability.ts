import type { ValidityVerdict } from './verdict.js';

/** The single derived health verdict consumers act on. */
export type UsabilityState = 'usable' | 'unusable' | 'unknown';

/**
 * Why a distribution is not plainly `usable`. Carried separately from the
 * state so a consumer can render the reason without re-deriving it.
 */
export type UsabilityCause =
  | 'invalid'
  | 'unreachable'
  | 'no-verdict'
  | 'stale-verdict';

/** The currently-observed reachability of a distribution. */
export interface Reachability {
  /** Whether the distribution could be fetched (HTTP/SPARQL level). */
  reachable: boolean;
  /**
   * The source fingerprint observed on this reachability check – the shared
   * key against which a validity verdict’s `validatedFingerprint` is matched.
   */
  fingerprint: string | null;
}

/** Result of the usability rollup. */
export interface Usability {
  state: UsabilityState;
  cause?: UsabilityCause;
  /**
   * Set when the state rests on a shallow verdict only (no deep verdict
   * applied), so a consumer can mark the result as not yet deeply confirmed.
   */
  shallow?: true;
}

/**
 * Roll reachability and validity verdict(s) up into the one canonical
 * usability verdict. Reachability dominates: an unreachable distribution is
 * unusable regardless of any validity verdict.
 */
export function usability(
  reachability: Reachability,
  verdicts: readonly ValidityVerdict[],
): Usability {
  if (!reachability.reachable) {
    return { state: 'unusable', cause: 'unreachable' };
  }

  const chosen = chooseVerdict(verdicts, reachability.fingerprint);
  if (chosen === undefined) {
    // A verdict that exists but no longer matches the observed fingerprint has
    // gone stale (e.g. a since-fixed dump); distinguish that from never having
    // been judged at all, so a stale negative stops showing as broken.
    const cause = verdicts.length > 0 ? 'stale-verdict' : 'no-verdict';
    return { state: 'unknown', cause };
  }

  const flag = chosen.depth === 'shallow' ? { shallow: true as const } : {};
  return chosen.valid
    ? { state: 'usable', ...flag }
    : { state: 'unusable', cause: 'invalid', ...flag };
}

/**
 * The authoritative verdict among those still fresh against the
 * currently-observed fingerprint, or `undefined` when none apply. A deep
 * verdict beats a shallow one; freshness is decided by the staleness gate.
 */
function chooseVerdict(
  verdicts: readonly ValidityVerdict[],
  currentFingerprint: string | null,
): ValidityVerdict | undefined {
  const fresh = verdicts.filter((verdict) =>
    isFresh(verdict, currentFingerprint),
  );
  return fresh.find((verdict) => verdict.depth === 'deep') ?? fresh[0];
}

/**
 * Whether a verdict still applies to the currently-observed source. A verdict
 * applies only if the fingerprint it was judged against equals the current
 * one; a `null` fingerprint never compares equal (mirroring
 * `sourceFingerprint`), so an unfingerprintable source is never considered
 * fresh.
 */
function isFresh(
  verdict: ValidityVerdict,
  currentFingerprint: string | null,
): boolean {
  return (
    currentFingerprint !== null &&
    verdict.validatedFingerprint !== null &&
    verdict.validatedFingerprint === currentFingerprint
  );
}
