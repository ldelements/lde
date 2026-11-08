import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { DataFactory } from 'n3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SparqlContentHashReader } from '../src/index.js';

const PORT = 3017;
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/contentHashes.trig',
);
const { namedNode } = DataFactory;
const ex = (name: string) => namedNode(`https://example.org/${name}`);

describe('SparqlContentHashReader', () => {
  const reader = new SparqlContentHashReader({
    endpoint: new URL(`http://localhost:${PORT}/sparql`),
  });

  beforeAll(async () => {
    await startSparqlEndpoint(PORT, FIXTURE);
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  it('reads hashes from named graphs and the default graph', async () => {
    const hashes = await reader.read([
      ex('dataset-1'),
      ex('distribution-1'),
      ex('dataset-2'),
    ]);

    expect(Object.fromEntries(hashes)).toEqual({
      'https://example.org/dataset-1': {
        hash: 'rdfc10-sha256:aaa',
        version: 'conversion-1',
      },
      'https://example.org/distribution-1': {
        hash: 'rdfc10-sha256:bbb',
        version: 'conversion-1',
      },
      'https://example.org/dataset-2': {
        hash: 'rdfc10-sha256:ccc',
        version: 'conversion-1',
      },
    });
  });

  it('leaves out an IRI without a hash', async () => {
    const hashes = await reader.read([ex('never-written')]);

    expect(hashes.has('https://example.org/never-written')).toBe(false);
  });

  it('leaves out an IRI with more than one distinct hash', async () => {
    const hashes = await reader.read([ex('dataset-3'), ex('dataset-1')]);

    expect([...hashes.keys()]).toEqual(['https://example.org/dataset-1']);
  });

  it('reads nothing for no IRIs', async () => {
    expect((await reader.read([])).size).toBe(0);
  });
});
