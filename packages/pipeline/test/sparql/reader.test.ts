import {
  deduplicateQuads,
  SparqlConstructReader,
  LineBufferTransform,
  readQueryFile,
} from '../../src/sparql/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { DataFactory } from 'n3';
import type { HostLimiter } from '@lde/host-limiter';
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const { namedNode } = DataFactory;

describe('SparqlConstructReader', () => {
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
          new SparqlConstructReader({
            query: 'SELECT ?s WHERE { ?s ?p ?o }',
          }),
      ).toThrow('Query must be a CONSTRUCT query');
    });

    it('does not throw when query contains #subjectFilter# (deferred parsing)', () => {
      expect(
        () =>
          new SparqlConstructReader({
            query: `CONSTRUCT { ?s ?p ?o } WHERE { #subjectFilter# ?s ?p ?o }`,
          }),
      ).not.toThrow();
    });
  });

  describe('read', () => {
    it('executes query and returns stream', async () => {
      const datasetIri = 'http://foo.org/id/dataset/foo';

      const reader = new SparqlConstructReader({
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

      const result = await reader.read(dataset, distribution);

      const quads = [];
      for await (const quad of result) {
        quads.push(quad);
      }
      expect(quads.length).toBe(2);
    });

    it('adds FROM clause via withDefaultGraph when distribution has a named graph', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        `http://localhost:${port}/sparql`,
        expect.stringContaining('FROM <http://foo.org/id/graph/foo>'),
      );
    });

    it('substitutes ?dataset with dataset IRI', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

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

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        `http://localhost:${port}/sparql`,
        expect.any(String),
      );
    });
  });

  describe('#subjectFilter# template', () => {
    it('substitutes #subjectFilter# with distribution.subjectFilter at read time', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('FILTER'),
      );
    });

    it('substitutes all occurrences of #subjectFilter#', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

      const query = querySpy.mock.calls[0][1];
      const filterCount = (query.match(/FILTER/g) ?? []).length;
      expect(filterCount).toBe(2);
      expect(query).not.toContain('#subjectFilter#');
    });

    it('substitutes #subjectFilter# with empty string when subjectFilter is undefined', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

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

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution, {
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

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('VALUES'),
      );
    });

    it('does not inject a VALUES clause when bindings array is empty', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const querySpy = vi.spyOn(fetcher, 'fetchTriples');

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution, { bindings: [] });

      expect(querySpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('VALUES'),
      );
    });
  });

  describe('when the endpoint fails', () => {
    const endpoint = 'http://example.org/sparql';
    const distribution = Distribution.sparql(new URL(endpoint));
    // On another host than its endpoint, as on LDMax.
    const dataset = new Dataset({
      iri: new URL('http://data.example.com/dataset'),
      distributions: [distribution],
    });
    const query = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    const httpError = (status: number) =>
      new Error(
        `Invalid SPARQL endpoint response from ${endpoint} (HTTP status ${status}):\nbody`,
      );
    const connectionReset = () =>
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
        }),
      });
    const secondsUntil = (untilMs: number) =>
      Math.round((untilMs - Date.now()) / 1000);

    it.each([
      ['HTTP 502', () => httpError(502)],
      ['HTTP 503', () => httpError(503)],
      ['HTTP 504', () => httpError(504)],
      ['a network error', () => new TypeError('fetch failed')],
      ['a reset connection', connectionReset],
    ])(
      'pauses the endpoint’s host on %s, lowers its limit and tries again',
      async (_name, failure) => {
        const fetcher = new SparqlEndpointFetcher();
        const spy = vi
          .spyOn(fetcher, 'fetchTriples')
          .mockRejectedValueOnce(failure())
          .mockResolvedValueOnce([] as never);
        const { limiter, pauses, log } = recordingLimiter();

        await new SparqlConstructReader({ query, fetcher }).read(
          dataset,
          distribution,
          { limiter },
        );

        expect(spy).toHaveBeenCalledTimes(2);
        // Paused before the failed query frees its slot.
        expect(log).toEqual(['pause', 'overloaded', 'success']);
        expect(pauses).toHaveLength(1);
        expect(pauses[0].host).toBe('example.org');
        expect(secondsUntil(pauses[0].untilMs)).toBe(5);
      },
    );

    it('backs off 5, 15, 45, 135 and 405 s, then fails the read', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(httpError(502));
      const { limiter, pauses } = recordingLimiter();

      await expect(
        new SparqlConstructReader({ query, fetcher }).read(
          dataset,
          distribution,
          { limiter },
        ),
      ).rejects.toThrow('HTTP status 502');

      expect(fetcher.fetchTriples).toHaveBeenCalledTimes(6);
      expect(pauses.map(({ untilMs }) => secondsUntil(untilMs))).toEqual([
        5, 15, 45, 135, 405,
      ]);
    });

    it.each([
      ['30', 30],
      ['0', 5],
      ['86400', 405],
    ])('pauses for Retry-After: %s as %i s', async (retryAfter, seconds) => {
      const answers = [
        new Response('down', {
          status: 503,
          headers: { 'Retry-After': retryAfter },
        }),
        new Response('<http://a> <http://b> <http://c> .\n', {
          headers: { 'Content-Type': 'application/n-triples' },
        }),
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => answers.shift()),
      );
      const { limiter, pauses } = recordingLimiter();

      try {
        const quads = await new SparqlConstructReader({ query }).read(
          dataset,
          distribution,
          { limiter },
        );
        expect(await collect(quads)).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }

      expect(pauses.map(({ untilMs }) => secondsUntil(untilMs))).toEqual([
        seconds,
      ]);
    });

    it('lowers the limit on a timeout, without trying again', async () => {
      const fetcher = new SparqlEndpointFetcher();
      const timeout = Object.assign(new Error('The operation timed out'), {
        name: 'TimeoutError',
      });
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(timeout);
      const { limiter, pauses, outcomes } = recordingLimiter();

      await expect(
        new SparqlConstructReader({ query, fetcher }).read(
          dataset,
          distribution,
          { limiter },
        ),
      ).rejects.toThrow('timed out');

      expect(outcomes).toEqual(['overloaded']);
      expect(pauses).toEqual([]);
    });

    it('fails on HTTP 400 at once, leaving the limit alone', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(httpError(400));
      const { limiter, pauses, outcomes } = recordingLimiter();

      await expect(
        new SparqlConstructReader({ query, fetcher }).read(
          dataset,
          distribution,
          { limiter },
        ),
      ).rejects.toThrow('HTTP status 400');

      expect(fetcher.fetchTriples).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(['ignored']);
      expect(pauses).toEqual([]);
    });

    it('splits a batch on HTTP 500 and skips the root that fails by itself', async () => {
      const names = ['a', 'b', 'c', 'd'];
      const iri = (name: string) => `http://example.org/${name}`;
      const asked: string[] = [];
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockImplementation(
        async (_endpoint, sparql) => {
          const named = names.filter((name) =>
            sparql.includes(`${iri(name)}>`),
          );
          asked.push(named.join(''));
          if (named.includes('b')) throw httpError(500);
          return named.map((name) =>
            DataFactory.quad(
              namedNode(iri(name)),
              namedNode('http://example.org/p'),
              namedNode('http://example.org/o'),
            ),
          ) as never;
        },
      );
      const { limiter, outcomes } = recordingLimiter();
      const skipped: string[] = [];

      const quads = await new SparqlConstructReader({
        query: 'CONSTRUCT { ?item ?p ?o } WHERE { ?item ?p ?o }',
        fetcher,
      }).read(dataset, distribution, {
        bindings: names.map((name) => ({ item: namedNode(iri(name)) })),
        limiter,
        onRootSkipped: (root, error) => {
          skipped.push(`${root.item.value}: ${statusLine(error)}`);
        },
      });

      // The halves are asked for as the batch is read, not before.
      expect(asked).toEqual(['abcd']);
      expect((await collect(quads)).map((quad) => quad.subject.value)).toEqual([
        iri('a'),
        iri('c'),
        iri('d'),
      ]);
      expect(asked).toEqual(['abcd', 'ab', 'a', 'b', 'cd']);
      expect(skipped).toEqual([`${iri('b')}: HTTP status 500`]);
      expect(outcomes).toEqual([
        'ignored',
        'ignored',
        'success',
        'ignored',
        'success',
      ]);
    });

    it('fails a split batch in which no root answers', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(httpError(500));
      const skipped: string[] = [];

      const quads = await new SparqlConstructReader({
        query: 'CONSTRUCT { ?item ?p ?o } WHERE { ?item ?p ?o }',
        fetcher,
      }).read(dataset, distribution, {
        bindings: ['a', 'b'].map((name) => ({
          item: namedNode(`http://example.org/${name}`),
        })),
        limiter: recordingLimiter().limiter,
        onRootSkipped: (root) => skipped.push(root.item.value),
      });

      await expect(collect(quads)).rejects.toThrow('HTTP status 500');
      expect(fetcher.fetchTriples).toHaveBeenCalledTimes(3);
      expect(skipped).toHaveLength(2);
    });

    it('fails on HTTP 500 when there is no batch to split', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(httpError(500));

      await expect(
        new SparqlConstructReader({ query, fetcher }).read(
          dataset,
          distribution,
          { limiter: recordingLimiter().limiter },
        ),
      ).rejects.toThrow('HTTP status 500');
      expect(fetcher.fetchTriples).toHaveBeenCalledTimes(1);
    });

    it('runs on a limiter of its own when given none', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockRejectedValue(httpError(400));

      await expect(
        new SparqlConstructReader({ query, fetcher }).read(
          dataset,
          distribution,
        ),
      ).rejects.toThrow('HTTP status 400');
    });
  });

  /** The `HTTP status …` part of a fetcher error. */
  function statusLine(error: Error): string | undefined {
    return error.message.match(/HTTP status \d+/)?.[0];
  }

  describe('lineBuffer', () => {
    it('returns quads when lineBuffer is enabled', async () => {
      const datasetIri = 'http://foo.org/id/dataset/foo';

      const reader = new SparqlConstructReader({
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

      const result = await reader.read(dataset, distribution);

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

      const reader = new SparqlConstructReader({
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

      await reader.read(dataset, distribution);

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

      const reader = new SparqlConstructReader({
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

      const result = await reader.read(dataset, distribution);
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

      const reader = new SparqlConstructReader({
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

      const result = await reader.read(dataset, distribution);
      const quads = [];
      for await (const quad of result) {
        quads.push(quad);
      }

      expect(quads).toHaveLength(2);
    });
  });

  describe('fromFile', () => {
    it('creates reader from a file', async () => {
      const reader = await SparqlConstructReader.fromFile(
        'test/fixtures/query.rq',
      );

      expect(reader).toBeInstanceOf(SparqlConstructReader);
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
      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });

      const distribution = makeDistribution();
      await reader.read(makeDataset(distribution), distribution, {
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
      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      await expect(
        reader.read(makeDataset(distribution), distribution, {
          timeout: policy,
          limiter: recordingLimiter().limiter,
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
      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      await expect(
        reader.read(makeDataset(distribution), distribution, {
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
      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      await expect(
        reader.read(makeDataset(distribution), distribution, {
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
      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      await expect(
        reader.read(makeDataset(distribution), distribution, {
          timeout: policy,
        }),
      ).rejects.toThrow();

      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error' }),
      );
    });

    it('invokes the policy per attempt, retries included', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples')
        .mockRejectedValueOnce(
          new Error(
            'Invalid SPARQL endpoint response from http://policy.example.org/sparql (HTTP status 504):\nGateway Timeout',
          ),
        )
        .mockResolvedValueOnce([] as never);

      const policy = recordingPolicy();
      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      await reader.read(makeDataset(distribution), distribution, {
        timeout: policy,
        limiter: recordingLimiter().limiter,
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

    it('uses a default policy when ReadOptions omits one', async () => {
      const fetcher = new SparqlEndpointFetcher();
      vi.spyOn(fetcher, 'fetchTriples').mockResolvedValue([] as never);

      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      // No policy supplied at construction or per call – the reader falls
      // back to its module-level default and the request still completes.
      await expect(
        reader.read(makeDataset(distribution), distribution),
      ).resolves.toBeDefined();
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
      const reader = new SparqlConstructReader({
        query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        fetcher,
      });
      const distribution = makeDistribution();

      await expect(
        reader.read(makeDataset(distribution), distribution, {
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

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * A limiter that runs every task at once, ignoring pauses, and records the
 * pauses and what each task said about its host.
 */
function recordingLimiter() {
  const pauses: { host: string; untilMs: number }[] = [];
  const outcomes: ('success' | 'overloaded' | 'ignored')[] = [];
  /** Pauses and settled tasks, in the order they happened. */
  const log: string[] = [];
  const limiter: HostLimiter = {
    async run(_host, task) {
      // As the real limiter reads it: a rejection is overload, and `ignore`
      // wins over both.
      let said: 'overloaded' | 'ignored' | undefined;
      const settle = (outcome: (typeof outcomes)[number]) => {
        outcomes.push(outcome);
        log.push(outcome);
      };
      try {
        const result = await task({
          overloaded: () => {
            said ??= 'overloaded';
          },
          ignore: () => {
            said = 'ignored';
          },
        });
        settle(said ?? 'success');
        return result;
      } catch (error) {
        settle(said === 'ignored' ? 'ignored' : 'overloaded');
        throw error;
      }
    },
    pause(host, untilMs) {
      pauses.push({ host, untilMs });
      log.push('pause');
    },
  };
  return { limiter, pauses, outcomes, log };
}

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
