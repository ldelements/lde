import { describe, it, expect } from 'vitest';
import { Distribution } from '@lde/dataset';
import {
  DataDumpProbeResult,
  SparqlProbeResult,
} from '@lde/distribution-probe';
import { sourceSignal } from '../../src/provenance/sourceSignal.js';

const dumpUrl = 'http://example.org/data.nt';

function sparqlProbeResult(url: string): SparqlProbeResult {
  return new SparqlProbeResult(
    url,
    new Response('', {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    }),
    0,
    'application/sparql-results+json',
  );
}

function dataDump(options: {
  modified?: Date;
  lastModified?: string;
  declaredByteSize?: number;
  contentLength?: number;
}): { distribution: Distribution; result: DataDumpProbeResult } {
  const distribution = new Distribution(
    new URL(dumpUrl),
    'application/n-triples',
  );
  distribution.lastModified = options.modified;
  distribution.byteSize = options.declaredByteSize;

  const headers: Record<string, string> = {};
  if (options.lastModified) headers['Last-Modified'] = options.lastModified;
  if (options.contentLength !== undefined) {
    headers['Content-Length'] = String(options.contentLength);
  }

  const result = new DataDumpProbeResult(
    dumpUrl,
    new Response('', { status: 200, headers }),
    0,
  );
  return { distribution, result };
}

describe('sourceSignal', () => {
  it('returns null for a live SPARQL endpoint', () => {
    const distribution = Distribution.sparql(
      new URL('http://example.org/sparql'),
    );

    expect(
      sourceSignal(
        distribution,
        sparqlProbeResult('http://example.org/sparql'),
      ),
    ).toBeNull();
  });

  it('takes the most recent of dct:modified and Last-Modified, regardless of side', () => {
    // dct:modified newer than Last-Modified.
    const registerNewer = dataDump({
      modified: new Date('2024-06-01T00:00:00Z'),
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      contentLength: 1000,
    });
    // Last-Modified newer than dct:modified, same maximum date.
    const httpNewer = dataDump({
      modified: new Date('2024-01-01T00:00:00Z'),
      lastModified: 'Sat, 01 Jun 2024 00:00:00 GMT',
      contentLength: 1000,
    });

    const a = sourceSignal(registerNewer.distribution, registerNewer.result);
    const b = sourceSignal(httpNewer.distribution, httpNewer.result);

    expect(a).not.toBeNull();
    // Both resolve to the same maximum date (2024-06-01) with the same size.
    expect(a).toBe(b);

    // A strictly later maximum date yields a different signal.
    const later = dataDump({
      modified: new Date('2024-07-01T00:00:00Z'),
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      contentLength: 1000,
    });
    expect(sourceSignal(later.distribution, later.result)).not.toBe(a);
  });

  it('changes when the byte size changes but the date does not', () => {
    const small = dataDump({
      modified: new Date('2024-06-01T00:00:00Z'),
      contentLength: 1000,
    });
    const large = dataDump({
      modified: new Date('2024-06-01T00:00:00Z'),
      contentLength: 2000,
    });

    expect(sourceSignal(small.distribution, small.result)).not.toBe(
      sourceSignal(large.distribution, large.result),
    );
  });

  it('prefers the probe Content-Length over the declared byte size', () => {
    // Same declared size, but different real Content-Length: the observed size
    // must drive the signal so a re-upload that kept its register metadata is
    // still detected.
    const observedSmall = dataDump({
      modified: new Date('2024-06-01T00:00:00Z'),
      declaredByteSize: 5000,
      contentLength: 1000,
    });
    const observedLarge = dataDump({
      modified: new Date('2024-06-01T00:00:00Z'),
      declaredByteSize: 5000,
      contentLength: 2000,
    });

    expect(
      sourceSignal(observedSmall.distribution, observedSmall.result),
    ).not.toBe(sourceSignal(observedLarge.distribution, observedLarge.result));
  });

  it('falls back to the declared byte size when the probe has no Content-Length', () => {
    const declaredOnly = dataDump({
      modified: new Date('2024-06-01T00:00:00Z'),
      declaredByteSize: 1000,
    });
    const observed = dataDump({
      modified: new Date('2024-06-01T00:00:00Z'),
      contentLength: 1000,
    });

    // Declared 1000 and observed 1000 resolve to the same signal.
    expect(sourceSignal(declaredOnly.distribution, declaredOnly.result)).toBe(
      sourceSignal(observed.distribution, observed.result),
    );
  });

  it('returns null for a data dump with neither a date nor a byte size', () => {
    const { distribution, result } = dataDump({});

    expect(sourceSignal(distribution, result)).toBeNull();
  });
});
