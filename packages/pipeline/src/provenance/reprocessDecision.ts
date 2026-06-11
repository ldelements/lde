import type { ChangeKey, ProcessingRecord } from './record.js';

/**
 * Decide whether a dataset must be reprocessed, given its current change
 * fields and the record from the last run (or `null` if it has never been
 * processed).
 *
 * The rule is pure equality on the two change fields:
 *
 * ```
 * skip iff  stored !== null
 *      AND  current.sourceFingerprint === stored.sourceFingerprint
 *      AND  current.pipelineVersion === stored.pipelineVersion
 * ```
 *
 * Equality, never ordering – any opaque version representation works, a
 * rollback to identical logic correctly skips, and a partial run resumes
 * cleanly. A `null` source fingerprint never compares equal, so a dataset with
 * no establishable fingerprint is always reprocessed.
 */
export function shouldReprocess(
  current: ChangeKey,
  stored: ProcessingRecord | null,
): boolean {
  if (stored === null) return true;
  // A null source fingerprint never compares equal, even to a stored null.
  if (current.sourceFingerprint === null) return true;
  if (current.sourceFingerprint !== stored.sourceFingerprint) return true;
  if (current.pipelineVersion !== stored.pipelineVersion) return true;
  return false;
}
