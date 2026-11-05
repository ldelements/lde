import { describe, it, expect } from 'vitest';
import { Distribution } from '@lde/dataset';
import {
  DataDumpProbeResult,
  SparqlProbeResult,
} from '@lde/distribution-probe';
import { sourceFingerprint } from '../../src/provenance/sourceFingerprint.js';

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

describe('sourceFingerprint', () => {
  it('returns null for a live SPARQL endpoint', () => {
    const distribution = Distribution.sparql(
      new URL('http://example.org/sparql'),
    );

    expect(
      sourceFingerprint(
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

    const a = sourceFingerprint(
      registerNewer.distribution,
      registerNewer.result,
    );
    const b = sourceFingerprint(httpNewer.distribution, httpNewer.result);

    expect(a).not.toBeNull();
    // Both resolve to the same maximum date (2024-06-01) with the same size.
    expect(a).toBe(b);

    // A strictly later maximum date yields a different signal.
    const later = dataDump({
      modified: new Date('2024-07-01T00:00:00Z'),
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      contentLength: 1000,
    });
    expect(sourceFingerprint(later.distribution, later.result)).not.toBe(a);
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

    expect(sourceFingerprint(small.distribution, small.result)).not.toBe(
      sourceFingerprint(large.distribution, large.result),
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
      sourceFingerprint(observedSmall.distribution, observedSmall.result),
    ).not.toBe(
      sourceFingerprint(observedLarge.distribution, observedLarge.result),
    );
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
    expect(
      sourceFingerprint(declaredOnly.distribution, declaredOnly.result),
    ).toBe(sourceFingerprint(observed.distribution, observed.result));
  });

  it('returns null for a data dump with neither a date nor a byte size', () => {
    const { distribution, result } = dataDump({});

    expect(sourceFingerprint(distribution, result)).toBeNull();
  });

  describe('malformed metadata', () => {
    it('does not throw on an unparseable HTTP Last-Modified, falling back to byte size', () => {
      const { distribution, result } = dataDump({
        lastModified: 'not-a-date',
        contentLength: 1000,
      });

      // A malformed Last-Modified (Invalid Date) is ignored, not selected and
      // toISOString'd into a throw. With no usable date, the fingerprint is
      // size-only.
      const sizeOnly = dataDump({ contentLength: 1000 });
      expect(sourceFingerprint(distribution, result)).toBe(
        sourceFingerprint(sizeOnly.distribution, sizeOnly.result),
      );
    });

    it('returns null when the only date is unparseable and there is no byte size', () => {
      const { distribution, result } = dataDump({ lastModified: 'garbage' });

      expect(sourceFingerprint(distribution, result)).toBeNull();
    });

    it('lets a valid Last-Modified win over an unparseable register dct:modified', () => {
      // Regression: an Invalid Date must not stick ahead of a valid one
      // (`valid > invalid` is `number > NaN` = false).
      const invalidRegister = dataDump({
        modified: new Date('not-a-date'),
        lastModified: 'Sat, 01 Jun 2024 00:00:00 GMT',
        contentLength: 1000,
      });
      const validOnly = dataDump({
        lastModified: 'Sat, 01 Jun 2024 00:00:00 GMT',
        contentLength: 1000,
      });

      expect(
        sourceFingerprint(invalidRegister.distribution, invalidRegister.result),
      ).toBe(sourceFingerprint(validOnly.distribution, validOnly.result));
    });
  });
});
