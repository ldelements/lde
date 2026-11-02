import { Distribution } from '@lde/dataset';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LastModifiedDownloader } from '../src/download.js';

describe('LastModifiedDownloader with a local file', () => {
  let directory: string;
  let dataDirectory: string;
  let source: string;
  let downloader: LastModifiedDownloader;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'download-local-file-'));
    dataDirectory = join(directory, 'data');
    source = join(directory, 'data.nt.gz');
    downloader = new LastModifiedDownloader(dataDirectory);
    await writeFile(source, 'first');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('copies the file into the base directory, keeping its extension', async () => {
    const { path } = await downloader.download(Distribution.localFile(source));

    expect(dirname(path)).toBe(dataDirectory);
    expect(path.endsWith('.nt.gz')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('first');
  });

  it('gives files whose paths read alike their own copies', async () => {
    await mkdir(join(directory, 'a'));
    const nested = join(directory, 'a', 'b.ttl');
    const flat = join(directory, 'a!b.ttl');
    await writeFile(nested, 'nested');
    await writeFile(flat, 'flat!');

    const first = await downloader.download(Distribution.localFile(nested));
    const second = await downloader.download(Distribution.localFile(flat));

    expect(first.path).not.toBe(second.path);
    expect(await readFile(first.path, 'utf8')).toBe('nested');
    expect(await readFile(second.path, 'utf8')).toBe('flat!');
  });

  it('gives the copy a default mode, whatever the source has', async () => {
    const distribution = Distribution.localFile(source);
    await chmod(source, 0o400);

    const { path } = await downloader.download(distribution);

    expect((await stat(path)).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it('copies a changed read-only file again', async () => {
    const distribution = Distribution.localFile(source);
    await chmod(source, 0o444);
    const { path } = await downloader.download(distribution);

    await chmod(source, 0o644);
    await writeFile(source, 'changed');
    await chmod(source, 0o444);
    await downloader.download(distribution);

    expect(await readFile(path, 'utf8')).toBe('changed');
  });

  it('keeps an unchanged copy, so a store’s index of it stays valid', async () => {
    const distribution = Distribution.localFile(source);
    const { path } = await downloader.download(distribution);
    const copied = await stat(path);

    await downloader.download(distribution);

    expect((await stat(path)).mtimeMs).toBe(copied.mtimeMs);
  });

  it('copies a changed file again', async () => {
    const distribution = Distribution.localFile(source);
    const { path } = await downloader.download(distribution);

    await writeFile(source, 'other');
    const later = new Date(Date.now() + 60_000);
    await utimes(source, later, later);
    await downloader.download(distribution);

    expect(await readFile(path, 'utf8')).toBe('other');
  });

  it('copies a replacement with a different size, even if it is older', async () => {
    const distribution = Distribution.localFile(source);
    const { path } = await downloader.download(distribution);
    const copied = await stat(path);

    await writeFile(source, 'restored from a backup');
    const earlier = new Date('2001-01-01');
    await utimes(source, earlier, earlier);
    await downloader.download(distribution);

    expect(await readFile(path, 'utf8')).toBe('restored from a backup');
    expect((await stat(path)).mtimeMs).toBeGreaterThanOrEqual(copied.mtimeMs);
  });

  it('leaves no partial copy when copying fails', async () => {
    const distribution = Distribution.localFile(source);
    await chmod(source, 0o000);

    await expect(downloader.download(distribution)).rejects.toThrow(
      'Failed to copy',
    );

    expect(await readdir(dataDirectory)).toEqual([]);
  });

  it('rejects an empty file', async () => {
    await writeFile(source, '');

    await expect(
      downloader.download(Distribution.localFile(source)),
    ).rejects.toThrow('is empty');
  });

  it('rejects a missing file', async () => {
    await expect(
      downloader.download(Distribution.localFile(join(directory, 'none.ttl'))),
    ).rejects.toThrow('ENOENT');
  });

  it('never copies a file: URL it was merely handed', async () => {
    await expect(
      downloader.download(
        new Distribution(pathToFileURL(source), 'application/n-triples'),
      ),
    ).rejects.toThrow();
  });
});
