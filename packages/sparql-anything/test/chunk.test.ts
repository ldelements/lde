import { chunk } from '../src/index.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('chunk', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'chunk-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** Writes an input file of `rows` numbered rows. */
  async function writeInput(
    rows: number,
    name = 'places.txt',
  ): Promise<string> {
    const path = join(workDir, name);
    await writeFile(
      path,
      `${Array.from({ length: rows }, (_, index) => `row-${index}`).join('\n')}\n`,
    );
    return path;
  }

  it('splits into chunks of the given number of rows', async () => {
    const input = await writeInput(5);

    const paths = await chunk(input, {
      rows: 2,
      into: join(workDir, 'chunks'),
    });

    expect(paths).toHaveLength(3);
    expect(await readFile(paths[0], 'utf-8')).toBe('row-0\nrow-1\n');
    // The last chunk holds what is left rather than being padded.
    expect(await readFile(paths[2], 'utf-8')).toBe('row-4\n');
  });

  it('repeats the header at the top of every chunk', async () => {
    const input = await writeInput(3);

    const paths = await chunk(input, {
      rows: 2,
      into: join(workDir, 'chunks'),
      header: 'id\tname',
    });

    expect(await readFile(paths[0], 'utf-8')).toBe('id\tname\nrow-0\nrow-1\n');
    expect(await readFile(paths[1], 'utf-8')).toBe('id\tname\nrow-2\n');
  });

  it('writes no header for a format that has none', async () => {
    const input = await writeInput(2, 'graph.nt');

    const paths = await chunk(input, {
      rows: 1,
      into: join(workDir, 'chunks'),
    });

    expect(await readFile(paths[0], 'utf-8')).toBe('row-0\n');
    // N-Triples keeps its extension, so what reads the chunk still knows it.
    expect(paths[0].endsWith('.nt')).toBe(true);
  });

  it('names chunks after the input, in order, and returns their paths', async () => {
    const input = await writeInput(4);

    const paths = await chunk(input, {
      rows: 2,
      into: join(workDir, 'chunks'),
    });

    expect(paths.map((path) => path.replace(`${workDir}/`, ''))).toEqual([
      'chunks/places-0000.txt',
      'chunks/places-0001.txt',
    ]);
    expect(await readdir(join(workDir, 'chunks'))).toHaveLength(2);
  });

  it('gives the chunks an extension of their own when asked', async () => {
    const input = await writeInput(2);

    const paths = await chunk(input, {
      rows: 2,
      into: join(workDir, 'chunks'),
      extension: '.csv',
    });

    // SPARQL Anything reads the format from the name, so a .txt export of a
    // CSV has to arrive as .csv.
    expect(paths[0].endsWith('places-0000.csv')).toBe(true);
  });

  it('reads a chunk back complete, however large the writes were', async () => {
    const path = join(workDir, 'wide.txt');
    const row = 'x'.repeat(100_000);
    await writeFile(path, `${row}\n${row}\n${row}\n`);

    const paths = await chunk(path, { rows: 2, into: join(workDir, 'chunks') });

    // Backpressure: the chunk is closed before its path is handed back.
    expect(await readFile(paths[0], 'utf-8')).toBe(`${row}\n${row}\n`);
  });

  it('normalises CRLF line endings', async () => {
    const path = join(workDir, 'windows.txt');
    await writeFile(path, 'row-0\r\nrow-1\r\n');

    const paths = await chunk(path, { rows: 2, into: join(workDir, 'chunks') });

    expect(await readFile(paths[0], 'utf-8')).toBe('row-0\nrow-1\n');
  });

  it('refuses an input with no rows rather than producing no chunks', async () => {
    const path = join(workDir, 'empty.txt');
    await writeFile(path, '');

    await expect(
      chunk(path, { rows: 2, into: join(workDir, 'chunks') }),
    ).rejects.toThrow('holds no rows to chunk');
  });

  it('surfaces a failure to write as a rejection, not a crash', async () => {
    const input = await writeInput(4);
    const into = join(workDir, 'chunks');
    // A directory where the first chunk's file belongs: writing to it fails
    // with EISDIR, and the failure arrives while the loop waits on a line.
    await mkdir(join(into, 'places-0000.txt'), { recursive: true });

    await expect(chunk(input, { rows: 2, into })).rejects.toThrow('EISDIR');
  });

  it('surfaces a write that fails while it is waiting on the next line', async () => {
    const input = await writeInput(6);
    const into = join(workDir, 'chunks');
    // The third chunk cannot be opened, so the failure arrives once the first
    // two have been written and the loop is reading again.
    await mkdir(join(into, 'places-0002.txt'), { recursive: true });

    await expect(chunk(input, { rows: 2, into })).rejects.toThrow('EISDIR');

    // The chunks written before it are complete, not truncated.
    expect(await readFile(join(into, 'places-0001.txt'), 'utf-8')).toBe(
      'row-2\nrow-3\n',
    );
  });

  it('leaves no chunk open when the input cannot be read', async () => {
    await expect(
      chunk(join(workDir, 'absent.txt'), {
        rows: 2,
        into: join(workDir, 'chunks'),
      }),
    ).rejects.toThrow('ENOENT');
  });

  it('removes the chunks an earlier call made of the same input', async () => {
    const into = join(workDir, 'chunks');
    await mkdir(into, { recursive: true });
    // A longer run's tail, and a file of the caller's that is not ours.
    await writeFile(join(into, 'places-0007.txt'), 'stale\n');
    await writeFile(join(into, 'notes.txt'), 'keep me\n');
    const input = await writeInput(2);

    await chunk(input, { rows: 2, into });

    expect((await readdir(into)).sort()).toEqual([
      'notes.txt',
      'places-0000.txt',
    ]);
  });

  it('refuses an extension without its leading dot', async () => {
    const input = await writeInput(2);

    await expect(
      chunk(input, {
        rows: 2,
        into: join(workDir, 'chunks'),
        extension: 'csv',
      }),
    ).rejects.toThrow('is not an extension');
  });

  it('refuses a chunk size that is not a whole number of rows', async () => {
    const input = await writeInput(2);

    await expect(
      chunk(input, { rows: 0, into: join(workDir, 'chunks') }),
    ).rejects.toThrow('is not a number of rows to a chunk');
  });
});
