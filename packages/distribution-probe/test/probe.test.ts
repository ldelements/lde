import {
  probe,
  SparqlProbeResult,
  DataDumpProbeResult,
  NetworkError,
} from '../src/index.js';
import { Distribution, IANA_MEDIA_TYPE_PREFIX } from '@lde/dataset';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

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

    it('retries with GET if HEAD returns no Content-Length', async () => {
      const body =
        '<http://example.org/s> <http://example.org/p> <http://example.org/o> .\n';
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('', {
            status: 200,
            headers: { 'Content-Length': '0' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: {
              'Content-Length': '5000',
              'Content-Type': 'application/n-triples',
            },
          }),
        );

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution);

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(result).toBeInstanceOf(DataDumpProbeResult);
      expect((result as DataDumpProbeResult).contentSize).toBe(5000);
    });

    it('marks zero-byte response as failure', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(new Response('', { status: 200 })); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.nt'),
        'application/n-triples',
      );

      const result = await probe(distribution);

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

      const result = await probe(distribution);

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

      const result = await probe(distribution);

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

      const result = await probe(distribution);

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

      const result = await probe(distribution);

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

      const result = await probe(distribution);

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

      const result = await probe(distribution);

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

      const result = await probe(distribution);

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

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(true);
      expect(dumpResult.failureReason).toBeNull();
    });

    it('does not validate a non-RDF body', async () => {
      const body = 'id,name\n1,Alice\n';
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // HEAD
        .mockResolvedValueOnce(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/csv' },
          }),
        ); // GET

      const distribution = new Distribution(
        new URL('http://example.org/data.csv'),
        'text/csv',
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(DataDumpProbeResult);
      const dumpResult = result as DataDumpProbeResult;
      expect(dumpResult.isSuccess()).toBe(true);
      expect(dumpResult.failureReason).toBeNull();
    });

    it('skips body validation for large files', async () => {
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
          { timeoutMs: 200 },
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
    it('returns NetworkError on fetch failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'));

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );

      const result = await probe(distribution);

      expect(result).toBeInstanceOf(NetworkError);
      expect((result as NetworkError).message).toBe('Connection refused');
      expect((result as NetworkError).responseTimeMs).toBeGreaterThanOrEqual(0);
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
