import { Dataset, Distribution } from '@lde/dataset';
import type { DatasetWriter, Stage } from '@lde/pipeline';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import type { Quad } from '@rdfjs/types';
import { fetch as undiciFetch, setGlobalDispatcher, Agent } from 'undici';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { shaclSampleStages } from '../src/sampleStages.js';

// Pin fetch + dispatcher to one undici copy – see
// pipeline-void’s namespaceNormalization.integration.test.ts for the rationale.
setGlobalDispatcher(new Agent());

/** The SELECT queries sent since the last reset: one per subject-selector request. */
const selectQueries: string[] = [];
/** Make every subject-selector query that restricts to a path fail. */
let failPathQueries = false;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const query = queryOf(input, init);
  if (!query.startsWith('SELECT')) {
    return undiciFetch(input as never, init as never);
  }
  selectQueries.push(query);
  // Only a path query names a property, such as <https://schema.org/creator>.
  if (failPathQueries && /schema\.org\/[a-z]/.test(query)) {
    return Promise.reject(new Error('Path query failed'));
  }
  return undiciFetch(input as never, init as never);
}) as unknown as typeof globalThis.fetch;

function queryOf(input: string | URL | Request, init?: RequestInit): string {
  const url = new URL(input instanceof Request ? input.url : input);
  const body = init?.body;
  return (
    url.searchParams.get('query') ??
    (body instanceof URLSearchParams ? body.get('query') : null) ??
    (typeof body === 'string' ? body : '')
  );
}

const shapesFile = fileURLToPath(
  new URL('./fixtures/schema-profile.ttl', import.meta.url),
);
const fixture = fileURLToPath(
  new URL('./fixtures/described-and-bare.ttl', import.meta.url),
);

const dataset = new Dataset({
  iri: new URL('https://example.org/dataset'),
  distributions: [],
});

/** The instances of `type` the stage sampled: the subjects of its type triples in the output. */
async function sampledInstances(
  stage: Stage,
  distribution: Distribution,
  type = 'https://schema.org/CreativeWork',
): Promise<string[]> {
  const quads: Quad[] = [];
  const writer: DatasetWriter = {
    async write(_dataset, data) {
      for await (const quad of data) quads.push(quad);
    },
  };
  await stage.run(dataset, distribution, writer);
  // Not deduplicated: a subject sampled twice shows up twice.
  return quads
    .filter(
      (quad) =>
        quad.predicate.value ===
          'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
        quad.object.value === type,
    )
    .map((quad) => quad.subject.value)
    .sort();
}

async function sampleStage(
  name: string,
  options: Partial<Parameters<typeof shaclSampleStages>[0]>,
): Promise<Stage> {
  const stages = await shaclSampleStages({ shapesFile, ...options });
  const stage = stages.find((candidate) => candidate.name === name);
  if (!stage) throw new Error(`No ${name} stage`);
  return stage;
}

function creativeWorkStage(
  options: Partial<Parameters<typeof shaclSampleStages>[0]>,
): Promise<Stage> {
  return sampleStage('shacl-sample-CreativeWork', options);
}

describe('shaclSampleStages subject selection (end to end)', () => {
  // Unique across the repo's integration suites – nx runs packages' tests
  // concurrently, so a shared port is a flaky EADDRINUSE.
  const port = 3021;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  beforeEach(() => {
    selectQueries.length = 0;
    failPathQueries = false;
  });

  it('samples subjects that use a path the shape checks before bare ones that sort first', async () => {
    const stage = await creativeWorkStage({ samplesPerClass: 1 });
    expect(await sampledInstances(stage, distribution)).toEqual([
      'https://example.org/z-described-1',
    ]);
    // The class is larger than the sample, so the paths are queried too.
    expect(selectQueries.length).toBeGreaterThan(1);
  }, 30_000);

  it('matches the paths under namespace aliases too', async () => {
    const stage = await creativeWorkStage({
      samplesPerClass: 2,
      namespaceAliases: [
        { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
      ],
    });
    expect(await sampledInstances(stage, distribution)).toEqual([
      'https://example.org/z-described-1',
      'https://example.org/z-described-2',
    ]);
  }, 30_000);

  it('fills up the sample with bare subjects', async () => {
    const stage = await creativeWorkStage({ samplesPerClass: 4 });
    expect(await sampledInstances(stage, distribution)).toEqual([
      'https://example.org/a-bare-1',
      'https://example.org/a-bare-2',
      'https://example.org/a-bare-3',
      'https://example.org/z-described-1',
    ]);
  }, 30_000);

  it('samples every instance once when the class is smaller than the sample', async () => {
    const stage = await creativeWorkStage({ samplesPerClass: 10 });
    expect(await sampledInstances(stage, distribution)).toEqual([
      'https://example.org/a-bare-1',
      'https://example.org/a-bare-2',
      'https://example.org/a-bare-3',
      'https://example.org/z-described-1',
      'https://example.org/z-described-2',
    ]);
    expect(selectQueries).toHaveLength(1);
  }, 30_000);

  it('samples an instance once when it uses several paths and also sorts first', async () => {
    const stage = await sampleStage('shacl-sample-Person', {
      samplesPerClass: 2,
    });
    expect(
      await sampledInstances(stage, distribution, 'https://schema.org/Person'),
    ).toEqual(['https://example.org/p-1', 'https://example.org/p-2']);
  }, 30_000);

  it('samples a class of exactly samplesPerClass instances in one request', async () => {
    const stage = await creativeWorkStage({ samplesPerClass: 5 });
    expect(await sampledInstances(stage, distribution)).toHaveLength(5);
    expect(selectQueries).toHaveLength(1);
  }, 30_000);

  it('falls back to the first instances by IRI when a path query fails', async () => {
    failPathQueries = true;
    const stage = await creativeWorkStage({ samplesPerClass: 2 });
    expect(await sampledInstances(stage, distribution)).toEqual([
      'https://example.org/a-bare-1',
      'https://example.org/a-bare-2',
    ]);
  }, 30_000);

  it('selects from a class the dataset lacks in one request', async () => {
    const stage = await sampleStage('shacl-sample-Place', {});
    expect(
      await sampledInstances(stage, distribution, 'https://schema.org/Place'),
    ).toEqual([]);
    expect(selectQueries).toHaveLength(1);
  }, 30_000);
});
