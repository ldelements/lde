import { describe, expect, it } from 'vitest';
import {
  Distribution,
  IANA_MEDIA_TYPE_PREFIX,
  RdfFormat,
  rdfFormatToFileExtension,
} from '../src/distribution.js';

const iana = (type: string) => IANA_MEDIA_TYPE_PREFIX + type;
const SPARQL_URI = 'https://www.w3.org/TR/sparql11-protocol/';

describe('Distribution.mimeType', () => {
  it('strips the IANA prefix from an IANA media type URI', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nq'),
      iana('application/n-quads'),
    );

    expect(distribution.mimeType).toBe('application/n-quads');
  });

  it('passes a plain content type through unchanged', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nq'),
      'application/n-quads',
    );

    expect(distribution.mimeType).toBe('application/n-quads');
  });

  it('is undefined when no media type is declared', () => {
    const distribution = new Distribution(new URL('http://example.org/data'));

    expect(distribution.mimeType).toBeUndefined();
  });
});

describe('Distribution.compressMimeType', () => {
  it('strips the IANA prefix from an IANA compress format URI', () => {
    const distribution = new Distribution(new URL('http://example.org/x'));
    distribution.compressFormat = iana('application/gzip');

    expect(distribution.compressMimeType).toBe('application/gzip');
  });

  it('passes a plain compress format through unchanged', () => {
    const distribution = new Distribution(new URL('http://example.org/x'));
    distribution.compressFormat = 'application/gzip';

    expect(distribution.compressMimeType).toBe('application/gzip');
  });

  it('is undefined when no compress format is declared', () => {
    const distribution = new Distribution(new URL('http://example.org/x'));

    expect(distribution.compressMimeType).toBeUndefined();
  });
});

describe('Distribution.compressedMimeType', () => {
  it('appends +gzip when the compress format is gzip', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nq.gz'),
      iana('application/n-quads'),
    );
    distribution.compressFormat = iana('application/gzip');

    expect(distribution.compressedMimeType).toBe('application/n-quads+gzip');
  });

  it('appends +zip when the compress format is zip', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.ttl.zip'),
      iana('text/turtle'),
    );
    distribution.compressFormat = iana('application/zip');

    expect(distribution.compressedMimeType).toBe('text/turtle+zip');
  });

  it('treats application/x-gzip as gzip', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nt.gz'),
      iana('application/n-triples'),
    );
    distribution.compressFormat = iana('application/x-gzip');

    expect(distribution.compressedMimeType).toBe('application/n-triples+gzip');
  });

  it('is undefined when no compress format is declared', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nq'),
      iana('application/n-quads'),
    );

    expect(distribution.compressedMimeType).toBeUndefined();
  });

  it('is undefined when no media type is declared', () => {
    const distribution = new Distribution(new URL('http://example.org/data'));
    distribution.compressFormat = iana('application/gzip');

    expect(distribution.compressedMimeType).toBeUndefined();
  });

  it('is undefined for an unrecognised compress format', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nq.br'),
      iana('application/n-quads'),
    );
    distribution.compressFormat = iana('application/brotli');

    expect(distribution.compressedMimeType).toBeUndefined();
  });
});

describe('Distribution.isSparql', () => {
  it('is true when conformsTo is the SPARQL protocol', () => {
    const distribution = new Distribution(
      new URL('http://example.org/sparql'),
      undefined,
      new URL(SPARQL_URI),
    );

    expect(distribution.isSparql()).toBe(true);
  });

  it('is true for the application/sparql-query media type', () => {
    const distribution = new Distribution(
      new URL('http://example.org/sparql'),
      iana('application/sparql-query'),
    );

    expect(distribution.isSparql()).toBe(true);
  });

  it('is true for the application/sparql-results+json media type', () => {
    const distribution = new Distribution(
      new URL('http://example.org/sparql'),
      iana('application/sparql-results+json'),
    );

    expect(distribution.isSparql()).toBe(true);
  });

  it('is false for a plain RDF download', () => {
    const distribution = new Distribution(
      new URL('http://example.org/data.nq'),
      iana('application/n-quads'),
    );

    expect(distribution.isSparql()).toBe(false);
  });
});

describe('Distribution.sparql', () => {
  it('builds a SPARQL distribution with the protocol and a named graph', () => {
    const distribution = Distribution.sparql(
      new URL('http://example.org/sparql'),
      'http://example.org/graph',
    );

    expect(distribution.isSparql()).toBe(true);
    expect(distribution.conformsTo?.toString()).toBe(SPARQL_URI);
    expect(distribution.namedGraph).toBe('http://example.org/graph');
  });
});

describe('rdfFormatToFileExtension', () => {
  it('maps N-Triples to nt', () => {
    expect(rdfFormatToFileExtension(RdfFormat['N-Triples'])).toBe('nt');
  });

  it('maps N-Quads to nq', () => {
    expect(rdfFormatToFileExtension(RdfFormat['N-Quads'])).toBe('nq');
  });

  it('maps Turtle to ttl', () => {
    expect(rdfFormatToFileExtension(RdfFormat.Turtle)).toBe('ttl');
  });

  it('throws for an unknown format', () => {
    expect(() =>
      rdfFormatToFileExtension('application/rdf+xml' as RdfFormat),
    ).toThrow('Unknown mime type: application/rdf+xml');
  });
});
