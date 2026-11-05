import { SparqlUpdateWriter } from '../../src/writer/sparqlUpdateWriter.js';
import { Dataset, Distribution } from '@lde/dataset';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { namedNode, literal, quad } = DataFactory;

async function* quadsOf(...quads: Quad[]): AsyncIterable<Quad> {
  yield* quads;
}

describe('SparqlUpdateWriter', () => {
  const endpoint = new URL('http://example.com/sparql');
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    } as Partial<Response>);
  });

  function createDataset(iri: string): Dataset {
    return new Dataset({
      iri: new URL(iri),
      distributions: [
        Distribution.sparql(new URL('http://example.com/sparql')),
      ],
    });
  }

  describe('write', () => {
    it('writes quads to SPARQL endpoint', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const clearBody = mockFetch.mock.calls[0]![1]!.body as string;
      expect(clearBody).toBe('CLEAR GRAPH <http://example.com/dataset/1>');

      const insertBody = mockFetch.mock.calls[1]![1]!.body as string;
      expect(insertBody).toContain('INSERT DATA');
      expect(insertBody).toContain('GRAPH <http://example.com/dataset/1>');
      expect(insertBody).toContain('<http://example.com/subject>');
      expect(insertBody).toContain('<http://example.com/predicate>');
      expect(insertBody).toContain('"object"');
    });

    it('clears graph on first write, even for empty data', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(dataset, quadsOf());

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = mockFetch.mock.calls[0]![1]!.body as string;
      expect(body).toBe('CLEAR GRAPH <http://example.com/dataset/1>');
    });

    it('batches large datasets', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
        batchSize: 2,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s1'),
            namedNode('http://example.com/p'),
            literal('o1'),
          ),
          quad(
            namedNode('http://example.com/s2'),
            namedNode('http://example.com/p'),
            literal('o2'),
          ),
          quad(
            namedNode('http://example.com/s3'),
            namedNode('http://example.com/p'),
            literal('o3'),
          ),
        ),
      );

      // 1 clear + 2 insert batches (2 quads + 1 quad).
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const clearBody = mockFetch.mock.calls[0]![1]!.body as string;
      expect(clearBody).toContain('CLEAR GRAPH');

      const insertBody1 = mockFetch.mock.calls[1]![1]!.body as string;
      expect(insertBody1).toContain('INSERT DATA');

      const insertBody2 = mockFetch.mock.calls[2]![1]!.body as string;
      expect(insertBody2).toContain('INSERT DATA');
    });

    it('sends Authorization header when auth is provided', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
        auth: 'Bearer my-token',
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );

      for (const call of mockFetch.mock.calls) {
        expect(call[1]!.headers).toHaveProperty(
          'Authorization',
          'Bearer my-token',
        );
      }
    });

    it('does not send Authorization header when auth is omitted', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');
      await writer.write(dataset, quadsOf());

      for (const call of mockFetch.mock.calls) {
        expect(call[1]!.headers).not.toHaveProperty('Authorization');
      }
    });

    it('does not re-clear graph on second write to same dataset', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');
      const aQuad = quad(
        namedNode('http://example.com/s'),
        namedNode('http://example.com/p'),
        literal('o'),
      );

      await writer.write(dataset, quadsOf(aQuad));
      mockFetch.mockClear();

      // Second write to the same dataset: no CLEAR, only INSERT.
      await writer.write(dataset, quadsOf(aQuad));

      const bodies = mockFetch.mock.calls.map((c) => c[1]!.body as string);
      expect(bodies.every((b) => !b.startsWith('CLEAR'))).toBe(true);
      expect(bodies.some((b) => b.startsWith('INSERT'))).toBe(true);
    });

    it('uses dataset.iri as graph URI when graphIri is not provided', async () => {
      // Sanity check: the default behaviour is unchanged.
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      await writer.write(
        createDataset('http://example.com/dataset/1'),
        quadsOf(),
      );

      const body = mockFetch.mock.calls[0]![1]!.body as string;
      expect(body).toBe('CLEAR GRAPH <http://example.com/dataset/1>');
    });

    it('writes to a derived graph URI when graphIri is provided', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
        graphIri: (dataset) =>
          new URL(
            `https://example.org/enrichment/${encodeURIComponent(dataset.iri.toString())}`,
          ),
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );

      const expected =
        'https://example.org/enrichment/http%3A%2F%2Fexample.com%2Fdataset%2F1';
      const clearBody = mockFetch.mock.calls[0]![1]!.body as string;
      expect(clearBody).toBe(`CLEAR GRAPH <${expected}>`);
      const insertBody = mockFetch.mock.calls[1]![1]!.body as string;
      expect(insertBody).toContain(`GRAPH <${expected}>`);
    });

    it('tracks clearedGraphs by the derived URI, not dataset.iri', async () => {
      // Two writers backed by the same endpoint with different graphIri
      // policies must each CLEAR their own graph independently — verify the
      // bookkeeping keys off the derived URI.
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
        graphIri: (dataset) => new URL(`${dataset.iri.toString()}/derived`),
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');
      const aQuad = quad(
        namedNode('http://example.com/s'),
        namedNode('http://example.com/p'),
        literal('o'),
      );

      await writer.write(dataset, quadsOf(aQuad));
      mockFetch.mockClear();
      await writer.write(dataset, quadsOf(aQuad));

      const bodies = mockFetch.mock.calls.map((c) => c[1]!.body as string);
      expect(bodies.every((b) => !b.startsWith('CLEAR'))).toBe(true);
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await expect(
        writer.write(
          dataset,
          quadsOf(
            quad(
              namedNode('http://example.com/s'),
              namedNode('http://example.com/p'),
              literal('o'),
            ),
          ),
        ),
      ).rejects.toThrow('SPARQL UPDATE failed with status 500');
    });
  });

  describe('reset', () => {
    it('re-clears the graph on the next write after a reset', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');
      const aQuad = quad(
        namedNode('http://example.com/s'),
        namedNode('http://example.com/p'),
        literal('o'),
      );

      await writer.write(dataset, quadsOf(aQuad));
      await writer.reset(dataset);
      mockFetch.mockClear();

      // After a reset the graph state is forgotten, so the next write must
      // CLEAR again before inserting — discarding the prior output.
      await writer.write(dataset, quadsOf(aQuad));

      const bodies = mockFetch.mock.calls.map((c) => c[1]!.body as string);
      expect(bodies[0]).toBe('CLEAR GRAPH <http://example.com/dataset/1>');
      expect(bodies.some((b) => b.startsWith('INSERT'))).toBe(true);
    });

    it('resets only the given dataset’s graph', async () => {
      const writer = await new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      }).openRun();

      const datasetOne = createDataset('http://example.com/dataset/1');
      const datasetTwo = createDataset('http://example.com/dataset/2');
      const aQuad = quad(
        namedNode('http://example.com/s'),
        namedNode('http://example.com/p'),
        literal('o'),
      );

      await writer.write(datasetOne, quadsOf(aQuad));
      await writer.write(datasetTwo, quadsOf(aQuad));
      await writer.reset(datasetOne);
      mockFetch.mockClear();

      // Only datasetOne re-clears; datasetTwo’s graph state is untouched.
      await writer.write(datasetTwo, quadsOf(aQuad));
      await writer.write(datasetOne, quadsOf(aQuad));

      const bodies = mockFetch.mock.calls.map((c) => c[1]!.body as string);
      expect(bodies).toContain('CLEAR GRAPH <http://example.com/dataset/1>');
      expect(bodies).not.toContain(
        'CLEAR GRAPH <http://example.com/dataset/2>',
      );
    });
  });

  describe('run lifecycle', () => {
    it('clears each graph again in a new run of the same writer', async () => {
      // Cleared-graph state is per run, not per writer instance: re-running a
      // pipeline with the same writer replaces each graph instead of appending.
      const writer = new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      });
      const dataset = createDataset('http://example.com/dataset/1');
      const aQuad = quad(
        namedNode('http://example.com/s'),
        namedNode('http://example.com/p'),
        literal('o'),
      );

      const firstRun = await writer.openRun();
      await firstRun.write(dataset, quadsOf(aQuad));
      await firstRun.commit();
      mockFetch.mockClear();

      const secondRun = await writer.openRun();
      await secondRun.write(dataset, quadsOf(aQuad));

      const bodies = mockFetch.mock.calls.map((c) => c[1]!.body as string);
      expect(bodies[0]).toBe('CLEAR GRAPH <http://example.com/dataset/1>');
    });

    it('commit and abort issue no requests: writes are visible as they land', async () => {
      const writer = new SparqlUpdateWriter({
        endpoint,
        fetch: mockFetch as typeof globalThis.fetch,
      });
      const dataset = createDataset('http://example.com/dataset/1');
      const aQuad = quad(
        namedNode('http://example.com/s'),
        namedNode('http://example.com/p'),
        literal('o'),
      );

      const run = await writer.openRun();
      await run.write(dataset, quadsOf(aQuad));
      mockFetch.mockClear();

      await run.commit();
      await run.abort(new Error('failure elsewhere'));

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('defaults to the global fetch implementation', () => {
      // Constructing without a fetch option must not throw; the global fetch
      // is only invoked on write.
      expect(() => new SparqlUpdateWriter({ endpoint })).not.toThrow();
    });
  });
});
