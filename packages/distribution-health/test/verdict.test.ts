import { describe, it, expect } from 'vitest';
import { Distribution } from '@lde/dataset';
import { ImportFailed, ImportSuccessful } from '@lde/sparql-importer';
import {
  DataDumpProbeResult,
  NetworkError,
  SparqlProbeResult,
} from '@lde/distribution-probe';
import { importOutcomeToVerdict, probeResultToVerdict } from '../src/index.js';

function dataDumpResult(
  init: ResponseInit,
  failureReason: string | null = null,
): DataDumpProbeResult {
  return new DataDumpProbeResult(
    'http://example.org/data.ttl',
    new Response('', init),
    0,
    failureReason,
  );
}

const distribution = new Distribution(
  new URL('http://example.org/data.rdf'),
  'application/rdf+xml',
);

describe('importOutcomeToVerdict', () => {
  it('maps a failed import to an invalid deep verdict with a parse-error reason', () => {
    const outcome = new ImportFailed(
      distribution,
      'QName not allowed for property: rdf:Description',
    );

    const verdict = importOutcomeToVerdict(outcome, 'fp-1');

    expect(verdict).toEqual({
      valid: false,
      reason: 'parse-error',
      message: 'QName not allowed for property: rdf:Description',
      validatedFingerprint: 'fp-1',
      depth: 'deep',
    });
  });

  it('maps a successful import that produced triples to a valid deep verdict', () => {
    const outcome = new ImportSuccessful(distribution, 'graph-1', 42);

    const verdict = importOutcomeToVerdict(outcome, 'fp-1');

    expect(verdict).toEqual({
      valid: true,
      validatedFingerprint: 'fp-1',
      depth: 'deep',
    });
  });

  it('maps a successful import that produced zero triples to an invalid empty verdict', () => {
    const outcome = new ImportSuccessful(distribution, 'graph-1', 0);

    const verdict = importOutcomeToVerdict(outcome, 'fp-1');

    expect(verdict).toEqual({
      valid: false,
      reason: 'empty',
      validatedFingerprint: 'fp-1',
      depth: 'deep',
    });
  });
});

describe('probeResultToVerdict', () => {
  it('maps an empty-body probe failure to an invalid empty shallow verdict', () => {
    const result = dataDumpResult(
      { status: 200, headers: { 'Content-Type': 'text/turtle' } },
      'Distribution is empty',
    );

    const verdict = probeResultToVerdict(result, 'fp-1');

    expect(verdict).toEqual({
      valid: false,
      reason: 'empty',
      validatedFingerprint: 'fp-1',
      depth: 'shallow',
    });
  });

  it('maps a probe parse failure to an invalid parse-error shallow verdict carrying the message', () => {
    const result = dataDumpResult(
      { status: 200, headers: { 'Content-Type': 'text/turtle' } },
      'Unexpected "." on line 3.',
    );

    const verdict = probeResultToVerdict(result, 'fp-1');

    expect(verdict).toEqual({
      valid: false,
      reason: 'parse-error',
      message: 'Unexpected "." on line 3.',
      validatedFingerprint: 'fp-1',
      depth: 'shallow',
    });
  });

  it('returns null for a network error (no validity signal)', () => {
    const result = new NetworkError(
      'http://example.org/data.ttl',
      'ECONNREFUSED',
      0,
    );

    expect(probeResultToVerdict(result, 'fp-1')).toBeNull();
  });

  it('maps a successful probe of a small RDF body to a valid shallow verdict', () => {
    const result = dataDumpResult({
      status: 200,
      headers: { 'Content-Type': 'text/turtle', 'Content-Length': '500' },
    });

    const verdict = probeResultToVerdict(result, 'fp-1');

    expect(verdict).toEqual({
      valid: true,
      validatedFingerprint: 'fp-1',
      depth: 'shallow',
    });
  });

  it('returns null for a large body the probe only HEAD-checked (never parsed)', () => {
    const result = dataDumpResult({
      status: 200,
      headers: {
        'Content-Type': 'text/turtle',
        'Content-Length': '50000000',
      },
    });

    expect(probeResultToVerdict(result, 'fp-1')).toBeNull();
  });

  it('returns null for a successful probe of a non-RDF body (probe did not parse it)', () => {
    const result = dataDumpResult({
      status: 200,
      headers: { 'Content-Type': 'text/csv', 'Content-Length': '500' },
    });

    expect(probeResultToVerdict(result, 'fp-1')).toBeNull();
  });

  it('returns null for a SPARQL probe (shallow validity covers data dumps only)', () => {
    const result = new SparqlProbeResult(
      'http://example.org/sparql',
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      }),
      0,
      'application/sparql-results+json',
    );

    expect(probeResultToVerdict(result, 'fp-1')).toBeNull();
  });
});
