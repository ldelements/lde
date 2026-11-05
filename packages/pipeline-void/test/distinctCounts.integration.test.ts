import {
  countObjectLiterals,
  countObjectUris,
  countSubjects,
} from '../src/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import type { DatasetWriter, Stage } from '@lde/pipeline';
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
  new URL('./fixtures/distinctCounts.ttl', import.meta.url),
);

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

/** The object of the one `predicate` triple the stage emits. */
async function count(
  stage: Promise<Stage>,
  distribution: Distribution,
  predicate: string,
): Promise<string | undefined> {
  const quads: Quad[] = [];
  const writer: DatasetWriter = {
    async write(_dataset, data) {
      for await (const quad of data) quads.push(quad);
    },
  };
  await (await stage).run(dataset, distribution, writer);

  return quads.find((quad) => quad.predicate.value === predicate)?.object.value;
}

describe('distinct counts (end to end)', () => {
  // Unique across the repo’s integration suites – nx runs packages’ tests
  // concurrently, so a shared port is a flaky EADDRINUSE.
  const port = 3016;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  it('counts distinct non-blank subjects', async () => {
    expect(
      await count(
        countSubjects(),
        distribution,
        'http://rdfs.org/ns/void#distinctSubjects',
      ),
    ).toBe('3');
  }, 30_000);

  it('counts distinct IRI objects', async () => {
    expect(
      await count(
        countObjectUris(),
        distribution,
        'http://ldf.fi/void-ext#distinctIRIReferenceObjects',
      ),
    ).toBe('3');
  }, 30_000);

  it('counts distinct literal objects, telling datatypes apart', async () => {
    expect(
      await count(
        countObjectLiterals(),
        distribution,
        'http://ldf.fi/void-ext#distinctLiterals',
      ),
    ).toBe('5');
  }, 30_000);
});
