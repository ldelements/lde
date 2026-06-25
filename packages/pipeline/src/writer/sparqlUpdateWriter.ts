import { Dataset, assertSafeIri } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { batch } from '../batch.js';
import { Writer } from './writer.js';
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
 * Writes RDF data to a SPARQL endpoint using SPARQL UPDATE INSERT DATA queries.
 *
 * Clears the named graph before the first write per dataset per instance, then
 * streams quads in batches to avoid accumulating the entire dataset in memory.
 * Subsequent calls to {@link write} for the same dataset append rather than replace.
 */
export class SparqlUpdateWriter implements Writer {
  private readonly endpoint: URL;
  private readonly auth?: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly batchSize: number;
  private readonly graphIri: (dataset: Dataset) => URL;
  private readonly clearedGraphs = new Set<string>();

  constructor(options: SparqlWriterOptions) {
    this.endpoint = options.endpoint;
    this.auth = options.auth;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.batchSize = options.batchSize ?? 10000;
    this.graphIri = options.graphIri ?? ((dataset) => dataset.iri);
  }

  async write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void> {
    const graphUri = this.graphIri(dataset).toString();
    assertSafeIri(graphUri);

    if (!this.clearedGraphs.has(graphUri)) {
      await this.clearGraph(graphUri);
      this.clearedGraphs.add(graphUri);
    }

    for await (const chunk of batch(quads, this.batchSize)) {
      await this.insertBatch(graphUri, chunk);
    }
  }

  async reset(dataset: Dataset): Promise<void> {
    // Forget the graph’s cleared state so the next write re-issues CLEAR GRAPH,
    // replacing the prior output instead of appending to it.
    this.clearedGraphs.delete(this.graphIri(dataset).toString());
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
