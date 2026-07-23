import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessingRecord } from '../../src/index.js';
import { FileProvenanceStore } from '../../src/index.js';

const DATASET_URI = new URL('http://example.org/dataset/1');

const RECORD: ProcessingRecord = {
  sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
  pipelineVersion: 'v1',
  generatedAt: '2026-06-11T00:00:00.000Z',
  status: 'success',
};

describe('FileProvenanceStore', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lde-file-provenance-'));
    path = join(directory, 'provenance.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns null when the file does not exist yet', async () => {
    const store = new FileProvenanceStore({ path });

    expect(await store.get(DATASET_URI)).toBeNull();
  });

  it('round-trips a record', async () => {
    const store = new FileProvenanceStore({ path });

    await store.set(DATASET_URI, RECORD);

    expect(await store.get(DATASET_URI)).toEqual(RECORD);
  });

  it('returns null for a dataset with no record', async () => {
    const store = new FileProvenanceStore({ path });

    await store.set(DATASET_URI, RECORD);

    expect(await store.get(new URL('http://example.org/absent'))).toBeNull();
  });

  it('replaces the previous record for the same dataset', async () => {
    const store = new FileProvenanceStore({ path });

    await store.set(DATASET_URI, RECORD);
    const updated: ProcessingRecord = {
      ...RECORD,
      pipelineVersion: 'v2',
      status: 'failed',
    };
    await store.set(DATASET_URI, updated);

    expect(await store.get(DATASET_URI)).toEqual(updated);
  });

  it('keeps records for other datasets when writing one', async () => {
    const store = new FileProvenanceStore({ path });
    const otherUri = new URL('http://example.org/dataset/2');
    const otherRecord: ProcessingRecord = {
      ...RECORD,
      sourceFingerprint: null,
      status: 'failed',
    };

    await store.set(DATASET_URI, RECORD);
    await store.set(otherUri, otherRecord);

    expect(await store.get(DATASET_URI)).toEqual(RECORD);
    expect(await store.get(otherUri)).toEqual(otherRecord);
  });

  it('persists across store instances', async () => {
    await new FileProvenanceStore({ path }).set(DATASET_URI, RECORD);

    expect(await new FileProvenanceStore({ path }).get(DATASET_URI)).toEqual(
      RECORD,
    );
  });

  it('creates missing parent directories on write', async () => {
    const nestedPath = join(directory, 'state', 'nested', 'provenance.json');
    const store = new FileProvenanceStore({ path: nestedPath });

    await store.set(DATASET_URI, RECORD);

    expect(await store.get(DATASET_URI)).toEqual(RECORD);
  });

  it('leaves no temp file behind after a write', async () => {
    await new FileProvenanceStore({ path }).set(DATASET_URI, RECORD);

    expect(await readdir(directory)).toEqual(['provenance.json']);
  });

  it('writes human-readable JSON keyed by dataset URI', async () => {
    await new FileProvenanceStore({ path }).set(DATASET_URI, RECORD);

    const contents = await readFile(path, 'utf8');
    expect(JSON.parse(contents)).toEqual({ [DATASET_URI.toString()]: RECORD });
    // Pretty-printed with a trailing newline, so the file diffs cleanly.
    expect(contents).toContain('\n  ');
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('propagates read errors other than a missing file', async () => {
    // Reading a directory fails with EISDIR, not ENOENT, so it must throw.
    const store = new FileProvenanceStore({ path: directory });

    await expect(store.get(DATASET_URI)).rejects.toThrow();
  });

  it('propagates corruption instead of silently starting over', async () => {
    await writeFile(path, 'not json');
    const store = new FileProvenanceStore({ path });

    await expect(store.get(DATASET_URI)).rejects.toThrow();
    await expect(store.set(DATASET_URI, RECORD)).rejects.toThrow();
  });
});
