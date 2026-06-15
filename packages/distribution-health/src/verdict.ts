import { ImportFailed, ImportSuccessful } from '@lde/sparql-importer';
import {
  DataDumpProbeResult,
  type ProbeResultType,
} from '@lde/distribution-probe';

/**
 * Why a distribution’s RDF was judged invalid. Mirrors the LDE
 * `distribution-validity-failure#` SKOS scheme 1:1; the local names match the
 * concept local names, so a reason maps to
 * `https://w3id.org/lde/distribution-validity-failure#${reason}` with no lookup
 * table.
 */
export type ValidityFailureReason = 'parse-error' | 'empty';

/** How thoroughly validity was assessed. */
export type ValidityDepth = 'shallow' | 'deep';

/**
 * A verdict on whether a distribution’s fetched content parses as RDF.
 *
 * `reason` and `message` are present only when `valid` is `false`. The verdict
 * carries the `validatedFingerprint` it was judged against so a consumer can
 * tell whether it still applies to the currently-observed source.
 */
export interface ValidityVerdict {
  valid: boolean;
  reason?: ValidityFailureReason;
  message?: string;
  validatedFingerprint: string | null;
  depth: ValidityDepth;
}

/**
 * Map a deep import outcome (full parse) to a validity verdict. A failed import
 * is invalid RDF; a successful one is valid.
 */
export function importOutcomeToVerdict(
  outcome: ImportFailed | ImportSuccessful,
  validatedFingerprint: string | null,
): ValidityVerdict {
  if (outcome instanceof ImportSuccessful) {
    if (outcome.tripleCount === 0) {
      return {
        valid: false,
        reason: 'empty',
        validatedFingerprint,
        depth: 'deep',
      };
    }
    return { valid: true, validatedFingerprint, depth: 'deep' };
  }

  return {
    valid: false,
    reason: 'parse-error',
    message: outcome.error,
    validatedFingerprint,
    depth: 'deep',
  };
}

// The probe’s `failureReason` strings that signal an empty distribution rather
// than a parse error. Mirrors `validateBody` in `@lde/distribution-probe`.
const EMPTY_FAILURE_REASONS = new Set([
  'Distribution is empty',
  'Distribution contains no RDF triples',
]);

// Content types `@lde/distribution-probe` parse-validates; a successful probe
// of one of these is positive evidence the body parsed. Mirrors
// `rdfContentTypes` there. (Duplicated rather than imported because the probe
// does not export it; a structured validity signal on the probe result would
// remove this coupling — see #468.)
const PROBE_PARSED_CONTENT_TYPES = new Set([
  'text/turtle',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'text/n3',
  'application/ld+json',
  'application/rdf+xml',
]);

// The probe only fetches and parses bodies at or below this size; larger ones
// are HEAD-checked only, so a success carries no validity signal. Mirrors the
// threshold in `probeDataDump`.
const PROBE_PARSE_LIMIT_BYTES = 10_240;

/**
 * Map a shallow probe result to a validity verdict, or `null` when the probe
 * carries no validity signal (a network or HTTP-level failure, or a body the
 * probe did not parse). This is the shallow producer: it interprets the body
 * validation `@lde/distribution-probe` already performs for small RDF dumps.
 */
export function probeResultToVerdict(
  result: ProbeResultType,
  validatedFingerprint: string | null,
): ValidityVerdict | null {
  if (!(result instanceof DataDumpProbeResult)) {
    return null;
  }

  if (result.failureReason !== null) {
    if (EMPTY_FAILURE_REASONS.has(result.failureReason)) {
      return {
        valid: false,
        reason: 'empty',
        validatedFingerprint,
        depth: 'shallow',
      };
    }
    return {
      valid: false,
      reason: 'parse-error',
      message: result.failureReason,
      validatedFingerprint,
      depth: 'shallow',
    };
  }

  if (result.isSuccess() && probeParsedBody(result)) {
    return { valid: true, validatedFingerprint, depth: 'shallow' };
  }

  return null;
}

/**
 * Whether the probe actually parsed this distribution’s body – the only
 * grounds on which a `valid: true` shallow verdict may rest. True when the
 * content type is one the probe parse-validates and the body was small enough
 * to have been fetched rather than only HEAD-checked.
 */
function probeParsedBody(result: DataDumpProbeResult): boolean {
  const serialization = result.contentType?.split(';')[0].trim();
  if (
    serialization === undefined ||
    !PROBE_PARSED_CONTENT_TYPES.has(serialization)
  ) {
    return false;
  }
  return (
    result.contentSize === null || result.contentSize <= PROBE_PARSE_LIMIT_BYTES
  );
}
