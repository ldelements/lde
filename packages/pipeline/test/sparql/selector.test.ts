import { SparqlItemSelector } from '../../src/sparql/selector.js';
import type { ItemSelector } from '../../src/stage.js';
import type { VariableBindings } from '../../src/sparql/executor.js';
import { Distribution } from '@lde/dataset';
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { DataFactory } from 'n3';

const { namedNode, literal, blankNode } = DataFactory;

const distribution = Distribution.sparql(new URL('http://example.com/sparql'));

function bindingsStream(
  records: Record<string, { termType: string; value: string }>[],
): Promise<Readable> {
  const stream = new Readable({
    objectMode: true,
    read() {
      /* no-op */
    },
  });
  for (const record of records) {
    stream.push(record);
  }
  stream.push(null);
  return Promise.resolve(stream);
}

describe('SparqlItemSelector', () => {
  const query = 'SELECT ?uri WHERE { ?uri a <http://example.com/Class> }';

  it('yields all bindings when results are fewer than page size', async () => {
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation(() =>
          bindingsStream([
            { uri: namedNode('http://example.com/1') },
            { uri: namedNode('http://example.com/2') },
          ]),
        ),
    };

    const selector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    const rows: VariableBindings[] = [];
    for await (const row of selector.select(distribution, 10)) {
      rows.push(row);
    }

    expect(rows).toHaveLength(2);
    expect(rows[0].uri.value).toBe('http://example.com/1');
    expect(rows[1].uri.value).toBe('http://example.com/2');
  });

  it('paginates with correct OFFSET increments', async () => {
    const queries: string[] = [];
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation((_endpoint: string, q: string) => {
          queries.push(q);
          if (queries.length === 1) {
            return bindingsStream([
              { uri: namedNode('http://example.com/1') },
              { uri: namedNode('http://example.com/2') },
            ]);
          }
          return bindingsStream([{ uri: namedNode('http://example.com/3') }]);
        }),
    };

    const selector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    const rows: VariableBindings[] = [];
    for await (const row of selector.select(distribution, 2)) {
      rows.push(row);
    }

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.uri.value)).toEqual([
      'http://example.com/1',
      'http://example.com/2',
      'http://example.com/3',
    ]);

    expect(queries[0]).toMatch(/LIMIT\s+2/);
    expect(queries[0]).not.toMatch(/OFFSET\s+[1-9]/);
    expect(queries[1]).toMatch(/LIMIT\s+2/);
    expect(queries[1]).toMatch(/OFFSET\s+2/);
  });

  it('yields nothing for empty results', async () => {
    const mockFetcher = {
      fetchBindings: vi.fn().mockImplementation(() => bindingsStream([])),
    };

    const selector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    const rows: unknown[] = [];
    for await (const row of selector.select(distribution)) {
      rows.push(row);
    }

    expect(rows).toHaveLength(0);
  });

  it('skips rows where all projected variables are non-NamedNode', async () => {
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation(() =>
          bindingsStream([
            { uri: namedNode('http://example.com/1') },
            { uri: literal('not a URI') },
            { uri: blankNode('b0') },
            { uri: namedNode('http://example.com/2') },
          ]),
        ),
    };

    const selector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    const rows: VariableBindings[] = [];
    for await (const row of selector.select(distribution, 10)) {
      rows.push(row);
    }

    expect(rows).toHaveLength(2);
    expect(rows[0].uri.value).toBe('http://example.com/1');
    expect(rows[1].uri.value).toBe('http://example.com/2');
  });

  it('defaults page size to 10', async () => {
    const queries: string[] = [];
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation((_endpoint: string, q: string) => {
          queries.push(q);
          return bindingsStream([]);
        }),
    };

    const selector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    for await (const _row of selector.select(distribution)) {
      // consume
    }

    expect(queries[0]).toMatch(/LIMIT\s+10/);
  });

  it('uses batchSize from select()', async () => {
    const queries: string[] = [];
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation((_endpoint: string, q: string) => {
          queries.push(q);
          return bindingsStream([]);
        }),
    };

    const selector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    for await (const _row of selector.select(distribution, 500)) {
      // consume
    }

    expect(queries[0]).toMatch(/LIMIT\s+500/);
  });

  it('uses query LIMIT as page size', async () => {
    const queries: string[] = [];
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation((_endpoint: string, q: string) => {
          queries.push(q);
          return bindingsStream([{ class: namedNode('http://example.com/a') }]);
        }),
    };

    const selector = new SparqlItemSelector({
      query: 'SELECT ?class WHERE { ?s a ?class } LIMIT 25',
      fetcher: mockFetcher as never,
    });

    for await (const _row of selector.select(distribution)) {
      // consume
    }

    expect(queries[0]).toMatch(/LIMIT\s+25/);
  });

  it('prefers query LIMIT over batchSize from select()', async () => {
    const queries: string[] = [];
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation((_endpoint: string, q: string) => {
          queries.push(q);
          return bindingsStream([{ class: namedNode('http://example.com/a') }]);
        }),
    };

    const selector = new SparqlItemSelector({
      query: 'SELECT ?class WHERE { ?s a ?class } LIMIT 25',
      fetcher: mockFetcher as never,
    });

    for await (const _row of selector.select(distribution, 500)) {
      // consume
    }

    // Query LIMIT 25 takes priority over batchSize from select().
    expect(queries[0]).toMatch(/LIMIT\s+25/);
  });

  it('collects all projected variables per row', async () => {
    const mockFetcher = {
      fetchBindings: vi.fn().mockImplementation(() =>
        bindingsStream([
          {
            class: namedNode('http://example.com/Person'),
            property: namedNode('http://example.com/name'),
          },
        ]),
      ),
    };

    const selector = new SparqlItemSelector({
      query: 'SELECT ?class ?property WHERE { ?s a ?class ; ?property ?o }',
      fetcher: mockFetcher as never,
    });

    const rows: VariableBindings[] = [];
    for await (const row of selector.select(distribution)) {
      rows.push(row);
    }

    expect(rows[0].class.value).toBe('http://example.com/Person');
    expect(rows[0].property.value).toBe('http://example.com/name');
  });

  it('includes row when at least one variable is a NamedNode', async () => {
    const mockFetcher = {
      fetchBindings: vi.fn().mockImplementation(() =>
        bindingsStream([
          {
            class: namedNode('http://example.com/Person'),
            label: literal('Person'),
          },
        ]),
      ),
    };

    const selector = new SparqlItemSelector({
      query:
        'SELECT ?class ?label WHERE { ?s a ?class ; <http://www.w3.org/2000/01/rdf-schema#label> ?label }',
      fetcher: mockFetcher as never,
    });

    const rows: VariableBindings[] = [];
    for await (const row of selector.select(distribution)) {
      rows.push(row);
    }

    // Row is included because ?class is a NamedNode; ?label (literal) is omitted.
    expect(rows).toHaveLength(1);
    expect(rows[0].class.value).toBe('http://example.com/Person');
    expect(rows[0].label).toBeUndefined();
  });

  it('throws on non-SELECT queries', () => {
    expect(
      () =>
        new SparqlItemSelector({
          query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        }),
    ).toThrow('Query must be a SELECT query');
  });

  it('throws on SELECT * queries', () => {
    expect(
      () =>
        new SparqlItemSelector({
          query: 'SELECT * WHERE { ?s ?p ?o }',
        }),
    ).toThrow('SELECT * is not supported');
  });

  it('is assignable to ItemSelector', async () => {
    const mockFetcher = {
      fetchBindings: vi
        .fn()
        .mockImplementation(() =>
          bindingsStream([{ uri: namedNode('http://example.com/1') }]),
        ),
    };

    // Verify SparqlItemSelector satisfies ItemSelector.
    const selector: ItemSelector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    const rows: VariableBindings[] = [];
    for await (const row of selector.select(distribution)) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
  });

  it('uses distribution endpoint for SPARQL queries', async () => {
    const mockFetcher = {
      fetchBindings: vi.fn().mockImplementation(() => bindingsStream([])),
    };

    const selector = new SparqlItemSelector({
      query,
      fetcher: mockFetcher as never,
    });

    for await (const _row of selector.select(distribution)) {
      // consume
    }

    expect(mockFetcher.fetchBindings).toHaveBeenCalledWith(
      'http://example.com/sparql',
      expect.any(String),
    );
  });

  describe('maxResults', () => {
    it('caps total bindings yielded across pages', async () => {
      const mockFetcher = {
        fetchBindings: vi
          .fn()
          .mockImplementation(() =>
            bindingsStream([
              { uri: namedNode('http://example.com/1') },
              { uri: namedNode('http://example.com/2') },
              { uri: namedNode('http://example.com/3') },
              { uri: namedNode('http://example.com/4') },
              { uri: namedNode('http://example.com/5') },
            ]),
          ),
      };

      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
        maxResults: 3,
      });

      const rows: VariableBindings[] = [];
      for await (const row of selector.select(distribution, 100)) {
        rows.push(row);
      }

      expect(rows).toHaveLength(3);
    });

    it('does not clamp the first page LIMIT to maxResults (page size and total cap stay orthogonal)', async () => {
      const queries: string[] = [];
      const mockFetcher = {
        fetchBindings: vi
          .fn()
          .mockImplementation((_endpoint: string, q: string) => {
            queries.push(q);
            return bindingsStream(
              Array.from({ length: 100 }, (_, i) => ({
                uri: namedNode(`http://example.com/${i + 1}`),
              })),
            );
          }),
      };

      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
        maxResults: 5,
      });

      const rows: VariableBindings[] = [];
      for await (const row of selector.select(distribution, 100)) {
        rows.push(row);
      }

      // The first page asks for the configured page size (100), even though
      // we only yield 5 rows from it.
      expect(queries[0]).toMatch(/LIMIT\s+100/);
      expect(rows).toHaveLength(5);
    });

    it('shrinks the last page LIMIT to the remaining cap', async () => {
      const queries: string[] = [];
      let calls = 0;
      const mockFetcher = {
        fetchBindings: vi
          .fn()
          .mockImplementation((_endpoint: string, q: string) => {
            queries.push(q);
            calls++;
            // First page returns 10 rows; second page request should be
            // shrunk to LIMIT 2 (12 total cap minus 10 already yielded).
            return bindingsStream(
              Array.from({ length: calls === 1 ? 10 : 2 }, (_, i) => ({
                uri: namedNode(`http://example.com/${calls}-${i + 1}`),
              })),
            );
          }),
      };

      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
        maxResults: 12,
      });

      const rows: VariableBindings[] = [];
      for await (const row of selector.select(distribution, 10)) {
        rows.push(row);
      }

      expect(queries[0]).toMatch(/LIMIT\s+10/);
      expect(queries[1]).toMatch(/LIMIT\s+2/);
      expect(rows).toHaveLength(12);
    });

    it('does not paginate beyond maxResults', async () => {
      let calls = 0;
      const mockFetcher = {
        fetchBindings: vi.fn().mockImplementation(() => {
          calls++;
          return bindingsStream([
            { uri: namedNode(`http://example.com/${calls}-1`) },
            { uri: namedNode(`http://example.com/${calls}-2`) },
          ]);
        }),
      };

      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
        maxResults: 2,
      });

      const rows: VariableBindings[] = [];
      for await (const row of selector.select(distribution, 2)) {
        rows.push(row);
      }

      expect(rows).toHaveLength(2);
      // Only one page fetched; we don't keep asking for more.
      expect(calls).toBe(1);
    });

    it('yields nothing when maxResults is 0', async () => {
      const mockFetcher = {
        fetchBindings: vi
          .fn()
          .mockImplementation(() =>
            bindingsStream([{ uri: namedNode('http://example.com/1') }]),
          ),
      };

      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
        maxResults: 0,
      });

      const rows: VariableBindings[] = [];
      for await (const row of selector.select(distribution, 10)) {
        rows.push(row);
      }

      expect(rows).toHaveLength(0);
      expect(mockFetcher.fetchBindings).not.toHaveBeenCalled();
    });
  });

  describe('timeout policy', () => {
    function recordingPolicy() {
      return {
        beforeRequest: vi.fn().mockReturnValue(5_000),
        afterRequest: vi.fn(),
      };
    }

    it('calls beforeRequest and afterRequest({outcome: "ok"}) per page', async () => {
      const mockFetcher = {
        fetchBindings: vi
          .fn()
          .mockImplementationOnce(() =>
            bindingsStream([
              { uri: namedNode('http://example.com/1') },
              { uri: namedNode('http://example.com/2') },
            ]),
          )
          .mockImplementationOnce(() =>
            bindingsStream([{ uri: namedNode('http://example.com/3') }]),
          ),
      };

      const policy = recordingPolicy();
      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
      });

      const rows: VariableBindings[] = [];
      for await (const row of selector.select(distribution, 2, {
        timeout: policy,
      })) {
        rows.push(row);
      }

      expect(rows).toHaveLength(3);
      expect(policy.beforeRequest).toHaveBeenCalledTimes(2);
      expect(policy.beforeRequest).toHaveBeenCalledWith({
        endpoint: distribution.accessUrl,
      });
      expect(policy.afterRequest).toHaveBeenCalledTimes(2);
      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'ok' }),
      );
    });

    it('reports HTTP 504 as outcome "timeout"', async () => {
      const mockFetcher = {
        fetchBindings: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'Invalid SPARQL endpoint response from http://example.com/sparql (HTTP status 504):\nGateway Timeout',
            ),
          ),
      };

      const policy = recordingPolicy();
      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
      });

      const iterate = async () => {
        for await (const _row of selector.select(distribution, 10, {
          timeout: policy,
        })) {
          // consume
        }
      };

      await expect(iterate()).rejects.toThrow('504');
      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timeout' }),
      );
    });

    it('reports non-timeout errors as outcome "error"', async () => {
      const mockFetcher = {
        fetchBindings: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'Invalid SPARQL endpoint response from http://example.com/sparql (HTTP status 400):\nBad Request',
            ),
          ),
      };

      const policy = recordingPolicy();
      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
      });

      const iterate = async () => {
        for await (const _row of selector.select(distribution, 10, {
          timeout: policy,
        })) {
          // consume
        }
      };

      await expect(iterate()).rejects.toThrow();
      expect(policy.afterRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error' }),
      );
    });

    it('uses a default policy when select() omits one', async () => {
      const mockFetcher = {
        fetchBindings: vi.fn().mockImplementation(() => bindingsStream([])),
      };

      const selector = new SparqlItemSelector({
        query,
        fetcher: mockFetcher as never,
      });

      // No policy supplied at construction or per call — pagination still
      // works against the module-level default policy.
      const rows: VariableBindings[] = [];
      for await (const row of selector.select(distribution, 10)) {
        rows.push(row);
      }
      expect(rows).toHaveLength(0);
      expect(mockFetcher.fetchBindings).toHaveBeenCalledTimes(1);
    });
  });
});
