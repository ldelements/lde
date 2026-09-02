import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { basename, extname, join } from 'node:path';

/** Configuration for {@link chunk}. */
export interface ChunkOptions {
  /**
   * Data rows per chunk. Chosen together with the converter's `heap`: a chunk
   * is what one process has to hold at once.
   */
  rows: number;
  /** Directory the chunks are written to. Created if it does not exist. */
  into: string;
  /**
   * Line repeated at the top of every chunk, for a format whose columns are
   * named. Leave it out for a format without a header, such as N-Triples.
   */
  header?: string;
  /**
   * Extension for the chunk files, `'.csv'` and so on. Defaults to the input's
   * own, and is worth setting for a tool that reads the format from the name –
   * SPARQL Anything does, so a `.txt` export of a CSV has to be chunked as
   * `.csv` to be read as one.
   */
  extension?: string;
}

/**
 * Splits a line-oriented file into chunks of `rows` rows each, and returns
 * their paths in order.
 *
 * SPARQL Anything materialises a chunk's whole result graph before writing it,
 * so what a conversion can hold is a chunk rather than a file; this is how a
 * file that does not fit becomes chunks that do.
 *
 * Splitting is by line, so every record must be one line: a delimited format
 * that wraps a field in quotes to carry a newline inside it would be cut in
 * two. Tab-separated exports, N-Triples and NDJSON are all one record per line
 * by definition. Line endings are normalised to `\n`.
 */
export async function chunk(
  inputPath: string,
  options: ChunkOptions,
): Promise<string[]> {
  const { rows, into, header } = options;
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error(
      `‘${rows}’ is not a number of rows to a chunk; give a whole number of one or more`,
    );
  }
  await mkdir(into, { recursive: true });

  const extension = options.extension ?? extname(inputPath);
  const name = basename(inputPath, extname(inputPath));
  const lines = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  const paths: string[] = [];
  let chunkFile: WriteStream | undefined;
  let rowsWritten = 0;
  for await (const line of lines) {
    if (chunkFile === undefined) {
      const path = join(
        into,
        `${name}-${String(paths.length).padStart(4, '0')}${extension}`,
      );
      paths.push(path);
      chunkFile = createWriteStream(path);
      if (header !== undefined) {
        await write(chunkFile, `${header}\n`);
      }
    }
    await write(chunkFile, `${line}\n`);
    rowsWritten++;
    if (rowsWritten === rows) {
      await close(chunkFile);
      chunkFile = undefined;
      rowsWritten = 0;
    }
  }
  if (chunkFile !== undefined) {
    await close(chunkFile);
  }

  if (paths.length === 0) {
    throw new Error(
      `‘${inputPath}’ holds no rows to chunk; a step that produced an empty file has failed upstream, and converting nothing would hide that`,
    );
  }

  return paths;
}

/** Writes `text`, waiting for the stream to drain when it asks to. */
async function write(chunkFile: WriteStream, text: string): Promise<void> {
  if (!chunkFile.write(text)) {
    await once(chunkFile, 'drain');
  }
}

/** Closes a chunk, so it is complete before its path is handed on. */
async function close(chunkFile: WriteStream): Promise<void> {
  chunkFile.end();
  await once(chunkFile, 'close');
}
