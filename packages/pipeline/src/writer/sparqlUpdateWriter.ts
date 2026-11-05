import { Dataset, assertSafeIri } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { batch } from '../batch.js';
import { RunContext, RunWriter, Writer } from './writer.js';
import { serializeQuads } from './serialize.js';

export interface SparqlWriterOptions {
  /**
   * The SPARQL UPDATE endpoint URL.
   */
  endpoint: URL;
  /**
   * Value for the Authorization header, e.g.
   * `"Basic dXNlcjpwYXNz"`, `"Bearer my-token"`, or `"GDB eyJ…"`.
   */
  auth?: string;
  /**
   * Optional fetch implementation for making HTTP requests.
   * @default globalThis.fetch
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Maximum number of triples to include in a single INSERT DATA request.
   * Larger batches are more efficient but may hit endpoint size limits.
   * @default 10000
   */
  batchSize?: number;
  /**
   * Derive the named-graph URI from the dataset being written. Defaults to
   * `dataset.iri`, which puts each dataset's quads in a graph named after its
   * own IRI. Override when the quads are an enrichment (e.g. a SHACL validation
   * report) that should land in a different graph than the dataset's own data.
   *
   * The same instance's `clearedGraphs` lifecycle (CLEAR on first write per
   * graph) follows the derived URI, so two writers with different `graphIri`
   * functions can target the same endpoint without interfering.
   */
  graphIri?: (dataset: Dataset) => URL;
}

/**
 * The run writer a {@link SparqlUpdateWriter} opens: per-dataset `reset` is
 * always available, so direct callers need no optional chaining.
 */
export interface SparqlUpdateRunWriter extends RunWriter {
  reset(dataset: Dataset): Promise<void>;
}

/**
 * Writes RDF data to a SPARQL endpoint using SPARQL UPDATE INSERT DATA queries.
 *
 * Within a run ({@link openRun}), the named graph is cleared before the first
 * write per dataset, then quads are streamed in batches to avoid accumulating
 * the entire dataset in memory. Subsequent writes for the same dataset within
 * the run append rather than replace. Each new run starts with fresh
 * cleared-graph state, so re-running a pipeline replaces each graph again.
 *
 * The writes are visible as they land (no run-level staging), so `commit` and
 * `abort` are no-ops: an aborted run leaves the graphs written so far, to be
 * replaced by the next run.
 */
export class SparqlUpdateWriter implements Writer {
  private readonly endpoint: URL;
  private readonly auth?: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly batchSize: number;
  private readonly graphIri: (dataset: Dataset) => URL;

  constructor(options: SparqlWriterOptions) {
    this.endpoint = options.endpoint;
    this.auth = options.auth;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.batchSize = options.batchSize ?? 10000;
    this.graphIri = options.graphIri ?? ((dataset) => dataset.iri);
  }

  async openRun(_context?: RunContext): Promise<SparqlUpdateRunWriter> {
    const clearedGraphs = new Set<string>();
    return {
      write: (dataset, quads) => this.writeQuads(clearedGraphs, dataset, quads),
      reset: async (dataset) => {
        // Forget the graph’s cleared state so the next write re-issues
        // CLEAR GRAPH, replacing the prior output instead of appending to it.
        clearedGraphs.delete(this.graphIri(dataset).toString());
      },
      commit: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
  }

  private async writeQuads(
    clearedGraphs: Set<string>,
    dataset: Dataset,
    quads: AsyncIterable<Quad>,
  ): Promise<void> {
    const graphUri = this.graphIri(dataset).toString();
    assertSafeIri(graphUri);

    if (!clearedGraphs.has(graphUri)) {
      await this.clearGraph(graphUri);
      clearedGraphs.add(graphUri);
    }

    for await (const chunk of batch(quads, this.batchSize)) {
      await this.insertBatch(graphUri, chunk);
    }
  }

  private async clearGraph(graphUri: string): Promise<void> {
    await this.executeUpdate(`CLEAR GRAPH <${graphUri}>`);
  }

  private async insertBatch(graphUri: string, quads: Quad[]): Promise<void> {
    const turtleData = await serializeQuads(quads, 'N-Triples');
    await this.executeUpdate(
      `INSERT DATA { GRAPH <${graphUri}> { ${turtleData} } }`,
    );
  }

  private async executeUpdate(query: string): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/sparql-update',
    };
    if (this.auth) {
      headers['Authorization'] = this.auth;
    }

    const response = await this.fetch(this.endpoint.toString(), {
      method: 'POST',
      headers,
      body: query,
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `SPARQL UPDATE failed with status ${response.status}: ${body}`,
      );
    }
    await response.body?.cancel();
  }
}
