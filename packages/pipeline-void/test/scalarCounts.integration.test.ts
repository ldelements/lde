import {
  countObjectLiterals,
  countObjectUris,
  countProperties,
  countSubjects,
  countTriples,
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

// Pin fetch + dispatcher to one undici copy – see
// namespaceNormalization.integration.test.ts for the rationale.
setGlobalDispatcher(new Agent());
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;

const fixture = fileURLToPath(
  new URL('./fixtures/mixedNamespaces.ttl', import.meta.url),
);

const VOID = 'http://rdfs.org/ns/void#';
const VOID_EXT = 'http://ldf.fi/void-ext#';

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

// These queries' WHERE clause is a bare sub-SELECT, which the dataset VALUES
// injection must keep syntactically valid.
describe('scalar count stages (end to end)', () => {
  // Unique across the repo's integration suites – nx runs packages' tests
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

  // Expected counts follow from mixedNamespaces.ttl.
  it.each<[string, () => Promise<Stage>, string, string]>([
    ['countSubjects', countSubjects, `${VOID}distinctSubjects`, '5'],
    ['countTriples', countTriples, `${VOID}triples`, '11'],
    ['countProperties', countProperties, `${VOID}properties`, '5'],
    [
      'countObjectLiterals',
      countObjectLiterals,
      `${VOID_EXT}distinctLiterals`,
      '4',
    ],
    [
      'countObjectUris',
      countObjectUris,
      `${VOID_EXT}distinctIRIReferenceObjects`,
      '4',
    ],
  ])(
    '%s',
    async (_name, createStage, predicate, expected) => {
      const quads: Quad[] = [];
      const writer: DatasetWriter = {
        async write(_dataset, data) {
          for await (const q of data) quads.push(q);
        },
      };

      await (await createStage()).run(dataset, distribution, writer);

      const counts = quads
        .filter(
          (q) =>
            q.subject.value === dataset.iri.toString() &&
            q.predicate.value === predicate,
        )
        .map((q) => q.object.value);
      expect(counts).toEqual([expected]);
    },
    30_000,
  );
});
