import type { Distribution } from '@lde/dataset';
import {
  DataDumpProbeResult,
  type ProbeResultType,
} from '@lde/distribution-probe';

/**
 * Derive a cheap source-change fingerprint for a distribution from metadata the
 * probe already collected – no body download.
 *
 * For a data dump the fingerprint combines the most recent of the register’s
 * declared `dct:modified` and the artifact’s HTTP `Last-Modified` with the
 * artifact’s byte size (the probe’s `Content-Length`, falling back to the
 * register’s declared `dcat:byteSize`). Taking the maximum date errs toward
 * reprocessing rather than serving stale output, and mirrors the change signal
 * {@link ImportResolver} computes for the downloader so the skip layer and the
 * download/import layer agree.
 *
 * The returned string is opaque: it is only ever compared for equality, never
 * parsed or ordered.
 *
 * Returns `null` when no fingerprint can be established – a live SPARQL
 * endpoint (which exposes none), or a distribution whose probe yielded neither
 * a usable date nor a byte size. A `null` fingerprint never compares equal, so
 * those distributions are always reprocessed.
 *
 * Robust against malformed third-party metadata: an unparseable HTTP
 * `Last-Modified` or `dct:modified` (an Invalid Date) and a non-numeric
 * `Content-Length` (`NaN`) are both treated as absent rather than producing a
 * throw or an unstable fingerprint.
 */
export function sourceFingerprint(
  distribution: Distribution,
  probeResult: ProbeResultType,
): string | null {
  if (distribution.isSparql()) {
    return null;
  }

  const modifiedDate = mostRecent(
    distribution.lastModified,
    probeResult instanceof DataDumpProbeResult
      ? (probeResult.lastModified ?? undefined)
      : undefined,
  );

  const probeSize =
    probeResult instanceof DataDumpProbeResult ? probeResult.contentSize : null;
  const byteSize =
    probeSize !== null && !Number.isNaN(probeSize)
      ? probeSize
      : distribution.byteSize;

  if (modifiedDate === undefined && byteSize === undefined) {
    return null;
  }

  return `${modifiedDate?.toISOString() ?? ''}|${byteSize ?? ''}`;
}

/**
 * The most recent of the given dates, ignoring `undefined` and Invalid Dates.
 * Filtering invalid dates keeps a malformed metadata value from being selected
 * (which would make `toISOString` throw) and from sticking ahead of a valid
 * date – `validDate > invalidDate` is `number > NaN`, i.e. always `false`.
 */
function mostRecent(...dates: (Date | undefined)[]): Date | undefined {
  return dates.reduce<Date | undefined>((latest, date) => {
    if (date === undefined || Number.isNaN(date.valueOf())) return latest;
    if (latest === undefined || date > latest) return date;
    return latest;
  }, undefined);
}
