import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Distribution } from '@lde/dataset';
import { join, resolve } from 'node:path';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { needsPreprocessing, preprocess } from '../src/preprocess.js';

function makeDistribution(mediaType: string, compressFormat?: string) {
  const distribution = new Distribution(
    new URL('https://example.com/dataset/distribution'),
    mediaType,
  );
  if (compressFormat !== undefined) {
    distribution.compressFormat = compressFormat;
  }
  return distribution;
}

describe('needsPreprocessing', () => {
  it('returns false for native QLever formats', () => {
    expect(needsPreprocessing(makeDistribution('application/n-triples'))).toBe(
      false,
    );
    expect(needsPreprocessing(makeDistribution('application/n-quads'))).toBe(
      false,
    );
    expect(needsPreprocessing(makeDistribution('text/turtle'))).toBe(false);
  });

  it('returns false for gzipped native formats', () => {
    expect(
      needsPreprocessing(
        makeDistribution('application/n-triples', 'application/gzip'),
      ),
    ).toBe(false);
  });

  it('returns false for standalone application/zip (inner format unknown)', () => {
    expect(needsPreprocessing(makeDistribution('application/zip'))).toBe(false);
  });

  it('returns true for JSON-LD (plain or gzipped)', () => {
    expect(needsPreprocessing(makeDistribution('application/ld+json'))).toBe(
      true,
    );
    expect(
      needsPreprocessing(
        makeDistribution('application/ld+json', 'application/gzip'),
      ),
    ).toBe(true);
  });

  it('returns true for zipped JSON-LD', () => {
    expect(
      needsPreprocessing(
        makeDistribution('application/ld+json', 'application/zip'),
      ),
    ).toBe(true);
  });

  it('returns true for RDF/XML (plain or gzipped)', () => {
    expect(needsPreprocessing(makeDistribution('application/rdf+xml'))).toBe(
      true,
    );
    expect(
      needsPreprocessing(
        makeDistribution('application/rdf+xml', 'application/gzip'),
      ),
    ).toBe(true);
  });

  it('returns false when the distribution has no declared media type', () => {
    expect(
      needsPreprocessing(new Distribution(new URL('https://example.com/data'))),
    ).toBe(false);
  });

  it('returns false for native RDF wrapped in a zip — handled by the shell pipeline', () => {
    expect(
      needsPreprocessing(
        makeDistribution('application/n-quads', 'application/zip'),
      ),
    ).toBe(false);
    expect(
      needsPreprocessing(
        makeDistribution('application/n-triples', 'application/zip'),
      ),
    ).toBe(false);
  });
});

describe('preprocess', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'preprocess-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('converts plain JSON-LD to N-Quads', async () => {
    const file = join(tempDir, 'data.jsonld');
    await copyFile(resolve('test/fixtures/preprocess/data.jsonld'), file);

    const result = await preprocess(
      file,
      makeDistribution('application/ld+json'),
    );

    expect(result.format).toBe('nq');
    expect(result.path).toBe(`${file}.preprocessed.nq`);
    const nquads = await readFile(result.path, 'utf-8');
    expect(nquads).toContain('<https://example.org/utrecht/story/1>');
    expect(nquads).toContain('Een verhaal uit Utrecht');
    // N-Quads triples end with " ." on each line.
    expect(nquads.trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('converts plain RDF/XML to N-Quads', async () => {
    const file = join(tempDir, 'data.rdf');
    await copyFile(resolve('test/fixtures/preprocess/data.rdf'), file);

    const result = await preprocess(
      file,
      makeDistribution('application/rdf+xml'),
    );

    expect(result.format).toBe('nq');
    expect(result.path).toBe(`${file}.preprocessed.nq`);
    const nquads = await readFile(result.path, 'utf-8');
    expect(nquads).toContain('<https://example.org/utrecht/story/1>');
    expect(nquads).toContain('Een verhaal uit Utrecht');
    // N-Quads triples end with " ." on each line.
    expect(nquads.trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('gunzips a JSON-LD distribution when compressFormat=application/gzip', async () => {
    const file = join(tempDir, 'data.jsonld.gz');
    await copyFile(resolve('test/fixtures/preprocess/data.jsonld.gz'), file);

    const result = await preprocess(
      file,
      makeDistribution('application/ld+json', 'application/gzip'),
    );

    expect(result.format).toBe('nq');
    const nquads = await readFile(result.path, 'utf-8');
    expect(nquads).toContain('<https://example.org/utrecht/story/1>');
  });

  it('gunzips a JSON-LD distribution via .gz extension when compressFormat is missing', async () => {
    const file = join(tempDir, 'data.jsonld.gz');
    await copyFile(resolve('test/fixtures/preprocess/data.jsonld.gz'), file);

    // No compressFormat declared (the UU collections case).
    const result = await preprocess(
      file,
      makeDistribution('application/ld+json'),
    );

    const nquads = await readFile(result.path, 'utf-8');
    expect(nquads).toContain('<https://example.org/utrecht/story/1>');
  });

  it('extracts a zip containing JSON-LD (declared via compressFormat) and converts to N-Quads', async () => {
    const file = join(tempDir, 'data.zip');
    await copyFile(resolve('test/fixtures/preprocess/data.zip'), file);

    const result = await preprocess(
      file,
      makeDistribution('application/ld+json', 'application/zip'),
    );

    expect(result.format).toBe('nq');
    const nquads = await readFile(result.path, 'utf-8');
    expect(nquads).toContain('<https://example.org/utrecht/story/1>');
    expect(nquads).toContain('Een verhaal uit Utrecht');
  });

  it('reuses the preprocessed file on a second call when source is unchanged', async () => {
    const file = join(tempDir, 'data.jsonld');
    await copyFile(resolve('test/fixtures/preprocess/data.jsonld'), file);
    const distribution = makeDistribution('application/ld+json');

    const first = await preprocess(file, distribution);
    const firstStat = (await import('node:fs/promises')).stat(first.path);
    const firstMtime = (await firstStat).mtimeMs;

    const second = await preprocess(file, distribution);
    expect(second.path).toBe(first.path);
    const secondStat = (await import('node:fs/promises')).stat(second.path);
    expect((await secondStat).mtimeMs).toBe(firstMtime);
  });

  it('skips directory entries and non-JSON-LD entries inside a zip', async () => {
    const file = join(tempDir, 'mixed.zip');
    await copyFile(resolve('test/fixtures/preprocess/mixed.zip'), file);

    const result = await preprocess(
      file,
      makeDistribution('application/ld+json', 'application/zip'),
    );

    // Two matching JSON-LD entries (data.jsonld + subdir/data.jsonld) should
    // both be folded into the N-Quads output.
    const nquads = await readFile(result.path, 'utf-8');
    const tripleLines = nquads
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    expect(tripleLines.length).toBeGreaterThanOrEqual(4);

    // The .txt entry must be reported via warnings rather than silently dropped.
    expect(result.warnings.some((w) => w.includes('extra.txt'))).toBe(true);
  });

  it('throws when called for a distribution that does not need preprocessing', async () => {
    const file = join(tempDir, 'data.nt');
    await (await import('node:fs/promises')).writeFile(file, '');

    await expect(
      preprocess(file, makeDistribution('application/n-triples')),
    ).rejects.toThrow(/does not need preprocessing/);
  });

  it('throws when called for a distribution without a media type', async () => {
    const file = join(tempDir, 'data');
    await (await import('node:fs/promises')).writeFile(file, '');

    await expect(
      preprocess(file, new Distribution(new URL('https://example.com/data'))),
    ).rejects.toThrow(/does not need preprocessing/);
  });

  it('throws when zip contains no JSON-LD entries', async () => {
    const file = join(tempDir, 'empty.zip');
    await copyFile(resolve('test/fixtures/preprocess/empty.zip'), file);

    await expect(
      preprocess(
        file,
        makeDistribution('application/ld+json', 'application/zip'),
      ),
    ).rejects.toThrow(/contains no JSON-LD entries/);
  });
});
