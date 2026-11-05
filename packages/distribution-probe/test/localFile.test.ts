import { Distribution } from '@lde/dataset';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataDumpProbeResult, NetworkError, probe } from '../src/index.js';

describe('probe of a local file', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'probe-local-file-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reports the size and modification date as a data dump', async () => {
    const path = join(directory, 'data.ttl');
    const content = '<urn:s> <urn:p> <urn:o> .\n';
    await writeFile(path, content);
    const modified = new Date('2026-01-02T03:04:05Z');
    await utimes(path, modified, modified);

    const result = await probe(Distribution.localFile(path));

    expect(result).toBeInstanceOf(DataDumpProbeResult);
    const dump = result as DataDumpProbeResult;
    expect(dump.isSuccess()).toBe(true);
    expect(dump.contentSize).toBe(content.length);
    expect(dump.lastModified).toEqual(modified);
    expect(dump.warnings).toEqual([]);
  });

  it('validates a gzipped file without a content type warning', async () => {
    const path = join(directory, 'data.ttl.gz');
    await writeFile(path, gzipSync('<urn:s> <urn:p> <urn:o> .\n'));

    const result = await probe(Distribution.localFile(path), {
      validateRdfContent: true,
    });

    const dump = result as DataDumpProbeResult;
    expect(dump.isSuccess()).toBe(true);
    expect(dump.contentType).toBe('text/turtle');
    expect(dump.warnings).toEqual([]);
  });

  it('finds broken RDF inside a gzipped file', async () => {
    const path = join(directory, 'broken.ttl.gz');
    await writeFile(path, gzipSync('this is not turtle'));

    const result = await probe(Distribution.localFile(path), {
      validateRdfContent: true,
    });

    expect((result as DataDumpProbeResult).isSuccess()).toBe(false);
  });

  it('reports a zipped file as a zip, which it cannot validate', async () => {
    const path = join(directory, 'data.ttl.zip');
    await writeFile(path, 'PK');

    const result = await probe(Distribution.localFile(path), {
      validateRdfContent: true,
    });

    const dump = result as DataDumpProbeResult;
    expect(dump.isSuccess()).toBe(true);
    expect(dump.contentType).toBe('application/zip');
  });

  it('reports an unreadable file as a network error', async () => {
    const path = join(directory, 'private.ttl');
    await writeFile(path, '<urn:s> <urn:p> <urn:o> .\n');
    await chmod(path, 0o000);

    const result = await probe(Distribution.localFile(path), { retries: 0 });

    expect(result).toBeInstanceOf(NetworkError);
    expect((result as NetworkError).message).toContain('EACCES');
  });

  it('reports a missing file as a network error', async () => {
    const result = await probe(
      Distribution.localFile(join(directory, 'missing.ttl')),
      { retries: 0 },
    );

    expect(result).toBeInstanceOf(NetworkError);
    expect((result as NetworkError).message).toContain('ENOENT');
  });

  it('reports a directory as a network error', async () => {
    const path = join(directory, 'directory.ttl');
    await mkdir(path);

    const result = await probe(Distribution.localFile(path), { retries: 0 });

    expect(result).toBeInstanceOf(NetworkError);
    expect((result as NetworkError).message).toContain('is not a file');
  });

  it('validates the content when asked to', async () => {
    const path = join(directory, 'broken.ttl');
    await writeFile(path, 'this is not turtle');

    const result = await probe(Distribution.localFile(path), {
      validateRdfContent: true,
    });

    expect(result).toBeInstanceOf(DataDumpProbeResult);
    expect((result as DataDumpProbeResult).isSuccess()).toBe(false);
  });

  it('never reads a file: URL it was merely handed', async () => {
    const path = join(directory, 'secret.ttl');
    await writeFile(path, '<urn:s> <urn:p> <urn:o> .\n');

    const result = await probe(
      new Distribution(pathToFileURL(path), 'text/turtle'),
      { retries: 0 },
    );

    expect(result).toBeInstanceOf(NetworkError);
  });
});
