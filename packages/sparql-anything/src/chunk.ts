import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { basename, extname, join } from 'node:path';

/** Configuration for {@link chunk}. */
export interface ChunkOptions {
  /**
   * Data rows per chunk. Chosen together with the converter's `heap`: a chunk
   * is what one process has to hold at once.
   */
  rows: number;
  /**
   * Directory the chunks are written to, created if it does not exist. Chunks
   * of this input left by an earlier call are removed first, so a re-run
   * cannot leave a longer run's tail behind for something to pick up.
   */
  into: string;
  /**
   * Name the chunks are built from: `places` gives `places-0000.csv`. Defaults
   * to the file name of a path input, and is required for a line source, which
   * has no name of its own. It is a file name, not a path.
   */
  name?: string;
  /**
   * Line repeated at the top of every chunk, for a format whose columns are
   * named. Leave it out for a format without a header, such as N-Triples.
   *
   * The input itself must hold data only: every line it has becomes a row, so
   * a file that carries its own header would repeat it inside the first chunk.
   */
  header?: string;
  /**
   * Extension for the chunk files, leading dot included: `'.csv'`; `''` for
   * none. Defaults to the input's own for a path, and is required for a line
   * source, which has none to default to. It decides how the chunk is read:
   * SPARQL Anything takes the format from the name, so a `.txt` export of a
   * CSV has to be chunked as `.csv` to be read as one.
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
export function chunk(
  inputPath: string,
  options: ChunkOptions,
): Promise<string[]>;
/**
 * Splits a stream of lines into chunks of `rows` rows each, and returns their
 * paths in order.
 *
 * This is chunking a table a caller produces itself – filtering rows out,
 * adding a column – which would otherwise be written to disk only for this to
 * read it back and write the same bytes again. Every value is one row: one
 * that holds a line ending of its own is rejected rather than written as the
 * several rows it would become, which would put more in a chunk than `rows`
 * says it holds. A trailing `\r` is a line ending and is dropped.
 *
 * `name` and `extension` are both required here, because a stream has no file
 * name to take either from, and a chunk of no known format is one SPARQL
 * Anything cannot read. Pass `''` for no extension.
 */
export function chunk(
  lines: AsyncIterable<string>,
  options: ChunkOptions & { name: string; extension: string },
): Promise<string[]>;
export async function chunk(
  input: string | AsyncIterable<string>,
  options: ChunkOptions,
): Promise<string[]> {
  const { rows, into, header } = options;
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error(
      `‘${rows}’ is not a number of rows to a chunk; give a whole number of one or more`,
    );
  }
  const inputPath = typeof input === 'string' ? input : undefined;
  const name =
    options.name ??
    (inputPath === undefined
      ? undefined
      : basename(inputPath, extname(inputPath)));
  if (name === undefined) {
    throw new Error(
      'a stream of lines has no name to call its chunks after; pass ‘name’',
    );
  }
  if (name === '' || name !== basename(name)) {
    throw new Error(
      `‘${name}’ is not a name for the chunks; give a file name without a directory`,
    );
  }
  const extension =
    options.extension ??
    (inputPath === undefined ? undefined : extname(inputPath));
  if (extension === undefined) {
    throw new Error(
      'a stream of lines has no extension to give its chunks; pass ‘extension’, or ‘’ for none',
    );
  }
  if (extension !== '' && !extension.startsWith('.')) {
    throw new Error(
      `‘${extension}’ is not an extension; give one with its leading dot, such as ‘.csv’`,
    );
  }

  await mkdir(into, { recursive: true });
  await removeChunksOf(name, extension, into);

  const lineReader =
    inputPath === undefined
      ? undefined
      : createInterface({
          input: createReadStream(inputPath),
          crlfDelay: Infinity,
        });
  const lines = lineReader ?? oneRowPerValue(input as AsyncIterable<string>);

  const paths: string[] = [];
  let chunkFile: WriteStream | undefined;
  let rowsWritten = 0;
  let writeFailed = false;

  const write = async (text: string): Promise<void> => {
    if (!chunkFile!.write(text)) {
      await once(chunkFile!, 'drain');
    }
  };

  const closeChunk = async (): Promise<void> => {
    const closing = chunkFile!;
    chunkFile = undefined;
    closing.end();
    // finished(), not once('close'): it reports a stream that has already
    // failed, and returns for one that has already closed, where waiting for
    // the event would wait for one that will not come again.
    await finished(closing);
  };

  try {
    for await (const line of lines) {
      // A write can fail while this is waiting on the next line rather than
      // on the stream, and an 'error' nobody listens for ends the process
      // instead of this call. Stop reading; closing the chunk reports it.
      if (writeFailed) {
        break;
      }
      if (chunkFile === undefined) {
        const path = join(
          into,
          `${name}-${String(paths.length).padStart(4, '0')}${extension}`,
        );
        paths.push(path);
        chunkFile = createWriteStream(path);
        chunkFile.on('error', () => {
          writeFailed = true;
          // A file is read ahead of the loop, so ending it here stops it
          // sooner than the check above would; a stream of lines is pulled a
          // value at a time and has nothing to close.
          lineReader?.close();
        });
        if (header !== undefined) {
          await write(`${header}\n`);
        }
      }
      await write(`${line}\n`);
      rowsWritten++;
      if (rowsWritten === rows) {
        await closeChunk();
        rowsWritten = 0;
      }
    }
    if (chunkFile !== undefined) {
      await closeChunk();
    }
  } finally {
    // Whatever went wrong – a write, or the read that feeds it – the chunk
    // still open would otherwise keep its handle and its half of a row.
    chunkFile?.destroy();
    lineReader?.close();
  }

  if (paths.length === 0) {
    throw new Error(
      `‘${inputPath ?? name}’ holds no rows to chunk; a step that produced an empty input has failed upstream, and converting nothing would hide that`,
    );
  }

  return paths;
}

/**
 * Holds a stream to one row per value, the way `readline` holds a file to one
 * row per line.
 *
 * A value carrying a line ending of its own would be counted as one row and
 * written as several, so a chunk would hold more than `rows` says – the bound
 * a conversion's memory is sized against. It is also how a byte stream
 * arrives, its values falling wherever the reads did rather than on lines, so
 * the same check names that mistake instead of silently cutting records in
 * two.
 */
async function* oneRowPerValue(
  lines: AsyncIterable<string>,
): AsyncGenerator<string> {
  for await (const line of lines) {
    // A trailing \r is the other half of a CRLF ending, not data; dropping it
    // is the normalisation a file gets from crlfDelay.
    const row = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (row.includes('\n')) {
      const excerpt = row.length > 40 ? `${row.slice(0, 40)}…` : row;
      throw new Error(
        `‘${excerpt}’ holds a line ending, so it is more than one row; give this one value per row, reading a byte stream through ‘readline’ first`,
      );
    }
    yield row;
  }
}

/**
 * Removes the chunks an earlier call made of this input. Only those: the
 * directory is the caller's, and everything else in it is theirs.
 */
async function removeChunksOf(
  name: string,
  extension: string,
  into: string,
): Promise<void> {
  // Four digits or more: the index is padded to four, and grows past them
  // from the 10,000th chunk on.
  const chunkFile = new RegExp(
    `^${escapeForRegExp(name)}-\\d{4,}${escapeForRegExp(extension)}$`,
  );
  const entries = await readdir(into, { withFileTypes: true });
  await Promise.all(
    entries
      // Files only: something else of that name is not a chunk this made, and
      // removing it is not this function's business.
      .filter((entry) => entry.isFile() && chunkFile.test(entry.name))
      .map((entry) => rm(join(into, entry.name), { force: true })),
  );
}

/** Quotes the characters a file name may hold that a pattern would read. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
