import type { Distribution } from '@lde/dataset';
import {
  DataDumpProbeResult,
  type ProbeResultType,
} from '@lde/distribution-probe';

/**
 * Derive a cheap source-change signal for a distribution from metadata the
 * probe already collected – no body download.
 *
 * For a data dump the signal combines the most recent of the register’s
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
 * Returns `null` when no change signal can be established – a live SPARQL
 * endpoint (which exposes none), or a distribution whose probe yielded neither
 * a date nor a byte size. A `null` signal never compares equal, so those
 * distributions are always reprocessed.
 */
export function sourceSignal(
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

  const byteSize =
    probeResult instanceof DataDumpProbeResult &&
    probeResult.contentSize !== null
      ? probeResult.contentSize
      : distribution.byteSize;

  if (modifiedDate === undefined && byteSize === undefined) {
    return null;
  }

  return `${modifiedDate?.toISOString() ?? ''}|${byteSize ?? ''}`;
}

function mostRecent(...dates: (Date | undefined)[]): Date | undefined {
  return dates.reduce<Date | undefined>((latest, date) => {
    if (date === undefined) return latest;
    if (latest === undefined || date > latest) return date;
    return latest;
  }, undefined);
}
