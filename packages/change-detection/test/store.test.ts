import type { DatasetCore, NamedNode } from '@rdfjs/types';
import { DataFactory, Parser, Store, Writer } from 'n3';
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  detectChange,
  SparqlContentHashReader,
  withContentHash,
} from '../src/index.js';

const { namedNode } = DataFactory;
const version = 'conversion-1';
const iri = namedNode('https://example.org/dataset');
const sharedGraph = 'https://example.org/health';

/** How a caller’s store lays out the documents it writes. */
interface Layout {
  name: string;
  write(endpoint: URL, document: DatasetCore, iri: NamedNode): Promise<void>;
}

const layouts: Layout[] = [
  {
    name: 'a named graph per document',
    write: (endpoint, document, iri) =>
      update(
        endpoint,
        `CLEAR SILENT GRAPH <${iri.value}> ;
         INSERT DATA { GRAPH <${iri.value}> { ${serialize(document)} } }`,
      ),
  },
  {
    name: 'one shared graph with a subject per document',
    write: (endpoint, document, iri) =>
      update(
        endpoint,
        `DELETE WHERE { GRAPH <${sharedGraph}> { <${iri.value}> ?p ?o } } ;
         INSERT DATA { GRAPH <${sharedGraph}> { ${serialize(document)} } }`,
      ),
  },
  {
    name: 'quads written as they are',
    write: (endpoint, document, iri) =>
      update(
        endpoint,
        `DELETE WHERE { <${iri.value}> ?p ?o } ;
         INSERT DATA { ${serialize(document)} }`,
      ),
  },
];

describe('hashes written with the document', () => {
  let container: StartedTestContainer;
  let queryEndpoint: URL;
  let updateEndpoint: URL;
  let reader: SparqlContentHashReader;

  beforeAll(async () => {
    container = await new GenericContainer('ghcr.io/oxigraph/oxigraph:0.5.13')
      .withExposedPorts(7878)
      .withCommand(['serve', '--bind', '0.0.0.0:7878'])
      .withWaitStrategy(Wait.forHttp('/', 7878).forStatusCode(200))
      .start();
    const base = `http://${container.getHost()}:${container.getMappedPort(7878)}`;
    queryEndpoint = new URL(`${base}/query`);
    updateEndpoint = new URL(`${base}/update`);
    reader = new SparqlContentHashReader({ endpoint: queryEndpoint });
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(async () => {
    await update(updateEndpoint, 'CLEAR ALL');
  });

  /** One crawl: read the stored hash, detect, and write unless unchanged. */
  async function crawl(layout: Layout, document: DatasetCore) {
    const previous = (await reader.read([iri])).get(iri.value);
    const { status, hash } = await detectChange(document, previous, version);
    if (status !== 'unchanged') {
      await layout.write(
        updateEndpoint,
        withContentHash(document, iri, hash),
        iri,
      );
    }
    return status;
  }

  describe.each(layouts)('$name', (layout) => {
    it('reads a written document back as unchanged', async () => {
      const document = parse('ex:dataset ex:title "A" .');

      expect(await crawl(layout, document)).toBe('created');
      expect(await crawl(layout, document)).toBe('unchanged');
    });

    it('keeps the old hash when a write fails, so the change is seen again', async () => {
      await crawl(layout, parse('ex:dataset ex:title "A" .'));
      const changed = parse('ex:dataset ex:title "B" .');
      const previous = (await reader.read([iri])).get(iri.value);
      const { hash } = await detectChange(changed, previous, version);

      // The document and its hash go out in one update; the store rejects it.
      await expect(
        update(
          updateEndpoint,
          `INSERT DATA { ${serialize(withContentHash(changed, iri, hash))} } ; not sparql`,
        ),
      ).rejects.toThrow();

      expect(await crawl(layout, changed)).toBe('changed');
    });

    it('returns created for every document after the store is emptied', async () => {
      const document = parse('ex:dataset ex:title "A" .');
      await crawl(layout, document);

      await update(updateEndpoint, 'CLEAR ALL');

      expect(await crawl(layout, document)).toBe('created');
    });
  });
});

function parse(turtle: string): Store {
  return new Store(
    new Parser().parse(`@prefix ex: <https://example.org/> .\n${turtle}`),
  );
}

function serialize(document: DatasetCore): string {
  return new Writer({ format: 'N-Triples' }).quadsToString([...document]);
}

async function update(endpoint: URL, query: string): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sparql-update' },
    body: query,
  });
  if (!response.ok) {
    throw new Error(
      `Update failed: ${response.status} ${await response.text()}`,
    );
  }
}
