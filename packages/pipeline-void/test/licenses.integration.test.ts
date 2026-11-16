import { detectLicenses } from '../src/index.js';
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
  new URL('./fixtures/licenses.ttl', import.meta.url),
);

const VOID = 'http://rdfs.org/ns/void#';
const DCTERMS = 'http://purl.org/dc/terms/';

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

/** Each `dcterms:license` the stage emits, mapped to its `void:triples`. */
async function triplesByLicense(
  distribution: Distribution,
): Promise<Record<string, string | undefined>> {
  const quads: Quad[] = [];
  const writer: DatasetWriter = {
    async write(_dataset, data) {
      for await (const quad of data) quads.push(quad);
    },
  };
  await (await detectLicenses()).run(dataset, distribution, writer);

  return Object.fromEntries(
    quads
      .filter((quad) => quad.predicate.value === `${DCTERMS}license`)
      .map((license) => [
        license.object.value,
        quads.find(
          (quad) =>
            quad.subject.equals(license.subject) &&
            quad.predicate.value === `${VOID}triples`,
        )?.object.value,
      ]),
  );
}

describe('licenses (end to end)', () => {
  // Unique across the repo's integration suites – nx runs packages' tests
  // concurrently, so a shared port is a flaky EADDRINUSE.
  const port = 3018;
  const distribution = Distribution.sparql(
    new URL(`http://localhost:${port}/sparql`),
  );

  beforeAll(async () => {
    await startSparqlEndpoint(port, fixture);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  }, 30_000);

  it('counts IRI licenses and skips literal ones', async () => {
    expect(await triplesByLicense(distribution)).toEqual({
      'http://creativecommons.org/publicdomain/zero/1.0/': '2',
    });
  }, 30_000);
});
