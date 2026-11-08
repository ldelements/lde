import { assertSafeIri } from '@lde/dataset';
import type { NamedNode, Term } from '@rdfjs/types';
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import type { ContentHash } from './detectChange.js';
import { contentHashPredicate, hashVersionPredicate } from './vocabulary.js';

/** Options for {@link SparqlContentHashReader}. */
export interface SparqlContentHashReaderOptions {
  /** The SPARQL query endpoint that holds the written documents. */
  endpoint: URL;
  /**
   * Fetch implementation for the query, e.g. one that adds an Authorization
   * header or aborts after a timeout.
   * @default globalThis.fetch
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Reads the hashes that {@link withContentHash} stored with written
 * documents, in the default graph or any named graph.
 */
export class SparqlContentHashReader {
  private readonly endpoint: URL;
  private readonly fetcher: SparqlEndpointFetcher;

  constructor(options: SparqlContentHashReaderOptions) {
    this.endpoint = options.endpoint;
    this.fetcher = new SparqlEndpointFetcher({ fetch: options.fetch });
  }

  /**
   * Read the stored hashes of the given documents in one query, keyed by IRI.
   *
   * An IRI is missing from the result when no hash is stored for it, and also
   * when more than one distinct hash is (a document written into two
   * graphs): either way the caller passes `undefined` to {@link detectChange}
   * and writes the document again.
   *
   * @param iris The documents’ IRIs, as passed to {@link withContentHash}.
   */
  async read(iris: NamedNode[]): Promise<Map<string, ContentHash>> {
    if (iris.length === 0) return new Map();

    const stream = (await this.fetcher.fetchBindings(
      this.endpoint.toString(),
      selectQuery(iris),
    )) as AsyncIterable<Record<string, Term>>;

    const found = new Map<string, ContentHash[]>();
    for await (const binding of stream) {
      const hashes = found.get(binding.iri.value) ?? [];
      hashes.push({ hash: binding.hash.value, version: binding.version.value });
      found.set(binding.iri.value, hashes);
    }

    return new Map(
      [...found]
        .filter(([, hashes]) => hashes.length === 1)
        .map(([iri, [hash]]) => [iri, hash]),
    );
  }
}

function selectQuery(iris: NamedNode[]): string {
  const values = iris
    .map((iri) => {
      assertSafeIri(iri.value);
      return `<${iri.value}>`;
    })
    .join(' ');
  const pattern = `?iri <${contentHashPredicate.value}> ?hash ; <${hashVersionPredicate.value}> ?version .`;
  return `SELECT DISTINCT ?iri ?hash ?version WHERE {
    VALUES ?iri { ${values} }
    { ${pattern} } UNION { GRAPH ?graph { ${pattern} } }
  }`;
}
