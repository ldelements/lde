import {
  deduplicateQuads,
  SparqlConstructExecutor,
  LineBufferTransform,
  readQueryFile,
} from '../../src/sparql/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { DataFactory } from 'n3';
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const { namedNode } = DataFactory;

describe('SparqlConstructExecutor', () => {
  const port = 3003;

  beforeAll(async () => {
    await startSparqlEndpoint(port, 'test/fixtures/analysisTarget.trig');
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  describe('constructor', () => {
    it('throws on a non-CONSTRUCT query', () => {
      expect(
        () =>
          new SparqlConstructExecutor({
            query: 'SELECT ?s WHERE { ?s ?p ?o }',
          }),
      ).toThrow('Query must be a CONSTRUCT query');
    });

    it('does not throw when query contains #subjectFilter# (deferred parsing)', () => {
      expect(
        () =>
          new SparqlConstructExecutor({
            query: `CONSTRUCT { ?s ?p ?o } WHERE { #subjectFilter# ?s ?p ?o }`,
          }),
      ).not.toThrow();
    });
  });

  describe('execute', () => {
    it('executes query and returns stream', async () => {
      const datasetIri = 'http://foo.org/id/dataset/foo';

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT {
          ?dataset ?p ?o .
        }
        WHERE {
          <${datasetIri}> ?p ?o .
        }`,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
        'http://foo.org/id/graph/foo',
      );

      const dataset = new Dataset({
        iri: new URL(datasetIri),
        distributions: [distribution],
      });

      const result = await executor.execute(dataset, distribution);

      const quads = [];
      for await (const quad of result) {
        quads.push(quad);
      }
      expect(quads.length).toBe(2);
    });

    it('adds FROM clause via withDefaultGraph when distribution has a named graph', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT {
          ?dataset ?p ?o .
        }
        WHERE {
          ?dataset ?p ?o .
        }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
        'http://foo.org/id/graph/foo',
      );

      const datasetIri = 'http://foo.org/id/dataset/foo';
      const dataset = new Dataset({
        iri: new URL(datasetIri),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        `http://localhost:${port}/sparql`,
        expect.stringContaining('FROM <http://foo.org/id/graph/foo>'),
      );
    });

    it('substitutes ?dataset with dataset IRI', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?dataset ?p ?o } WHERE { ?dataset ?p ?o }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );

      const datasetIri = 'http://foo.org/id/dataset/foo';
      const dataset = new Dataset({
        iri: new URL(datasetIri),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining(`<${datasetIri}>`),
      );
      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('?dataset'),
      );
    });

    it('uses distribution accessUrl as endpoint', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 1`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        `http://localhost:${port}/sparql`,
        expect.any(String),
      );
    });
  });

  describe('#subjectFilter# template', () => {
    it('substitutes #subjectFilter# with distribution.subjectFilter at execute time', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { #subjectFilter# ?s ?p ?o }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );
      distribution.subjectFilter = 'FILTER(?s = <http://example.org/s>)';

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('FILTER'),
      );
    });

    it('substitutes all occurrences of #subjectFilter#', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { { #subjectFilter# ?s ?p ?o } UNION { #subjectFilter# ?s ?p ?o } }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );
      distribution.subjectFilter = 'FILTER(?s = <http://example.org/s>)';

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      const query = querySpy.mock.calls[0][1];
      const filterCount = (query.match(/FILTER/g) ?? []).length;
      expect(filterCount).toBe(2);
      expect(query).not.toContain('#subjectFilter#');
    });

    it('substitutes #subjectFilter# with empty string when subjectFilter is undefined', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { #subjectFilter# ?s ?p ?o }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('#subjectFilter#'),
      );
    });
  });

  describe('bindings', () => {
    it('injects a VALUES clause when bindings are provided', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution, {
        bindings: [{ s: namedNode('http://example.org/subject') }],
      });

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('VALUES'),
      );
      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('<http://example.org/subject>'),
      );
    });

    it('does not inject a VALUES clause without bindings', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('VALUES'),
      );
    });

    it('does not inject a VALUES clause when bindings array is empty', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution, { bindings: [] });

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('VALUES'),
      );
    });
  });

  describe('retry', () => {
    it('retries on 504 and succeeds on second attempt', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const spy = vi
        .spyOn(fetcher, 'fetchTriples')
        .mockRejectedValueOnce(
          new Error(
            'Invalid SPARQL endpoint response from http://example.org/sparql (HTTP status 504):\nGateway Timeout',
          ),
        )
        .mockResolvedValueOnce(
          // Resolved value is consumed as AsyncIterable<Quad>.
          [] as never,
        );

      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('does not retry on 400 error', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(
        new Error(
          'Invalid SPARQL endpoint response from http://example.org/sparql (HTTP status 400):\nBad Request',
        ),
      );

      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await expect(executor.execute(dataset, distribution)).rejects.toThrow(
        'HTTP status 400',
      );
      expect(fetcher.fetchTriples).toHaveBeenCalledTimes(1);
    });

    it('retries on network error (fetch failed) and succeeds on second attempt', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const spy = vi
        .spyOn(fetcher, 'fetchTriples')
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce([] as never);

      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('retries on ECONNRESET', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const connectionError = new TypeError('fetch failed');
      connectionError.cause = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      });
      const spy = vi
        .spyOn(fetcher, 'fetchTriples')
        .mockRejectedValueOnce(connectionError)
        .mockResolvedValueOnce([] as never);

      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('propagates error when retries are exhausted', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(
        new Error(
          'Invalid SPARQL endpoint response from http://example.org/sparql (HTTP status 502):\nBad Gateway',
        ),
      );

      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        retries: 2,
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await expect(executor.execute(dataset, distribution)).rejects.toThrow(
        'HTTP status 502',
      );
      // 1 initial attempt + 2 retries = 3 calls.
      expect(fetcher.fetchTriples).toHaveBeenCalledTimes(3);
    });
  });

  describe('lineBuffer', () => {
    it('returns quads when lineBuffer is enabled', async () => {
      const datasetIri = 'http://foo.org/id/dataset/foo';

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT {
          ?dataset ?p ?o .
        }
        WHERE {
          <${datasetIri}> ?p ?o .
        }`,
        lineBuffer: true,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
        'http://foo.org/id/graph/foo',
      );

      const dataset = new Dataset({
        iri: new URL(datasetIri),
        distributions: [distribution],
      });

      const result = await executor.execute(dataset, distribution);

      const quads = [];
      for await (const quad of result) {
        quads.push(quad);
      }
      expect(quads.length).toBe(2);
    });

    it('uses fetchRawStream instead of fetchTriples', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const triplesSpy = vi.spyOn(fetcher, 'fetchTriples');
      const rawSpy = vi.spyOn(fetcher, 'fetchRawStream');

      const executor = new SparqlConstructExecutor({
        query: `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 1`,
        fetcher,
        lineBuffer: true,
      });

      const distribution = Distribution.sparql(
        new URL(`http://localhost:${port}/sparql`),
      );

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      await executor.execute(dataset, distribution);

      expect(triplesSpy).not.toHaveBeenCalled();
      expect(rawSpy).toHaveBeenCalled();
    });
  });

  describe('deduplicate', () => {
    it('removes duplicate quads from CONSTRUCT output', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const q = DataFactory.quad(
        namedNode('http://example.org/s'),
        namedNode('http://example.org/p'),
        namedNode('http://example.org/o'),
      );
      vi.spyOn(fetcher, 'fetchTriples').mockResolvedValue(
        (async function* () {
          yield q;
          yield q;
          yield q;
        })() as never,
      );

      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
        deduplicate: true,
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      const result = await executor.execute(dataset, distribution);
      const quads = [];
      for await (const quad of result) {
        quads.push(quad);
      }

      expect(quads).toHaveLength(1);
    });

    it('does not deduplicate when option is false', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const q = DataFactory.quad(
        namedNode('http://example.org/s'),
        namedNode('http://example.org/p'),
        namedNode('http://example.org/o'),
      );
      vi.spyOn(fetcher, 'fetchTriples').mockResolvedValue(
        (async function* () {
          yield q;
          yield q;
        })() as never,
      );

      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });

      const distribution = Distribution.sparql(
        new URL('http://example.org/sparql'),
      );
      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });

      const result = await executor.execute(dataset, distribution);
      const quads = [];
      for await (const quad of result) {
        quads.push(quad);
      }

      expect(quads).toHaveLength(2);
    });
  });

  describe('fromFile', () => {
    it('creates executor from a file', async () => {
      const executor = await SparqlConstructExecutor.fromFile(
        'test/fixtures/query.rq',
      );

      expect(executor).toBeInstanceOf(SparqlConstructExecutor);
    });
  });

  describe('timeout policy', () => {
    function recordingPolicy() {
      const before = vi.fn().mockReturnValue(1234);
      const after = vi.fn();
      return {
        beforeRequest: before,
        afterRequest: after,
      };
    }

    function makeDistribution(url = 'http://policy.example.org/sparql') {
      return Distribution.sparql(new URL(url));
    }

    function makeDataset(distribution: Distribution) {
      return new Dataset({
        iri: new URL('http://example.org/dataset'),
        distributions: [distribution],
      });
    }

    it('calls beforeRequest and afterRequest({outcome: "ok"}) on success', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockResolvedValue([] as never);

      const policy = recordingPolicy();
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });

      const distribution = makeDistribution();
      await executor.execute(makeDataset(distribution), distribution, {
        timeout: policy,
      });

      expect(policy.beforeRequest).toHaveBeenCalledTimes(1);
      expect(policy.beforeRequest).toHaveBeenCalledWith({
        endpoint: distribution.accessUrl,
      });
      expect(policy.afterRequest).toHaveBeenCalledTimes(1);
      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: distribution.accessUrl,
          outcome: 'ok',
        }),
      );
    });

    it('classifies HTTP 504 as outcome "timeout"', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(
        new Error(
          'Invalid SPARQL endpoint response from http://policy.example.org/sparql (HTTP status 504):\nGateway Timeout',
        ),
      );

      const policy = recordingPolicy();
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
        retries: 0,
      });
      const distribution = makeDistribution();

      await expect(
        executor.execute(makeDataset(distribution), distribution, {
          timeout: policy,
        }),
      ).rejects.toThrow('504');

      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timeout' }),
      );
    });

    it('classifies AbortError as outcome "timeout"', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(abortError);

      const policy = recordingPolicy();
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
        retries: 0,
      });
      const distribution = makeDistribution();

      await expect(
        executor.execute(makeDataset(distribution), distribution, {
          timeout: policy,
        }),
      ).rejects.toThrow();

      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timeout' }),
      );
    });

    it('classifies TimeoutError (AbortSignal.timeout) as outcome "timeout"', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const timeoutError = new Error('The operation timed out');
      timeoutError.name = 'TimeoutError';
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(timeoutError);

      const policy = recordingPolicy();
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
        retries: 0,
      });
      const distribution = makeDistribution();

      await expect(
        executor.execute(makeDataset(distribution), distribution, {
          timeout: policy,
        }),
      ).rejects.toThrow();

      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timeout' }),
      );
    });

    it('classifies HTTP 400 as outcome "error" (neutral)', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(
        new Error(
          'Invalid SPARQL endpoint response from http://policy.example.org/sparql (HTTP status 400):\nBad Request',
        ),
      );

      const policy = recordingPolicy();
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
        retries: 0,
      });
      const distribution = makeDistribution();

      await expect(
        executor.execute(makeDataset(distribution), distribution, {
          timeout: policy,
        }),
      ).rejects.toThrow();

      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error' }),
      );
    });

    it('invokes the policy per attempt inside pRetry', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples')
        .mockRejectedValueOnce(
          new Error(
            'Invalid SPARQL endpoint response from http://policy.example.org/sparql (HTTP status 504):\nGateway Timeout',
          ),
        )
        .mockResolvedValueOnce([] as never);

      const policy = recordingPolicy();
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      await executor.execute(makeDataset(distribution), distribution, {
        timeout: policy,
      });

      expect(policy.beforeRequest).toHaveBeenCalledTimes(2);
      expect(policy.afterRequest).toHaveBeenCalledTimes(2);
      expect(policy.afterRequest).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ outcome: 'timeout' }),
      );
      expect(policy.afterRequest).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ outcome: 'ok' }),
      );
    });

    it('falls back to the executor-level policy when ExecuteOptions omits one', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockResolvedValue([] as never);

      const policy = recordingPolicy();
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
        timeout: policy,
      });
      const distribution = makeDistribution();

      await executor.execute(makeDataset(distribution), distribution);

      expect(policy.beforeRequest).toHaveBeenCalledTimes(1);
      expect(policy.afterRequest).toHaveBeenCalledTimes(1);
    });

    it('aborts the underlying fetch when the policy budget elapses', async () => {
      const slowFetch = vi
        .fn<
          (input: Request | string, init?: RequestInit) => Promise<Response>
        >()
        .mockImplementation((_input, init) => {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          });
        });
      const fetcher = new SparqlEndpointFetcher({
        fetch: slowFetch,
        timeout: 10,
      });

      const policy = {
        beforeRequest: vi.fn().mockReturnValue(10),
        afterRequest: vi.fn(),
      };
      const executor = new SparqlConstructExecutor({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
        retries: 0,
      });
      const distribution = makeDistribution();

      await expect(
        executor.execute(makeDataset(distribution), distribution, {
          timeout: policy,
        }),
      ).rejects.toThrow();

      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timeout' }),
      );
      expect(slowFetch).toHaveBeenCalled();
      const init = slowFetch.mock.calls[0][1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

describe('LineBufferTransform', () => {
  async function collect(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString();
  }

  it('passes complete lines through', async () => {
    const transform = new LineBufferTransform();
    const input = Readable.from([
      '<s> <p> "hello"@nl .\n<s> <p> "world"@en .\n',
    ]);
    const result = await collect(input.pipe(transform));
    expect(result).toBe('<s> <p> "hello"@nl .\n<s> <p> "world"@en .\n');
  });

  it('buffers a line split across chunks', async () => {
    const transform = new LineBufferTransform();
    // Simulate a language tag split across chunk boundaries
    const input = Readable.from(['<s> <p> "hallo"@', 'nl-nl .\n']);
    const result = await collect(input.pipe(transform));
    expect(result).toBe('<s> <p> "hallo"@nl-nl .\n');
  });

  it('flushes a trailing partial line on end', async () => {
    const transform = new LineBufferTransform();
    const input = Readable.from(['<s> <p> "no newline"']);
    const result = await collect(input.pipe(transform));
    expect(result).toBe('<s> <p> "no newline"');
  });

  it('handles multiple chunks with interleaved splits', async () => {
    const transform = new LineBufferTransform();
    const input = Readable.from([
      '<a> <b> "één"@',
      'nl .\n<c> <d> "tw',
      'ee"@nl .\n',
    ]);
    const result = await collect(input.pipe(transform));
    expect(result).toBe('<a> <b> "één"@nl .\n<c> <d> "twee"@nl .\n');
  });
});

describe('deduplicateQuads', () => {
  const { namedNode, literal, blankNode, quad } = DataFactory;

  async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterable) {
      items.push(item);
    }
    return items;
  }

  it('removes duplicate quads', async () => {
    const q1 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o'),
    );
    const q2 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o'),
    );

    async function* source() {
      yield q1;
      yield q2;
    }

    const result = await collect(deduplicateQuads(source()));
    expect(result).toHaveLength(1);
  });

  it('preserves distinct quads', async () => {
    const q1 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o1'),
    );
    const q2 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o2'),
    );

    async function* source() {
      yield q1;
      yield q2;
    }

    const result = await collect(deduplicateQuads(source()));
    expect(result).toHaveLength(2);
  });

  it('distinguishes literals by language tag', async () => {
    const q1 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      literal('hello', 'en'),
    );
    const q2 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      literal('hello', 'nl'),
    );

    async function* source() {
      yield q1;
      yield q2;
    }

    const result = await collect(deduplicateQuads(source()));
    expect(result).toHaveLength(2);
  });

  it('distinguishes literals by datatype', async () => {
    const q1 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      literal('42', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
    );
    const q2 = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      literal('42', namedNode('http://www.w3.org/2001/XMLSchema#decimal')),
    );

    async function* source() {
      yield q1;
      yield q2;
    }

    const result = await collect(deduplicateQuads(source()));
    expect(result).toHaveLength(2);
  });

  it('deduplicates blank nodes by label', async () => {
    const q1 = quad(
      blankNode('b0'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o'),
    );
    const q2 = quad(
      blankNode('b0'),
      namedNode('http://example.org/p'),
      namedNode('http://example.org/o'),
    );

    async function* source() {
      yield q1;
      yield q2;
    }

    const result = await collect(deduplicateQuads(source()));
    expect(result).toHaveLength(1);
  });

  it('handles an empty stream', async () => {
    async function* source() {
      // empty
    }

    const result = await collect(deduplicateQuads(source()));
    expect(result).toHaveLength(0);
  });
});

describe('readQueryFile', () => {
  it('reads query from file', async () => {
    const query = await readQueryFile('test/fixtures/query.rq');

    expect(query).toContain('CONSTRUCT');
  });
});
