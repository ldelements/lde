import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import type { Quad } from '@rdfjs/types';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { FileLoadedSparqlProvenanceStore } from '../../src/provenance/fileLoadedSparqlProvenanceStore.js';
import { assertNoBlankNodes } from '../../src/index.js';

const PORT = 3004;
const QUERY_ENDPOINT = `http://localhost:${PORT}/sparql`;
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/provenanceRecords.trig',
);

const PIPELINE_IRI = 'http://example.org/pipeline/dkg';
const DATASET_IRI = 'http://example.org/dataset/1';
const PROV = 'http://www.w3.org/ns/prov#';
const LDE = 'https://w3id.org/lde/provenance#';

/** Read the single provenance file written into `dir` and parse its quads. */
async function readQuads(dir: string): Promise<Quad[]> {
  const files = await readdir(dir);
  const nquads = files.filter((file) => file.endsWith('.nq'));
  expect(nquads).toHaveLength(1);
  const content = await readFile(join(dir, nquads[0]), 'utf8');
  return new Parser({ format: 'N-Quads' }).parse(content) as Quad[];
}

function objectOf(quads: Quad[], predicate: string): string | undefined {
  return quads.find((quad) => quad.predicate.value === predicate)?.object.value;
}

describe('FileLoadedSparqlProvenanceStore', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'lde-provenance-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function store(): FileLoadedSparqlProvenanceStore {
    return new FileLoadedSparqlProvenanceStore({
      queryEndpoint: new URL('http://example.org/sparql'),
      pipelineIri: new URL(PIPELINE_IRI),
      outputDir,
    });
  }

  describe('set', () => {
    it('writes the record as PROV-O quads in the pipeline provenance graph', async () => {
      await store().set(new URL(DATASET_IRI), {
        sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
        pipelineVersion: 'v1',
        generatedAt: '2026-06-11T00:00:00.000Z',
        status: 'success',
      });

      const quads = await readQuads(outputDir);

      // No blank nodes: they fuse across datasets in a cat-built index (#474).
      assertNoBlankNodes(quads);

      // Every quad lands in the pipeline provenance graph, keyed by dataset URI.
      expect(quads.length).toBeGreaterThan(0);
      for (const quad of quads) {
        expect(quad.graph.value).toBe(PIPELINE_IRI);
        expect(quad.subject.value).toBe(DATASET_IRI);
      }

      expect(objectOf(quads, `${PROV}generatedAtTime`)).toBe(
        '2026-06-11T00:00:00.000Z',
      );
      expect(objectOf(quads, `${LDE}sourceFingerprint`)).toBe(
        '2024-06-01T00:00:00.000Z|1000',
      );
      expect(objectOf(quads, `${LDE}pipelineVersion`)).toBe('v1');
      expect(objectOf(quads, `${LDE}status`)).toBe('success');
    });

    it('omits the fingerprint triple when the fingerprint is null', async () => {
      await store().set(new URL(DATASET_IRI), {
        sourceFingerprint: null,
        pipelineVersion: 'v1',
        generatedAt: '2026-06-11T00:00:00.000Z',
        status: 'failed',
      });

      const quads = await readQuads(outputDir);

      // No fingerprint triple at all, so get() reconstructs it as null rather
      // than an empty-string literal that could spuriously compare equal.
      expect(objectOf(quads, `${LDE}sourceFingerprint`)).toBeUndefined();
      expect(objectOf(quads, `${LDE}pipelineVersion`)).toBe('v1');
      expect(objectOf(quads, `${LDE}status`)).toBe('failed');
    });
  });

  describe('get', () => {
    beforeAll(async () => {
      await startSparqlEndpoint(PORT, FIXTURE);
    }, 60_000);

    afterAll(async () => {
      await teardownSparqlEndpoint();
    });

    function getStore(pipelineIri: string): FileLoadedSparqlProvenanceStore {
      return new FileLoadedSparqlProvenanceStore({
        queryEndpoint: new URL(QUERY_ENDPOINT),
        pipelineIri: new URL(pipelineIri),
        outputDir,
      });
    }

    it('reads back a stored record from the pipeline graph', async () => {
      const record = await getStore(PIPELINE_IRI).get(new URL(DATASET_IRI));

      expect(record).toEqual({
        sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
        pipelineVersion: 'v1',
        generatedAt: '2026-06-11T00:00:00.000Z',
        status: 'success',
      });
    });

    it('returns null for a dataset with no record', async () => {
      const record = await getStore(PIPELINE_IRI).get(
        new URL('http://example.org/dataset/absent'),
      );

      expect(record).toBeNull();
    });

    it('reconstructs a null fingerprint when the fingerprint triple is absent', async () => {
      const record = await getStore(PIPELINE_IRI).get(
        new URL('http://example.org/dataset/3'),
      );

      expect(record).toEqual({
        sourceFingerprint: null,
        pipelineVersion: 'v1',
        generatedAt: '2026-06-11T00:00:00.000Z',
        status: 'failed',
      });
    });

    it('is scoped by pipeline IRI: another pipeline’s record does not leak', async () => {
      // dataset/1 has a record in both the dkg and the other pipeline graph.
      // Querying as dkg must return dkg's record, never the other one.
      const record = await getStore(PIPELINE_IRI).get(new URL(DATASET_IRI));
      expect(record?.pipelineVersion).toBe('v1');

      // Querying as the other pipeline returns its own, different record.
      const other = await getStore('http://example.org/pipeline/other').get(
        new URL(DATASET_IRI),
      );
      expect(other?.pipelineVersion).toBe('other-v9');
      expect(other?.sourceFingerprint).toBe('other-fingerprint|999');
    });

    it('rejects an IRI with characters that could break out of the SPARQL query', async () => {
      // A real URL normalises unsafe characters, so simulate a non-normalised
      // IRI reaching the store to confirm it is rejected before querying.
      const unsafe = {
        toString: () => 'http://example.org/d> } GRAPH <evil> { ?s ?p ?o',
      } as unknown as URL;

      await expect(getStore(PIPELINE_IRI).get(unsafe)).rejects.toThrow(
        'unsafe characters',
      );
    });
  });
});
