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
   * Line repeated at the top of every chunk, for a format whose columns are
   * named. Leave it out for a format without a header, such as N-Triples.
   *
   * The input itself must hold data only: every line it has becomes a row, so
   * a file that carries its own header would repeat it inside the first chunk.
   */
  header?: string;
  /**
   * Extension for the chunk files, leading dot included: `'.csv'`. Defaults to
   * the input's own, and is worth setting for a tool that reads the format
   * from the name – SPARQL Anything does, so a `.txt` export of a CSV has to
   * be chunked as `.csv` to be read as one.
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
  const extension = options.extension ?? extname(inputPath);
  if (extension !== '' && !extension.startsWith('.')) {
    throw new Error(
      `‘${extension}’ is not an extension; give one with its leading dot, such as ‘.csv’`,
    );
  }
  const name = basename(inputPath, extname(inputPath));

  await mkdir(into, { recursive: true });
  await removeChunksOf(name, extension, into);

  const lines = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  const paths: string[] = [];
  let chunkFile: WriteStream | undefined;
  let rowsWritten = 0;

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
      if (chunkFile === undefined) {
        const path = join(
          into,
          `${name}-${String(paths.length).padStart(4, '0')}${extension}`,
        );
        paths.push(path);
        chunkFile = createWriteStream(path);
        // A write can fail while this is waiting on the next line rather than
        // on the stream, and an 'error' nobody listens for ends the process
        // instead of this call. Stop reading; closing the chunk reports it.
        chunkFile.on('error', () => lines.close());
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
    lines.close();
  }

  if (paths.length === 0) {
    throw new Error(
      `‘${inputPath}’ holds no rows to chunk; a step that produced an empty file has failed upstream, and converting nothing would hide that`,
    );
  }

  return paths;
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
  const chunkFile = new RegExp(
    `^${escapeForRegExp(name)}-\\d{4}${escapeForRegExp(extension)}$`,
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
