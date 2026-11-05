import { detectVocabularies, Stage } from '../src/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import type { DatasetWriter } from '@lde/pipeline';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import type { Quad } from '@rdfjs/types';
import { fetch as undiciFetch, setGlobalDispatcher, Agent } from 'undici';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Pin fetch + dispatcher to one undici copy – see
// namespaceNormalization.integration.test.ts for the rationale.
setGlobalDispatcher(new Agent());
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;

const fixture = fileURLToPath(
  new URL('./fixtures/mixedNamespaces.ttl', import.meta.url),
);

const VOID = 'http://rdfs.org/ns/void#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

function collectingWriter(): DatasetWriter & { quads: Quad[] } {
  const quads: Quad[] = [];
  return {
    quads,
    async write(_dataset, data) {
      for await (const q of data) quads.push(q);
    },
  };
}

async function runStage(
  stage: Stage,
  distribution: Distribution,
): Promise<Quad[]> {
  const writer = collectingWriter();
  await stage.run(dataset, distribution, writer);
  return writer.quads;
}

/** The partition node for a property, from the stage output. */
function partitionOf(quads: Quad[], property: string): string {
  const partition = quads.find(
    (q) =>
      q.predicate.value === `${VOID}property` && q.object.value === property,
  );
  expect(partition, `partition for ${property}`).toBeDefined();
  return partition!.subject.value;
}

function objectsOf(quads: Quad[], subject: string, predicate: string) {
  return quads
    .filter(
      (q) => q.subject.value === subject && q.predicate.value === predicate,
    )
    .map((q) => q.object.value);
}

/** Canonical quad strings, deduplicated – chunked runs may repeat quads. */
function canonical(quads: Quad[]): Set<string> {
  return new Set(
    quads.map(
      (q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`,
    ),
  );
}

describe('per-property partition chunking (end to end)', () => {
  // Unique across the repo's integration suites – nx runs packages' tests
  // concurrently, so a shared port is a flaky EADDRINUSE.
  const port = 3013;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  it('emits the same output chunked (batchSize 1) as unchunked', async () => {
    const chunked = await runStage(
      await detectVocabularies({ batchSize: 1 }),
      distribution,
    );
    const unchunked = await runStage(
      await detectVocabularies({ perProperty: false }),
      distribution,
    );

    expect(canonical(chunked)).toEqual(canonical(unchunked));
  }, 30_000);

  it('counts entities and distinctObjects per property', async () => {
    const out = await runStage(
      await detectVocabularies({ batchSize: 1 }),
      distribution,
    );

    // rdf:type: work1–4 + person1 → 5 subjects; 3 distinct class objects.
    const typePartition = partitionOf(out, RDF_TYPE);
    expect(objectsOf(out, typePartition, `${VOID}entities`)).toEqual(['5']);
    expect(objectsOf(out, typePartition, `${VOID}distinctObjects`)).toEqual([
      '3',
    ]);

    // http-namespace name: work1 ("A"), work2 ("Shared") → 2 subjects, 2 objects.
    const namePartition = partitionOf(out, 'http://schema.org/name');
    expect(objectsOf(out, namePartition, `${VOID}entities`)).toEqual(['2']);
    expect(objectsOf(out, namePartition, `${VOID}distinctObjects`)).toEqual([
      '2',
    ]);
  }, 30_000);

  it('scopes property selection to the distribution’s named graph', async () => {
    // The fixture loads into the default graph, so a named-graph-scoped
    // distribution selects no properties and yields no partitions.
    const namedGraphDistribution = Distribution.sparql(
      new URL(`http://localhost:${port}/sparql`),
      'http://example.org/other-graph',
    );

    const out = await runStage(
      await detectVocabularies({ batchSize: 1 }),
      namedGraphDistribution,
    );

    expect(
      out.filter((q) => q.predicate.value === `${VOID}property`),
    ).toHaveLength(0);
  }, 30_000);

  it('detects vocabularies across property batches', async () => {
    const out = await runStage(
      await detectVocabularies({ batchSize: 1 }),
      distribution,
    );

    const vocabularies = out
      .filter((q) => q.predicate.value === `${VOID}vocabulary`)
      .map((q) => q.object.value);
    expect(vocabularies).toContain('http://schema.org/');

    // Emitted once per vocabulary, not once per property batch that
    // matches it – both schema.org name variants map to their namespace.
    expect(new Set(vocabularies).size).toBe(vocabularies.length);
  }, 30_000);
});
