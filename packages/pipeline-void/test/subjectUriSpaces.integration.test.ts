import { subjectUriSpaces } from '../src/index.js';
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
  new URL('./fixtures/hashUriSpaces.ttl', import.meta.url),
);

const VOID = 'http://rdfs.org/ns/void#';

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

/** Each `void:uriSpace` the stage emits, mapped to its `void:entities`. */
async function entitiesByUriSpace(
  distribution: Distribution,
): Promise<Record<string, string | undefined>> {
  const quads: Quad[] = [];
  const writer: DatasetWriter = {
    async write(_dataset, data) {
      for await (const quad of data) quads.push(quad);
    },
  };
  await (await subjectUriSpaces()).run(dataset, distribution, writer);

  return Object.fromEntries(
    quads
      .filter((quad) => quad.predicate.value === `${VOID}uriSpace`)
      .map((uriSpace) => [
        uriSpace.object.value,
        quads.find(
          (quad) =>
            quad.subject.equals(uriSpace.subject) &&
            quad.predicate.value === `${VOID}entities`,
        )?.object.value,
      ]),
  );
}

describe('subject URI spaces (end to end)', () => {
  // Unique across the repo's integration suites – nx runs packages' tests
  // concurrently, so a shared port is a flaky EADDRINUSE.
  const port = 3014;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  it('groups hash IRIs by document, or by directory when it holds several documents', async () => {
    expect(await entitiesByUriSpace(distribution)).toEqual({
      'https://hdl.handle.net/21.12153/': '8',
      'http://example.org/vocab/core#': '2',
      'http://example.com/data#': '3',
      'http://a.example#': '2',
      'http://b.example#': '2',
    });
  }, 30_000);
});
