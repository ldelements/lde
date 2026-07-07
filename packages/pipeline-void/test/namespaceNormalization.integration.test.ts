import {
  classPartitions,
  classPropertyObjects,
  classPropertySubjects,
  perClassDatatypes,
  perClassLanguages,
  perClassObjectClasses,
  Stage,
} from '../src/index.js';
import type { NamespaceAlias } from '../src/index.js';
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

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// The @lde/pipeline import chain pulls in a package copy of undici (via
// rdf-parse → @comunica/actor-http-fetch) whose module init registers its
// global dispatcher under the symbol Node’s built-in fetch also reads. Mixing
// Node’s fetch with a foreign-version dispatcher fails on some Node versions
// (“invalid content-length header”), so pin fetch and dispatcher to one and
// the same undici copy for this endpoint-backed test.
setGlobalDispatcher(new Agent());
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;

const namespaceAliases: NamespaceAlias[] = [
  { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
];

const VOID = 'http://rdfs.org/ns/void#';
const VOID_EXT = 'http://ldf.fi/void-ext#';
const CREATIVE_WORK = 'https://schema.org/CreativeWork';

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

function collectingWriter(): DatasetWriter & { quads: Quad[] } {
  const quads: Quad[] = [];
  return {
    quads,
    async write(_dataset, data) {
      for await (const quad of data) quads.push(quad);
    },
  };
}

async function runAll(
  stages: Stage[],
  distribution: Distribution,
): Promise<Quad[]> {
  const writer = collectingWriter();
  for (const stage of stages) {
    await stage.run(dataset, distribution, writer);
  }
  return writer.quads;
}

function objectsOf(quads: Quad[], subject: string, predicate: string) {
  return quads
    .filter(
      (q) => q.subject.value === subject && q.predicate.value === predicate,
    )
    .map((q) => q.object.value);
}

/** The single value of `subject predicate ?o`, expected to be unique. */
function only(quads: Quad[], subject: string, predicate: string): string {
  const values = objectsOf(quads, subject, predicate);
  expect(values).toHaveLength(1);
  return values[0];
}

describe('namespace-alias normalization (end to end)', () => {
  const port = 3005;
  const distribution = () =>
    Distribution.sparql(new URL(`http://localhost:${port}/sparql`));

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture('mixedNamespaces.ttl'));
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  it('merges the class partition and sums entities over disjoint variants', async () => {
    const quads = await runAll(
      [await classPartitions({ namespaceAliases })],
      distribution(),
    );

    const creativeWorkPartitions = quads.filter(
      (q) =>
        q.predicate.value === `${VOID}class` &&
        q.object.value === CREATIVE_WORK,
    );
    expect(creativeWorkPartitions).toHaveLength(1);
    // work1,work2 (http) + work3,work4 (https), disjoint → 4.
    expect(
      only(quads, creativeWorkPartitions[0].subject.value, `${VOID}entities`),
    ).toBe('4');
  }, 30_000);

  it('merges the property partition and keeps distinctObjects exact', async () => {
    const quads = await runAll(
      [
        await classPropertySubjects({ namespaceAliases, batchSize: 1 }),
        await classPropertyObjects({ namespaceAliases, batchSize: 1 }),
      ],
      distribution(),
    );

    const nameProperties = quads.filter(
      (q) =>
        q.predicate.value === `${VOID}property` &&
        q.object.value === 'https://schema.org/name',
    );
    expect(nameProperties).toHaveLength(1);
    const namePartition = nameProperties[0].subject.value;

    // Subjects with name: work1..work4, summed across variants (predicate-disjoint) → 4.
    expect(only(quads, namePartition, `${VOID}entities`)).toBe('4');

    // distinctObjects stays exact: {"A","Shared","B"} = 3 — work2’s http:name
    // "Shared" and work3’s https:name "Shared" collapse. A naive sum would be 4.
    expect(only(quads, namePartition, `${VOID}distinctObjects`)).toBe('3');
  }, 30_000);

  it('merges the void-ext partitions (datatype, language, object class)', async () => {
    const quads = await runAll(
      [
        await perClassDatatypes({ namespaceAliases, batchSize: 1 }),
        await perClassLanguages({ namespaceAliases, batchSize: 1 }),
        await perClassObjectClasses({ namespaceAliases, batchSize: 1 }),
      ],
      distribution(),
    );

    // One datatype partition for (CreativeWork, name, xsd:string): 4 name
    // triples across both namespace variants (the @nl description literal
    // makes a separate rdf:langString partition, excluded here).
    const stringDatatypePartitions = quads.filter(
      (q) =>
        q.predicate.value === `${VOID_EXT}datatype` &&
        q.object.value === 'http://www.w3.org/2001/XMLSchema#string',
    );
    expect(stringDatatypePartitions).toHaveLength(1);
    expect(
      only(quads, stringDatatypePartitions[0].subject.value, `${VOID}triples`),
    ).toBe('4');

    // Language partition for (CreativeWork, description, nl): work3 only.
    const languagePartitions = quads.filter(
      (q) => q.predicate.value === `${VOID_EXT}language`,
    );
    expect(languagePartitions).toHaveLength(1);
    expect(languagePartitions[0].object.value).toBe('nl');

    // Object-class partition for (CreativeWork, author, Person): canonicalized.
    const objectClasses = quads
      .filter(
        (q) =>
          q.predicate.value === `${VOID}class` &&
          q.object.value.endsWith('/Person'),
      )
      .map((q) => q.object.value);
    expect(objectClasses).toEqual(['https://schema.org/Person']);
  }, 30_000);

  it('emits two class partitions when no aliases are configured', async () => {
    const quads = await runAll([await classPartitions()], distribution());
    const creativeWorkVariants = quads
      .filter(
        (q) =>
          q.predicate.value === `${VOID}class` &&
          q.object.value.includes('CreativeWork'),
      )
      .map((q) => q.object.value)
      .sort();
    expect(creativeWorkVariants).toEqual([
      'http://schema.org/CreativeWork',
      'https://schema.org/CreativeWork',
    ]);
  }, 30_000);
});

describe('namespace-alias normalization (disjointness violation)', () => {
  const port = 3006;
  const distribution = () =>
    Distribution.sparql(new URL(`http://localhost:${port}/sparql`));

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture('dualTypedNamespaces.ttl'));
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  it('over-counts entities for a resource typed under both namespace variants', async () => {
    const quads = await runAll(
      [await classPartitions({ namespaceAliases })],
      distribution(),
    );
    const creativeWorkPartitions = quads.filter(
      (q) =>
        q.predicate.value === `${VOID}class` &&
        q.object.value === CREATIVE_WORK,
    );
    expect(creativeWorkPartitions).toHaveLength(1);
    // Documented limitation: the doubly-typed resource is summed 1 + 1 = 2,
    // not deduped to 1. The transform assumes this case does not occur.
    expect(
      only(quads, creativeWorkPartitions[0].subject.value, `${VOID}entities`),
    ).toBe('2');
  }, 30_000);
});
