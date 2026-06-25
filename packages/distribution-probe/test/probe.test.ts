import {
  probe,
  probeMany,
  SparqlProbeResult,
  DataDumpProbeResult,
  NetworkError,
} from '../src/index.js';
import { Distribution, IANA_MEDIA_TYPE_PREFIX } from '@lde/dataset';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

// Body/triple validation is opt-in; pass this to exercise the validation path.
const VALIDATE_RDF = { validateRdfContent: true } as const;

describe('probe', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('SPARQL endpoint', () => {
    it('returns SparqlProbeResult on successful probe', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(SparqlProbeResult);
      expect((result as SparqlProbeResult).isSuccess()).toBe(true);
    });

    it('returns unsuccessful SparqlProbeResult on empty response body', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(SparqlProbeResult);
      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(false);
      expect(sparqlResult.failureReason).toBe(
        'SPARQL endpoint returned an empty response',
      );
    });

    it('returns unsuccessful SparqlProbeResult on invalid JSON', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('not json', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(SparqlProbeResult);
      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(false);
      expect(sparqlResult.failureReason).toBe(
        'SPARQL endpoint returned invalid JSON',
      );
    });

    it('returns unsuccessful SparqlProbeResult when results key is missing', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('{"error": "something went wrong"}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(SparqlProbeResult);
      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(false);
      expect(sparqlResult.failureReason).toBe(
        'SPARQL endpoint did not return a valid results object',
      );
    });

    it('returns unsuccessful SparqlProbeResult on wrong content type', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('<html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(SparqlProbeResult);
      expect((result as SparqlProbeResult).isSuccess()).toBe(false);
    });

    it('returns unsuccessful SparqlProbeResult on HTTP error', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(SparqlProbeResult);
      expect((result as SparqlProbeResult).isSuccess()).toBe(false);
      expect((result as SparqlProbeResult).statusCode).toBe(500);
    });

    it('returns a successful SparqlProbeResult when SELECT results are XML', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          '<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head/><results><result/></results></sparql>',
          {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+xml' },
          },
        ),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(SparqlProbeResult);
      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(true);
      expect(sparqlResult.failureReason).toBeNull();
    });

    it('returns an unsuccessful SparqlProbeResult when XML is not a SPARQL document', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('<?xml version="1.0"?><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+xml' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(false);
      expect(sparqlResult.failureReason).toBe(
        'SPARQL endpoint returned invalid XML',
      );
    });

    it('returns an unsuccessful SparqlProbeResult when XML SELECT results lack a results element', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          '<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head/></sparql>',
          {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+xml' },
          },
        ),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(false);
      expect(sparqlResult.failureReason).toBe(
        'SPARQL endpoint did not return a valid results object',
      );
    });

    it('accepts an XML ASK result and rejects one without a boolean', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          '<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head/><boolean>true</boolean></sparql>',
          {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+xml' },
          },
        ),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const valid = await probe(distribution, {
        sparqlQuery: 'ASK { ?s ?p ?o }',
      });
      expect((valid as SparqlProbeResult).isSuccess()).toBe(true);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          '<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head/></sparql>',
          {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+xml' },
          },
        ),
      );

      const invalid = await probe(distribution, {
        sparqlQuery: 'ASK { ?s ?p ?o }',
      });
      const invalidResult = invalid as SparqlProbeResult;
      expect(invalidResult.isSuccess()).toBe(false);
      expect(invalidResult.failureReason).toBe(
        'SPARQL endpoint did not return a valid ASK result',
      );
    });

    it('sends an Accept header that allows both JSON and XML results', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      await probe(distribution);

      const accept = (
        vi.mocked(fetch).mock.calls[0][1]?.headers as Headers
      ).get('Accept');
      expect(accept).toContain('application/sparql-results+json');
      expect(accept).toContain('application/sparql-results+xml');
    });

    it('normalizes a single accepted content type to a one-element list', () => {
      const result = new SparqlProbeResult(
        'http://example.org/sparql',
        new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
        0,
        'application/sparql-results+json',
      );

      expect(result.acceptedContentTypes).toEqual([
        'application/sparql-results+json',
      ]);
      expect(result.isSuccess()).toBe(true);
    });
  });

  describe('data dump', () => {
    it('returns DataDumpProbeResult with metadata', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 200,
          headers: {
            'Content-Type': 'application/n-triples',
            'Content-Length': '12345',
            'Last-Modified': 'Wed, 21 Oct 2020 07:28:00 GMT',
          },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(true);
      expect(dumpResult.contentSize).toBe(12345);
      expect(dumpResult.lastModified).toBeInstanceOf(Date);
    });

    it('sends the declared mime type with a */* fallback in Accept', async () => {
      // Some servers (notably Dataverse's /api/access/datafile/) reject any
      // non-*/* Accept with 406, even when they would happily serve the
      // declared type by default. Sending `<declared>, */*;q=0.5` lets
      // compliant servers honour the preference and lets quirky servers fall
      // back to */* so the probe doesn't false-positive a ContentTypeMismatch.
      let capturedAccept: string | null = null;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedAccept = new Headers(init?.headers).get('Accept');
        return new Response('', {
          status: 200,
          headers: {
            'Content-Type': 'text/markdown',
            'Content-Length': '12345',
          },
        });
      });

      const distribution = new Distribution(
        new URL('http://example.org/file.md'),
        'text/markdown',
      );

      await probe(distribution);

      expect(capturedAccept).toBe('text/markdown, */*;q=0.5');
    });

    it('sends Accept: */* when no mime type is declared', async () => {
      let capturedAccept: string | null = null;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedAccept = new Headers(init?.headers).get('Accept');
        return new Response('', {
          status: 200,
          headers: { 'Content-Length': '12345' },
        });
      });

      const distribution = new Distribution(new URL('http://example.org/file'));

      await probe(distribution);

      expect(capturedAccept).toBe('*/*');
    });

    it('does not mutate the distribution', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 200,
          headers: {
            'Content-Type': 'application/n-triples',
            'Content-Length': '12345',
          },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      await probe(distribution);

      expect(distribution.byteSize).toBeUndefined();
    });

    it('reads the body via GET when content validation is enabled', async () => {
      const body =
        '<http://example.org/s> <http://example.org/p> <http://example.org/o> .\n';
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('', {
            status: 200,
            headers: { 'Content-Length': '0' },
          }),
        ) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: {
              'Content-Length': '5000',
              'Content-Type': 'application/n-triples',
            },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(result).toBeInstanceOf(DataDumpProbeResult);
      expect((result as DataDumpProbeResult).contentSize).toBe(5000);
    });

    it('records an HTTP error on the GET path without validating the body', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response('Not Found', { status: 404, statusText: 'Not Found' }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.statusCode).toBe(404);
      expect(dumpResult.failureReason).toBeNull();
    });

    it('marks zero-byte response as failure', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(new Response('', { status: 200 })); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe('Distribution is empty');
    });

    it('marks prefix-only Turtle as failure', async () => {
      const body = '@prefix ex: <http://example.org/> .\n';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/turtle' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.ttl'),
        'text/turtle',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe(
        'Distribution contains no RDF triples',
      );
    });

    it('marks malformed Turtle as failure', async () => {
      const body = 'this is not valid turtle at all {{{';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/turtle' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.ttl'),
        'text/turtle',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBeTruthy();
    });

    it('marks small file with triples as success', async () => {
      const body =
        '<http://example.org/s> <http://example.org/p> <http://example.org/o> .\n';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/n-triples' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(true);
      expect(dumpResult.failureReason).toBeNull();
    });

    it('marks empty JSON-LD as failure', async () => {
      const body = '{}';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/ld+json' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.jsonld'),
        'application/ld+json',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe(
        'Distribution contains no RDF triples',
      );
    });

    it('matches the content type case-insensitively', async () => {
      const body = '{}';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'Application/LD+JSON' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.jsonld'),
        'application/ld+json',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe(
        'Distribution contains no RDF triples',
      );
    });

    it('marks empty RDF/XML as failure', async () => {
      const body =
        '<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/rdf+xml' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.rdf'),
        'application/rdf+xml',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe(
        'Distribution contains no RDF triples',
      );
    });

    it('marks prefix-only N3 as failure', async () => {
      const body = '@prefix ex: <http://example.org/> .\n';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/n3' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.n3'),
        'text/n3',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe(
        'Distribution contains no RDF triples',
      );
    });

    it('marks JSON-LD with triples as success', async () => {
      const body =
        '{"@id": "http://example.org/s", "http://example.org/p": {"@id": "http://example.org/o"}}';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/ld+json' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.jsonld'),
        'application/ld+json',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(true);
      expect(dumpResult.failureReason).toBeNull();
    });

    it('does not read the body when the declared type is not RDF', async () => {
      // text/csv is not an RDF serialization, so even with validation enabled the
      // probe stays reachability-only and never issues the GET.
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/csv' },
        }),
      ); // HEAD only

      const distribution = new Distribution(
        new URL('http://example.org/data.csv'),
        'text/csv',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(true);
      expect(dumpResult.failureReason).toBeNull();
    });

    it('does not read the body when content validation is off', async () => {
      // The default: a successful HEAD settles reachability without a GET.
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: {
            'Content-Type': 'application/n-triples',
            'Content-Length': '50000',
          },
        }),
      ); // HEAD only

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution);

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // HEAD only
      expect(result).toBeInstanceOf(DataDumpProbeResult);
      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
    });

    it('falls back to GET for reachability when HEAD is unsupported', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 405 })) // HEAD not allowed
        .mockResolvedValueOnce(new Response('body', { status: 200 })); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(result).toBeInstanceOf(DataDumpProbeResult);
      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
    });
  });

  describe('bounded streaming body', () => {
    // A repeatable, syntactically valid N-Triples line.
    const triple =
      '<http://example.org/s> <http://example.org/p> <http://example.org/o> .\n';

    function headThenGet(getResponse: Response): void {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('', { status: 200, headers: { 'Content-Length': '0' } }),
        ) // HEAD: no size, forces the GET fallback
        .mockResolvedValueOnce(getResponse); // GET
    }

    it('reads a gzip-compressed data dump without downloading it in full', async () => {
      // TriplyDB serves .nq.gz dumps as a gzip body labelled application/n-quads
      // with Content-Length: 0 on HEAD. fetch does not inflate it (the payload is
      // a .gz file, not transport-encoded), so the probe must gunzip it itself.
      headThenGet(
        new Response(gzipSync(Buffer.from(triple)), {
          status: 200,
          headers: { 'Content-Type': 'application/n-quads' },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/download.nq.gz'),
        'application/n-quads',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(true);
      expect(dumpResult.failureReason).toBeNull();
    });

    it('confirms a large streamed dump from a bounded prefix', async () => {
      // A body far larger than the read cap, valid from the first line. The probe
      // must stop after the prefix and still see the leading triple.
      headThenGet(
        new Response(triple.repeat(15_000), {
          status: 200,
          headers: { 'Content-Type': 'application/n-triples' },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('inflates only a bounded prefix of a large gzip dump', async () => {
      // Decompresses to well beyond the cap; gunzip must stop at the cap and the
      // probe must still confirm the leading triple.
      headThenGet(
        new Response(gzipSync(Buffer.from(triple.repeat(15_000))), {
          status: 200,
          headers: { 'Content-Type': 'application/n-quads' },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/download.nq.gz'),
        'application/n-quads',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('does not flag a truncated prefix that yields no triple', async () => {
      // A body larger than the cap made only of comment lines: the parser reaches
      // the end of the prefix with no triple, and the read is truncated, so the
      // outcome is inconclusive — never an ‘empty distribution’ failure.
      headThenGet(
        new Response(
          '# a comment line that carries no triple\n'.repeat(8_000),
          {
            status: 200,
            headers: { 'Content-Type': 'application/n-triples' },
          },
        ),
      );

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('does not flag a parse error inside a truncated prefix', async () => {
      // A body larger than the cap whose prefix is broken N-Triples: a parse error
      // on a deliberately cut-off prefix must be inconclusive, not a faulty
      // distribution.
      headThenGet(
        new Response(
          '<http://example.org/s> <http://example.org/p'.repeat(8_000),
          {
            status: 200,
            headers: { 'Content-Type': 'application/n-triples' },
          },
        ),
      );

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('does not validate a truncated JSON-LD body', async () => {
      // JSON-LD is not streamable: a truncated prefix yields no triple, only an
      // ‘unclosed document’ error. A body larger than the cap is therefore
      // inconclusive — reachable, never a parse-error failure — and the doomed
      // parse is skipped entirely.
      const body =
        '{"@context":{"ex":"http://example.org/"},"@graph":[' +
        '{"@id":"ex:s","ex:p":"v"},'.repeat(12_000); // > cap, unterminated JSON
      headThenGet(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/ld+json' },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/data.jsonld'),
        'application/ld+json',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('does not flag a truncated gzip prefix that inflated nothing', async () => {
      // A gzip whose header carries an (unterminated) FNAME field larger than the
      // read cap: the compressed stream is cut mid-header, so nothing inflates.
      // Because we cut it ourselves — rather than holding a complete, broken body
      // — it is a truncated prefix (inconclusive), not a corrupt distribution.
      const header = Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 3]); // FLG=FNAME
      const unterminatedFilename = Buffer.alloc(300 * 1024, 0x41); // 'A', no NUL
      const body = Buffer.concat([header, unterminatedFilename]);
      expect(body.length).toBeGreaterThan(256 * 1024);
      headThenGet(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/n-quads' },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/download.nq.gz'),
        'application/n-quads',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('marks a complete corrupt gzip body as a failure', async () => {
      // Valid gzip magic and header, then an invalid deflate stream, delivered in
      // full (well under the read cap). We hold the whole compressed body and it
      // still will not inflate, so the distribution is faulty — not merely
      // inconclusive the way a prefix we cut ourselves would be.
      const corrupt = Buffer.from([
        0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 3, 9, 9, 9, 9,
      ]);
      headThenGet(
        new Response(corrupt, {
          status: 200,
          headers: { 'Content-Type': 'application/n-quads' },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/download.nq.gz'),
        'application/n-quads',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe('Distribution is not valid gzip');
    });

    it('marks a null-body response as empty', async () => {
      // A 200 with no body at all (a null stream) is a genuinely empty
      // distribution, not a truncated prefix.
      headThenGet(new Response(null, { status: 200 }));

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(false);
      expect(dumpResult.failureReason).toBe('Distribution is empty');
    });

    it('reports inconclusive when the validation budget elapses', async () => {
      // A body that never delivers a byte: reachability is settled by the HEAD,
      // so once the budget runs out the read is abandoned and the distribution is
      // reachable but unvalidated — never failed.
      const hangingBody = new ReadableStream<Uint8Array>(); // never enqueues
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(hangingBody, {
            status: 200,
            headers: { 'Content-Type': 'application/n-triples' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, {
        validateRdfContent: true,
        rdfValidationBudgetMs: 20,
      });

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('reports reachable when the validation GET cannot start', async () => {
      // HEAD proves reachability; a GET that then fails to return headers leaves
      // the distribution reachable but unvalidated, not down.
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD ok
        .mockRejectedValueOnce(new Error('connection reset')); // GET fails

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('reports inconclusive when the body stream errors', async () => {
      const erroringBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('stream broke'));
        },
      });
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(erroringBody, {
            status: 200,
            headers: { 'Content-Type': 'application/n-triples' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });

    it('does not parse a body served with a non-RDF content type', async () => {
      // Declared RDF, but the server answers text/plain — there is nothing the
      // RDF parser can validate, so the probe stays a (warning-only) success.
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response('not rdf', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution, VALIDATE_RDF);

      expect((result as DataDumpProbeResult).isSuccess()).toBe(true);
      expect((result as DataDumpProbeResult).failureReason).toBeNull();
    });
  });

  describe('JSON-LD remote @context', () => {
    // These exercise the real RDF parser fetching a JSON-LD @context over the
    // network, so they need the real global fetch rather than the suite stub and
    // their own origin servers.
    beforeEach(() => {
      vi.unstubAllGlobals();
    });

    async function startServer(
      handler: http.RequestListener,
    ): Promise<{ server: http.Server; origin: string }> {
      const server = http.createServer(handler);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as AddressInfo;
      return { server, origin: `http://127.0.0.1:${port}` };
    }

    it('treats a body with a resolvable remote context as success', async () => {
      const { server, origin } = await startServer((request, response) => {
        response.setHeader('Content-Type', 'application/ld+json');
        if (request.url === '/ctx') {
          response.end(JSON.stringify({ '@context': { ex: 'http://ex/' } }));
          return;
        }
        response.end(
          JSON.stringify({
            '@context': `${origin}/ctx`,
            '@id': 'http://ex/s',
            'ex:p': 'value',
          }),
        );
      });
      try {
        const result = await probe(
          new Distribution(
            new URL(`${origin}/data.jsonld`),
            'application/ld+json',
          ),
          VALIDATE_RDF,
        );
        const dumpResult = result as DataDumpProbeResult;
        expect(dumpResult.isSuccess()).toBe(true);
        expect(dumpResult.failureReason).toBeNull();
      } finally {
        server.close();
      }
    });

    it('does not flag a body whose remote context is unreachable', async () => {
      // Body resolves, but its @context points at a closed port.
      const { server, origin } = await startServer((_request, response) => {
        response.setHeader('Content-Type', 'application/ld+json');
        response.end(
          JSON.stringify({
            '@context': 'http://127.0.0.1:1/never',
            '@id': 'http://ex/s',
            'ex:p': 'value',
          }),
        );
      });
      try {
        const result = await probe(
          new Distribution(
            new URL(`${origin}/data.jsonld`),
            'application/ld+json',
          ),
          VALIDATE_RDF,
        );
        const dumpResult = result as DataDumpProbeResult;
        expect(dumpResult.isSuccess()).toBe(true);
        expect(dumpResult.failureReason).toBeNull();
      } finally {
        server.close();
      }
    });

    it('does not flag a body whose remote context times out', async () => {
      const heldResponses: http.ServerResponse[] = [];
      const { server, origin } = await startServer((request, response) => {
        if (request.url === '/ctx') {
          heldResponses.push(response); // never answered
          return;
        }
        response.setHeader('Content-Type', 'application/ld+json');
        response.end(
          JSON.stringify({
            '@context': `${origin}/ctx`,
            '@id': 'http://ex/s',
            'ex:p': 'value',
          }),
        );
      });
      try {
        const result = await probe(
          new Distribution(
            new URL(`${origin}/data.jsonld`),
            'application/ld+json',
          ),
          { timeoutMs: 200, ...VALIDATE_RDF },
        );
        const dumpResult = result as DataDumpProbeResult;
        expect(dumpResult.isSuccess()).toBe(true);
        expect(dumpResult.failureReason).toBeNull();
      } finally {
        heldResponses.forEach((response) => response.destroy());
        server.closeAllConnections?.();
        server.close();
      }
    });
  });

  describe('network error', () => {
    const sparqlOk = () =>
      new Response('{"results": {"bindings": []}}', {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });

    it('returns NetworkError on fetch failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'));

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 0 });

      expect(result).toBeInstanceOf(NetworkError);
      expect((result as NetworkError).message).toBe('Connection refused');
      expect((result as NetworkError).responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('does not retry when retries is 0', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'));

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 0 });

      expect(result).toBeInstanceOf(NetworkError);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('retries a transport error and succeeds on a later attempt', async () => {
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(sparqlOk());

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 1 });

      expect(result).toBeInstanceOf(SparqlProbeResult);
      expect((result as SparqlProbeResult).isSuccess()).toBe(true);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it('returns a NetworkError once retries are exhausted', async () => {
      const cause = Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      });
      vi.mocked(fetch).mockRejectedValue(
        Object.assign(new Error('fetch failed'), { cause }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 2 });

      expect(result).toBeInstanceOf(NetworkError);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    });

    it('includes the underlying error cause in the message', async () => {
      const cause = Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      });
      vi.mocked(fetch).mockRejectedValue(
        Object.assign(new Error('fetch failed'), { cause }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 0 });

      expect((result as NetworkError).message).toBe(
        'fetch failed (UND_ERR_SOCKET: other side closed)',
      );
    });

    it('reports a cause that carries no error code', async () => {
      vi.mocked(fetch).mockRejectedValue(
        Object.assign(new Error('fetch failed'), {
          cause: new Error('socket hang up'),
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 0 });

      expect((result as NetworkError).message).toBe(
        'fetch failed (socket hang up)',
      );
    });

    it('does not duplicate a cause whose message equals the error message', async () => {
      vi.mocked(fetch).mockRejectedValue(
        Object.assign(new Error('boom'), { cause: new Error('boom') }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 0 });

      expect((result as NetworkError).message).toBe('boom');
    });

    it('reports a non-Error cause', async () => {
      vi.mocked(fetch).mockRejectedValue(
        Object.assign(new Error('fetch failed'), { cause: 'ECONNRESET' }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 0 });

      expect((result as NetworkError).message).toBe(
        'fetch failed (ECONNRESET)',
      );
    });

    it('stringifies a non-Error rejection', async () => {
      vi.mocked(fetch).mockRejectedValue('catastrophe');

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 0 });

      expect((result as NetworkError).message).toBe('catastrophe');
    });

    it('does not retry an HTTP error response', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', { status: 500, statusText: 'Internal Server Error' }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 2 });

      expect(result).toBeInstanceOf(SparqlProbeResult);
      expect((result as SparqlProbeResult).isSuccess()).toBe(false);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('does not retry a content-validation failure', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('not json', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: 2 });

      expect(result).toBeInstanceOf(SparqlProbeResult);
      expect((result as SparqlProbeResult).failureReason).toBe(
        'SPARQL endpoint returned invalid JSON',
      );
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('falls back to the default when retries is not an integer', async () => {
      // A NaN/Infinity loop bound would otherwise skip the loop (never probing)
      // or never terminate; an invalid value must fall back to the default.
      vi.mocked(fetch).mockRejectedValue(new Error('fetch failed'));

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, {
        retries: Number.NaN,
      });

      expect(result).toBeInstanceOf(NetworkError);
      // Default is 2 retries → 3 attempts; crucially, fetch IS called.
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    });

    it('clamps a negative retry count to zero', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('fetch failed'));

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { retries: -5 });

      expect(result).toBeInstanceOf(NetworkError);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('reports the total time spent across attempts on a NetworkError', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('fetch failed'));

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = (await probe(distribution, {
        retries: 2,
      })) as NetworkError;

      // Three attempts with 250ms + 500ms backoff between them: the reported
      // time spans the whole check, not just the final attempt.
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(700);
    });
  });

  describe('options', () => {
    it('accepts ProbeOptions with timeoutMs', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, { timeoutMs: 1000 });

      expect(result).toBeInstanceOf(SparqlProbeResult);
    });
  });

  describe('URL-embedded Basic auth', () => {
    it('moves user:pass from URL into Authorization header (SPARQL)', async () => {
      let capturedUrl: string | undefined;
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        capturedUrl =
          typeof input === 'string' ? input : (input as URL).toString();
        capturedHeaders = new Headers(init?.headers);
        return new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://alice:secret@example.org/sparql'),
      );

      await probe(distribution);

      expect(capturedUrl).toBe('http://example.org/sparql');
      expect(capturedHeaders?.get('Authorization')).toBe(
        `Basic ${Buffer.from('alice:secret').toString('base64')}`,
      );
    });

    it('decodes URL-encoded credentials', async () => {
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://user%40domain:p%40ss@example.org/sparql'),
      );

      await probe(distribution);

      expect(capturedHeaders?.get('Authorization')).toBe(
        `Basic ${Buffer.from('user@domain:p@ss').toString('base64')}`,
      );
    });

    it('applies URL auth to data-dump probes too', async () => {
      let capturedUrl: string | undefined;
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        capturedUrl =
          typeof input === 'string' ? input : (input as URL).toString();
        capturedHeaders = new Headers(init?.headers);
        return new Response('', {
          status: 200,
          headers: {
            'Content-Type': 'application/n-triples',
            'Content-Length': '50000',
          },
        });
      });

      const distribution = new Distribution(
        new URL('http://alice:secret@example.org/data.nt'),
        'application/n-triples',
      );

      await probe(distribution);

      expect(capturedUrl).toBe('http://example.org/data.nt');
      expect(capturedHeaders?.get('Authorization')).toBe(
        `Basic ${Buffer.from('alice:secret').toString('base64')}`,
      );
    });

    it('does not overwrite a caller-supplied Authorization header', async () => {
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      });

      const callerHeaders = new Headers({
        Authorization: 'Bearer caller-token',
      });
      const distribution = Distribution.sparql(
        new URL('http://alice:secret@example.org/sparql'),
      );

      await probe(distribution, { headers: callerHeaders });

      expect(capturedHeaders?.get('Authorization')).toBe('Bearer caller-token');
    });
  });

  describe('custom headers', () => {
    it('merges caller headers with probe-generated ones', async () => {
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      await probe(distribution, {
        headers: new Headers({ 'User-Agent': 'TestAgent/1.0' }),
      });

      expect(capturedHeaders?.get('User-Agent')).toBe('TestAgent/1.0');
      expect(capturedHeaders?.get('Accept')).toBe(
        'application/sparql-results+json, application/sparql-results+xml;q=0.9',
      );
    });

    it('lets caller headers override probe-generated Accept', async () => {
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      await probe(distribution, {
        headers: new Headers({ Accept: 'application/sparql-results+xml' }),
      });

      expect(capturedHeaders?.get('Accept')).toBe(
        'application/sparql-results+xml',
      );
    });
  });

  describe('custom SPARQL query', () => {
    it('uses the supplied query instead of the default', async () => {
      let capturedBody: string | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedBody = init?.body?.toString();
        return new Response('{"boolean": true}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, {
        sparqlQuery: 'ASK { ?s ?p ?o }',
      });

      expect(capturedBody).toContain(encodeURIComponent('ASK { ?s ?p ?o }'));
      expect((result as SparqlProbeResult).isSuccess()).toBe(true);
    });

    it('validates ASK response body', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('{"results": {}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, {
        sparqlQuery: 'ASK { ?s ?p ?o }',
      });

      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(false);
      expect(sparqlResult.failureReason).toBe(
        'SPARQL endpoint did not return a valid ASK result',
      );
    });

    it('requests an RDF media type for CONSTRUCT queries', async () => {
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('<http://s> <http://p> <http://o> .\n', {
          status: 200,
          headers: { 'Content-Type': 'application/n-triples' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, {
        sparqlQuery: 'CONSTRUCT WHERE { ?s ?p ?o } LIMIT 1',
      });

      expect(capturedHeaders?.get('Accept')).toContain('application/n-triples');
      expect((result as SparqlProbeResult).isSuccess()).toBe(true);
    });

    it('accepts an empty graph as a successful CONSTRUCT answer', async () => {
      // A CONSTRUCT availability probe whose query matches nothing returns a
      // 200 with an empty body; the endpoint is up, so this must not fail.
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/n-triples' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, {
        sparqlQuery: 'CONSTRUCT WHERE { ?s ?p ?o } LIMIT 1',
      });

      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(true);
      expect(sparqlResult.failureReason).toBeNull();
    });

    it('accepts a CONSTRUCT answer serialized as Turtle', async () => {
      // The endpoint chooses the RDF serialization; Turtle is a common default
      // and must be accepted, not only n-triples.
      vi.mocked(fetch).mockResolvedValue(
        new Response('<http://s> <http://p> <http://o> .', {
          status: 200,
          headers: { 'Content-Type': 'text/turtle' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution, {
        sparqlQuery: 'CONSTRUCT WHERE { ?s ?p ?o } LIMIT 1',
      });

      const sparqlResult = result as SparqlProbeResult;
      expect(sparqlResult.isSuccess()).toBe(true);
      expect(sparqlResult.failureReason).toBeNull();
    });

    it('offers several RDF serializations in the CONSTRUCT Accept header', async () => {
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('<http://s> <http://p> <http://o> .', {
          status: 200,
          headers: { 'Content-Type': 'text/turtle' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      await probe(distribution, {
        sparqlQuery: 'CONSTRUCT WHERE { ?s ?p ?o } LIMIT 1',
      });

      const accept = capturedHeaders?.get('Accept');
      expect(accept).toContain('text/turtle');
      expect(accept).toContain('application/n-triples');
      expect(accept).toContain('application/rdf+xml');
    });

    it('ignores # comments when detecting query type', async () => {
      let capturedHeaders: Headers | undefined;
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('{"boolean": true}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      await probe(distribution, {
        sparqlQuery: '# SELECT is in a comment\nASK { ?s ?p ?o }',
      });

      expect(capturedHeaders?.get('Accept')).toBe(
        'application/sparql-results+json, application/sparql-results+xml;q=0.9',
      );
    });
  });

  describe('responseTimeMs', () => {
    it('is set on SparqlProbeResult', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('{"results": {"bindings": []}}', {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }),
      );

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = (await probe(distribution)) as SparqlProbeResult;

      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.responseTimeMs)).toBe(true);
    });

    it('is set on DataDumpProbeResult', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 200,
          headers: {
            'Content-Type': 'application/n-triples',
            'Content-Length': '50000',
          },
        }),
      );

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = (await probe(distribution)) as DataDumpProbeResult;

      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.responseTimeMs)).toBe(true);
    });

    it('is set on NetworkError', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'));

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = (await probe(distribution)) as NetworkError;

      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.responseTimeMs)).toBe(true);
    });
  });

  describe('Content-Type mismatch', () => {
    const gzippedNQuads = () => {
      const distribution = new Distribution(
        new URL('http://example.org/data.nq.gz'),
        IANA_MEDIA_TYPE_PREFIX + 'application/n-quads',
      );
      distribution.compressFormat = IANA_MEDIA_TYPE_PREFIX + 'application/gzip';
      return distribution;
    };

    const headResponse = (contentType: string) =>
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': contentType, 'Content-Length': '12345' },
        }),
      );

    it('accepts the declared compressed type for a gzipped distribution', async () => {
      headResponse('application/n-quads+gzip');

      const result = (await probe(gzippedNQuads())) as DataDumpProbeResult;

      expect(result.isSuccess()).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it('accepts the bare media type when the server decompressed the body', async () => {
      headResponse('application/n-quads');

      const result = (await probe(gzippedNQuads())) as DataDumpProbeResult;

      expect(result.isSuccess()).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it('flags the wrong compression format on a gzipped distribution', async () => {
      headResponse('application/n-quads+zip');

      const result = (await probe(gzippedNQuads())) as DataDumpProbeResult;

      expect(result.warnings).toContain(
        'Server Content-Type application/n-quads+zip does not match declared media type application/n-quads+gzip',
      );
    });

    it('flags the wrong base serialization on a gzipped distribution', async () => {
      headResponse('text/turtle+gzip');

      const result = (await probe(gzippedNQuads())) as DataDumpProbeResult;

      expect(result.warnings).toContain(
        'Server Content-Type text/turtle+gzip does not match declared media type application/n-quads+gzip',
      );
    });

    it('does not warn for an uncompressed distribution served as declared', async () => {
      headResponse('application/n-quads');

      const distribution = new Distribution(
        new URL('http://example.org/data.nq'),
        IANA_MEDIA_TYPE_PREFIX + 'application/n-quads',
      );
      const result = (await probe(distribution)) as DataDumpProbeResult;

      expect(result.isSuccess()).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it('warns when an uncompressed distribution is served as a different type', async () => {
      headResponse('text/turtle');

      const distribution = new Distribution(
        new URL('http://example.org/data.nq'),
        IANA_MEDIA_TYPE_PREFIX + 'application/n-quads',
      );
      const result = (await probe(distribution)) as DataDumpProbeResult;

      expect(result.warnings).toContain(
        'Server Content-Type text/turtle does not match declared media type application/n-quads',
      );
    });
  });
});

describe('probeMany', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A plain (non-RDF) media type keeps each probe reachability-only: a single
  // HEAD, so the in-flight count tracked in the fetch mock reflects the
  // scheduler’s task concurrency rather than HEAD/GET timing.
  const dataDump = (host: string, index: number): Distribution =>
    new Distribution(new URL(`https://${host}/d-${index}`), 'application/pdf');

  const okResponse = (): Response =>
    new Response('', {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });

  it('returns one result per distribution, in input order', async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse());

    const distributions = [
      dataDump('host-a.example', 0),
      dataDump('host-b.example', 0),
      dataDump('host-c.example', 0),
    ];

    const results = await probeMany(distributions);

    expect(results).toHaveLength(3);
    expect(
      results.map((result) => (result as DataDumpProbeResult).url),
    ).toEqual([
      'https://host-a.example/d-0',
      'https://host-b.example/d-0',
      'https://host-c.example/d-0',
    ]);
  });

  it('returns an empty array for no distributions', async () => {
    expect(await probeMany([])).toEqual([]);
  });

  it('falls back to the default budget for a non-positive or non-integer limit', async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse());

    // 0, negative, fractional, and NaN are invalid budgets. Without clamping these
    // stall the scheduler so the promise never resolves; each must now fall back to
    // the default and complete.
    for (const invalid of [0, -1, 2.5, Number.NaN]) {
      const results = await probeMany([dataDump('host-a.example', 0)], {
        concurrency: invalid,
        perHostConcurrency: invalid,
      });
      expect(results).toHaveLength(1);
    }
  });

  it('keys an authority-less URL by its full href', async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse());

    // A urn: has no host, so the scheduler falls back to the full href as its
    // per-host key rather than bucketing every authority-less URL together.
    const distributions = [
      new Distribution(new URL('urn:example:a'), 'application/pdf'),
      new Distribution(new URL('urn:example:b'), 'application/pdf'),
    ];

    const results = await probeMany(distributions, { perHostConcurrency: 1 });

    expect(results).toHaveLength(2);
    expect(
      results.every((result) => result instanceof DataDumpProbeResult),
    ).toBe(true);
  });

  it('caps in-flight probes per host while probing other hosts in parallel', async () => {
    const perHostConcurrency = 2;
    const perHostCount = 8;
    const inFlight = new Map<string, number>();
    const peakPerHost = new Map<string, number>();
    let totalInFlight = 0;
    let peakTotal = 0;

    vi.mocked(fetch).mockImplementation(async (input) => {
      const host = new URL(String(input)).host;
      const next = (inFlight.get(host) ?? 0) + 1;
      inFlight.set(host, next);
      peakPerHost.set(host, Math.max(peakPerHost.get(host) ?? 0, next));
      totalInFlight++;
      peakTotal = Math.max(peakTotal, totalInFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight.set(host, (inFlight.get(host) ?? 0) - 1);
      totalInFlight--;
      return okResponse();
    });

    const distributions: Distribution[] = [];
    for (let index = 0; index < perHostCount; index++) {
      distributions.push(dataDump('host-a.example', index));
      distributions.push(dataDump('host-b.example', index));
    }

    const results = await probeMany(distributions, {
      concurrency: 20,
      perHostConcurrency,
    });

    expect(results).toHaveLength(perHostCount * 2);
    // Neither host is probed beyond its per-host budget …
    expect(peakPerHost.get('host-a.example')).toBeLessThanOrEqual(
      perHostConcurrency,
    );
    expect(peakPerHost.get('host-b.example')).toBeLessThanOrEqual(
      perHostConcurrency,
    );
    // … yet both hosts run at once, so a saturated host never idles the global pool.
    expect(peakTotal).toBeGreaterThan(perHostConcurrency);
  });

  it('caps total in-flight probes at the global concurrency', async () => {
    const concurrency = 3;
    let totalInFlight = 0;
    let peakTotal = 0;

    vi.mocked(fetch).mockImplementation(async () => {
      totalInFlight++;
      peakTotal = Math.max(peakTotal, totalInFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      totalInFlight--;
      return okResponse();
    });

    // Each distribution on a distinct host, so only the global cap can bind.
    const distributions = Array.from({ length: 9 }, (_unused, index) =>
      dataDump(`host-${index}.example`, index),
    );

    await probeMany(distributions, { concurrency, perHostConcurrency: 10 });

    expect(peakTotal).toBeLessThanOrEqual(concurrency);
    expect(peakTotal).toBeGreaterThan(0);
  });
});
