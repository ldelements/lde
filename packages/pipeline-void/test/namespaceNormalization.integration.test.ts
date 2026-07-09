import {
  classPartitions,
  classPropertyObjects,
  classPropertySubjects,
  perClassDatatypes,
  perClassLanguages,
  perClassObjectClasses,
  schemaOrgPartitionMergePlugin,
  Stage,
} from '../src/index.js';
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

// See the note in the removed per-stage test: pin fetch + dispatcher to one
// undici copy so the @lde/pipeline import chain's foreign dispatcher does not
// break Node's built-in fetch on some Node versions.
setGlobalDispatcher(new Agent());
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;

const fixture = fileURLToPath(
  new URL('./fixtures/mixedNamespaces.ttl', import.meta.url),
);

const VOID = 'http://rdfs.org/ns/void#';
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
      for await (const q of data) quads.push(q);
    },
  };
}

function objectsOf(quads: Quad[], subject: string, predicate: string) {
  return quads
    .filter(
      (q) => q.subject.value === subject && q.predicate.value === predicate,
    )
    .map((q) => q.object.value);
}

/**
 * Run the plain VoID partition stages, concatenate their output as the pipeline
 * would present a whole dataset to `beforeDatasetWrite`, then apply the plugin.
 */
async function analyzeAndNormalize(
  distribution: Distribution,
): Promise<Quad[]> {
  const stages: Stage[] = [
    await classPartitions(),
    await classPropertySubjects({ batchSize: 1 }),
    await classPropertyObjects({ batchSize: 1 }),
    await perClassDatatypes({ batchSize: 1 }),
    await perClassLanguages({ batchSize: 1 }),
    await perClassObjectClasses({ batchSize: 1 }),
  ];
  const writer = collectingWriter();
  for (const stage of stages) {
    await stage.run(dataset, distribution, writer);
  }
  const transform = schemaOrgPartitionMergePlugin().beforeDatasetWrite!;
  const out: Quad[] = [];
  for await (const q of transform(
    (async function* () {
      yield* writer.quads;
    })(),
    { dataset },
  )) {
    out.push(q);
  }
  return out;
}

describe('schema.org normalization plugin (end to end)', () => {
  const port = 3005;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  it('collapses the http/https CreativeWork partitions the plain queries emit', async () => {
    const out = await analyzeAndNormalize(distribution);

    const creativeWorkPartitions = new Set(
      out
        .filter(
          (q) =>
            q.predicate.value === `${VOID}class` &&
            q.object.value === CREATIVE_WORK,
        )
        .map((q) => q.subject.value),
    );
    expect(creativeWorkPartitions.size).toBe(1);

    const [cp] = [...creativeWorkPartitions];
    // work1,work2 (http) + work3,work4 (https), disjoint subjects → 4.
    expect(objectsOf(out, cp, `${VOID}entities`)).toEqual(['4']);
  }, 30_000);

  it('merges the name property partition (entities exact; distinctObjects summed)', async () => {
    const out = await analyzeAndNormalize(distribution);

    const nameProperties = out.filter(
      (q) =>
        q.predicate.value === `${VOID}property` &&
        q.object.value === 'https://schema.org/name',
    );
    expect(nameProperties).toHaveLength(1);
    const namePartition = nameProperties[0].subject.value;

    // Distinct subjects with name across variants → 4 (exact, disjoint subjects).
    expect(objectsOf(out, namePartition, `${VOID}entities`)).toEqual(['4']);
    // This fixture deliberately mixes http:name and https:name on CreativeWork,
    // so distinctObjects is summed (2 + 2 = 4) rather than deduped to the exact
    // union {"A","Shared","B"} = 3 — the documented over-count for mixed data.
    expect(objectsOf(out, namePartition, `${VOID}distinctObjects`)).toEqual([
      '4',
    ]);
  }, 30_000);
});
