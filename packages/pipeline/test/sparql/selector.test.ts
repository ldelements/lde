import { SparqlItemSelector } from '../../src/sparql/selector.js';
import type { ItemSelector } from '../../src/stage.js';
import type { VariableBindings } from '../../src/sparql/reader.js';
import { Distribution } from '@lde/dataset';
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { DataFactory } from 'n3';

const { namedNode, literal, blankNode } = DataFactory;

const distribution = Distribution.sparql(new URL('http://example.com/sparql'));

type MockRecord = Record<string, { termType: string; value: string }>;

function bindingsStream(records: MockRecord[]): Promise<Readable> {
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

/**
 * A mock fetcher serving `pages` in request order (an empty page once
 * exhausted), recording every generated query so tests can assert the
 * LIMIT/OFFSET per request.
 */
function pagedFetcher(pages: MockRecord[][]) {
  const queries: string[] = [];
  const fetcher = {
    fetchBindings: vi
      .fn()
      .mockImplementation((_endpoint: string, generatedQuery: string) => {
        queries.push(generatedQuery);
        return bindingsStream(pages[queries.length - 1] ?? []);
      }),
  };
  return { fetcher, queries };
}

/** Drain a selector into an array of yielded binding rows. */
async function selectAll(
  selector: ItemSelector,
  batchSize?: number,
): Promise<VariableBindings[]> {
  const rows: VariableBindings[] = [];
  for await (const row of selector.select(distribution, batchSize)) {
    rows.push(row);
  }
  return rows;
}

describe('SparqlItemSelector', () => {
  const query = 'SELECT ?uri WHERE { ?uri a <http://example.com/Class> }';

  it('yields all bindings when results are fewer than page size', async () => {
    const { fetcher } = pagedFetcher([
      [
        { uri: namedNode('http://example.com/1') },
        { uri: namedNode('http://example.com/2') },
      ],
    ]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector, 10);

    expect(rows).toHaveLength(2);
    expect(rows[0].uri.value).toBe('http://example.com/1');
    expect(rows[1].uri.value).toBe('http://example.com/2');
  });

  it('paginates with correct OFFSET increments', async () => {
    const { fetcher, queries } = pagedFetcher([
      [
        { uri: namedNode('http://example.com/1') },
        { uri: namedNode('http://example.com/2') },
      ],
      [{ uri: namedNode('http://example.com/3') }],
    ]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector, 2);

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
    const { fetcher } = pagedFetcher([]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    expect(await selectAll(selector)).toHaveLength(0);
  });

  it('skips rows where projected variables bind a non-NamedNode', async () => {
    const { fetcher } = pagedFetcher([
      [
        { uri: namedNode('http://example.com/1') },
        { uri: literal('not a URI') },
        { uri: blankNode('b0') },
        { uri: namedNode('http://example.com/2') },
      ],
    ]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector, 10);

    expect(rows).toHaveLength(2);
    expect(rows[0].uri.value).toBe('http://example.com/1');
    expect(rows[1].uri.value).toBe('http://example.com/2');
  });

  it('keeps paginating when a full page contains skipped rows', async () => {
    // A skipped (blank-node) row still occupied a result slot at the endpoint:
    // the page is full, so pagination must continue – and OFFSET must advance
    // by the fetched count, not the yielded count, or rows are re-read.
    const { fetcher, queries } = pagedFetcher([
      [{ uri: blankNode('b0') }, { uri: namedNode('http://example.com/1') }],
      [{ uri: namedNode('http://example.com/2') }],
    ]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector, 2);

    expect(rows.map((row) => row.uri.value)).toEqual([
      'http://example.com/1',
      'http://example.com/2',
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatch(/OFFSET\s+2/);
  });

  it('keeps paginating past a page of only skipped rows', async () => {
    // All rows dropped is not the end of the results – the endpoint returned a
    // full page, so the next page may still hold yieldable rows.
    const { fetcher, queries } = pagedFetcher([
      [{ uri: blankNode('b0') }, { uri: blankNode('b1') }],
      [{ uri: namedNode('http://example.com/1') }],
    ]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector, 2);

    expect(rows.map((row) => row.uri.value)).toEqual(['http://example.com/1']);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatch(/OFFSET\s+2/);
  });

  it('defaults page size to 10', async () => {
    const { fetcher, queries } = pagedFetcher([]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    await selectAll(selector);

    expect(queries[0]).toMatch(/LIMIT\s+10/);
  });

  it('uses batchSize from select()', async () => {
    const { fetcher, queries } = pagedFetcher([]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    await selectAll(selector, 500);

    expect(queries[0]).toMatch(/LIMIT\s+500/);
  });

  it('uses query LIMIT as page size', async () => {
    const { fetcher, queries } = pagedFetcher([
      [{ class: namedNode('http://example.com/a') }],
    ]);

    const selector = new SparqlItemSelector({
      query: 'SELECT ?class WHERE { ?s a ?class } LIMIT 25',
      fetcher: fetcher as never,
    });

    await selectAll(selector);

    expect(queries[0]).toMatch(/LIMIT\s+25/);
  });

  it('prefers query LIMIT over batchSize from select()', async () => {
    const { fetcher, queries } = pagedFetcher([
      [{ class: namedNode('http://example.com/a') }],
    ]);

    const selector = new SparqlItemSelector({
      query: 'SELECT ?class WHERE { ?s a ?class } LIMIT 25',
      fetcher: fetcher as never,
    });

    await selectAll(selector, 500);

    // Query LIMIT 25 takes priority over batchSize from select().
    expect(queries[0]).toMatch(/LIMIT\s+25/);
  });

  it('rejects a non-positive page size instead of querying pointlessly', async () => {
    // batchSize 0 (or a query LIMIT 0) is a configuration error: a LIMIT 0
    // request can never terminate pagination meaningfully, and silently
    // yielding nothing would make a misconfigured stage look like an empty
    // source.
    const { fetcher } = pagedFetcher([]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    await expect(selectAll(selector, 0)).rejects.toThrow(
      'Page size must be positive',
    );
    expect(fetcher.fetchBindings).not.toHaveBeenCalled();
  });

  it('collects all projected variables per row', async () => {
    const { fetcher } = pagedFetcher([
      [
        {
          class: namedNode('http://example.com/Person'),
          property: namedNode('http://example.com/name'),
        },
      ],
    ]);

    const selector = new SparqlItemSelector({
      query: 'SELECT ?class ?property WHERE { ?s a ?class ; ?property ?o }',
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector);

    expect(rows[0].class.value).toBe('http://example.com/Person');
    expect(rows[0].property.value).toBe('http://example.com/name');
  });

  it('drops a row when any projected variable binds a non-NamedNode', async () => {
    // A partially-usable row is not yielded partially: the bindings are
    // re-injected into reader queries as a VALUES block, which needs uniform
    // rows – a row missing one variable would silently weaken the join.
    const { fetcher } = pagedFetcher([
      [
        {
          class: namedNode('http://example.com/Person'),
          label: literal('Person'),
        },
        {
          class: namedNode('http://example.com/Organization'),
          label: namedNode('http://example.com/org-label'),
        },
      ],
    ]);

    const selector = new SparqlItemSelector({
      query:
        'SELECT ?class ?label WHERE { ?s a ?class ; <http://www.w3.org/2000/01/rdf-schema#label> ?label }',
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector);

    expect(rows).toHaveLength(1);
    expect(rows[0].class.value).toBe('http://example.com/Organization');
  });

  it('drops a row when a projected variable is unbound', async () => {
    // Same uniformity requirement: an unbound (e.g. OPTIONAL) variable would
    // leave a hole in the VALUES block.
    const { fetcher } = pagedFetcher([
      [
        { class: namedNode('http://example.com/Person') },
        {
          class: namedNode('http://example.com/Organization'),
          label: namedNode('http://example.com/org-label'),
        },
      ],
    ]);

    const selector = new SparqlItemSelector({
      query:
        'SELECT ?class ?label WHERE { ?s a ?class ; <http://www.w3.org/2000/01/rdf-schema#label> ?label }',
      fetcher: fetcher as never,
    });

    const rows = await selectAll(selector);

    expect(rows).toHaveLength(1);
    expect(rows[0].class.value).toBe('http://example.com/Organization');
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
    const { fetcher } = pagedFetcher([
      [{ uri: namedNode('http://example.com/1') }],
    ]);

    // Verify SparqlItemSelector satisfies ItemSelector.
    const selector: ItemSelector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    expect(await selectAll(selector)).toHaveLength(1);
  });

  it('uses distribution endpoint for SPARQL queries', async () => {
    const { fetcher } = pagedFetcher([]);

    const selector = new SparqlItemSelector({
      query,
      fetcher: fetcher as never,
    });

    await selectAll(selector);

    expect(fetcher.fetchBindings).toHaveBeenCalledWith(
      'http://example.com/sparql',
      expect.any(String),
    );
  });

  describe('maxResults', () => {
    it('caps total bindings yielded across pages', async () => {
      const { fetcher } = pagedFetcher([
        [
          { uri: namedNode('http://example.com/1') },
          { uri: namedNode('http://example.com/2') },
          { uri: namedNode('http://example.com/3') },
          { uri: namedNode('http://example.com/4') },
          { uri: namedNode('http://example.com/5') },
        ],
      ]);

      const selector = new SparqlItemSelector({
        query,
        fetcher: fetcher as never,
        maxResults: 3,
      });

      expect(await selectAll(selector, 100)).toHaveLength(3);
    });

    it('does not clamp the first page LIMIT to maxResults (page size and total cap stay orthogonal)', async () => {
      const { fetcher, queries } = pagedFetcher([
        Array.from({ length: 100 }, (_, i) => ({
          uri: namedNode(`http://example.com/${i + 1}`),
        })),
      ]);

      const selector = new SparqlItemSelector({
        query,
        fetcher: fetcher as never,
        maxResults: 5,
      });

      const rows = await selectAll(selector, 100);

      // The first page asks for the configured page size (100), even though
      // we only yield 5 rows from it.
      expect(queries[0]).toMatch(/LIMIT\s+100/);
      expect(rows).toHaveLength(5);
    });

    it('shrinks the last page LIMIT to the remaining cap', async () => {
      // First page returns 10 rows; the second page request is shrunk to
      // LIMIT 2 (12 total cap minus 10 already yielded).
      const { fetcher, queries } = pagedFetcher([
        Array.from({ length: 10 }, (_, i) => ({
          uri: namedNode(`http://example.com/1-${i + 1}`),
        })),
        Array.from({ length: 2 }, (_, i) => ({
          uri: namedNode(`http://example.com/2-${i + 1}`),
        })),
      ]);

      const selector = new SparqlItemSelector({
        query,
        fetcher: fetcher as never,
        maxResults: 12,
      });

      const rows = await selectAll(selector, 10);

      expect(queries[0]).toMatch(/LIMIT\s+10/);
      expect(queries[1]).toMatch(/LIMIT\s+2/);
      expect(rows).toHaveLength(12);
    });

    it('keeps full-size pages once rows have been dropped', async () => {
      // With dropped rows, yields lag fetches – shrinking pages to the yielded
      // remainder would crawl a dropped-row region at down to one row per
      // request. Page 1 (LIMIT 3) yields 2 of 3 rows; the cap has 1 left, but
      // page 2 must still ask for LIMIT 3, and the cap still holds.
      const { fetcher, queries } = pagedFetcher([
        [
          { uri: namedNode('http://example.com/1') },
          { uri: blankNode('b0') },
          { uri: namedNode('http://example.com/2') },
        ],
        [
          { uri: blankNode('b1') },
          { uri: namedNode('http://example.com/3') },
          { uri: namedNode('http://example.com/4') },
        ],
      ]);

      const selector = new SparqlItemSelector({
        query,
        fetcher: fetcher as never,
        maxResults: 3,
      });

      const rows = await selectAll(selector, 3);

      expect(rows.map((row) => row.uri.value)).toEqual([
        'http://example.com/1',
        'http://example.com/2',
        'http://example.com/3',
      ]);
      expect(queries[1]).toMatch(/LIMIT\s+3/);
      expect(queries[1]).toMatch(/OFFSET\s+3/);
    });

    it('does not paginate beyond maxResults', async () => {
      const { fetcher, queries } = pagedFetcher([
        [
          { uri: namedNode('http://example.com/1-1') },
          { uri: namedNode('http://example.com/1-2') },
        ],
        [
          { uri: namedNode('http://example.com/2-1') },
          { uri: namedNode('http://example.com/2-2') },
        ],
      ]);

      const selector = new SparqlItemSelector({
        query,
        fetcher: fetcher as never,
        maxResults: 2,
      });

      expect(await selectAll(selector, 2)).toHaveLength(2);
      // Only one page fetched; we don't keep asking for more.
      expect(queries).toHaveLength(1);
    });

    it('yields nothing when maxResults is 0', async () => {
      const { fetcher } = pagedFetcher([
        [{ uri: namedNode('http://example.com/1') }],
      ]);

      const selector = new SparqlItemSelector({
        query,
        fetcher: fetcher as never,
        maxResults: 0,
      });

      expect(await selectAll(selector, 10)).toHaveLength(0);
      expect(fetcher.fetchBindings).not.toHaveBeenCalled();
    });

    it('rejects a negative maxResults', () => {
      // A negative cap (e.g. an underflowed computed value) would silently
      // behave as maxResults 1: the first yield satisfies totalYielded >= -1.
      expect(
        () =>
          new SparqlItemSelector({
            query,
            maxResults: -1,
          }),
      ).toThrow('maxResults must not be negative');
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
      const { fetcher } = pagedFetcher([
        [
          { uri: namedNode('http://example.com/1') },
          { uri: namedNode('http://example.com/2') },
        ],
        [{ uri: namedNode('http://example.com/3') }],
      ]);

      const policy = recordingPolicy();
      const selector = new SparqlItemSelector({
        query,
        fetcher: fetcher as never,
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
