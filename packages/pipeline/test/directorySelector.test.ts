import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorySelector } from '../src/selector.js';

async function selectedIris(directory: string): Promise<string[]> {
  const iris = [];
  for await (const dataset of await new DirectorySelector(directory).select()) {
    iris.push(dataset.iri.toString());
  }
  return iris;
}

describe('DirectorySelector', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'directory-selector-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('selects one dataset per RDF file, in a stable order', async () => {
    await writeFile(join(directory, 'b.nt.gz'), '');
    await writeFile(join(directory, 'a.ttl'), '');

    expect(await selectedIris(directory)).toEqual([
      pathToFileURL(join(directory, 'a.ttl')).toString(),
      pathToFileURL(join(directory, 'b.nt.gz')).toString(),
    ]);
  });

  it('skips a file that is not RDF, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(join(directory, 'README.md'), '');
    await writeFile(join(directory, 'a.ttl'), '');

    expect(await selectedIris(directory)).toEqual([
      pathToFileURL(join(directory, 'a.ttl')).toString(),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('README.md'));
  });

  it('ignores subdirectories, whatever their name', async () => {
    await mkdir(join(directory, 'nested.ttl'));
    await writeFile(join(directory, 'nested.ttl', 'b.ttl'), '');

    expect(await selectedIris(directory)).toEqual([]);
  });

  it('follows a symbolic link, as a mounted volume may use', async () => {
    const target = join(directory, 'target.bin');
    await writeFile(target, '');
    await symlink(target, join(directory, 'a.ttl'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await selectedIris(directory)).toEqual([
      pathToFileURL(join(directory, 'a.ttl')).toString(),
    ]);
  });

  it('rejects a missing directory', async () => {
    await expect(
      new DirectorySelector(join(directory, 'missing')).select(),
    ).rejects.toThrow('ENOENT');
  });
});
