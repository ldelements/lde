import { TaskRunner } from '@lde/task-runner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Placeholder in the query file that is replaced with each chunk's path. */
const SOURCE_PLACEHOLDER = '{SOURCE}';

/** Configuration for a {@link SparqlAnythingConverter}. */
export interface SparqlAnythingConverterOptions<Task> {
  /**
   * Path to the SPARQL CONSTRUCT query run for every chunk. The literal
   * `{SOURCE}` is replaced with the chunk's path before each run.
   */
  queryFile: string;
  /** Path to the SPARQL Anything CLI jar. */
  jarPath: string;
  /** Path to the Turtle file loaded into the default graph (`--load`). */
  adminCodesFile: string;
  /** Runs the SPARQL Anything process for each chunk. */
  taskRunner: TaskRunner<Task>;
}

/**
 * Converts tabular (or other non-RDF) source chunks to N-Triples with the
 * SPARQL Anything CLI, running one process per chunk to bound memory use, then
 * concatenating the per-chunk outputs into a single file.
 */
export class SparqlAnythingConverter<Task> {
  private readonly queryFile: string;
  private readonly jarPath: string;
  private readonly adminCodesFile: string;
  private readonly taskRunner: TaskRunner<Task>;

  constructor(options: SparqlAnythingConverterOptions<Task>) {
    this.queryFile = options.queryFile;
    this.jarPath = options.jarPath;
    this.adminCodesFile = options.adminCodesFile;
    this.taskRunner = options.taskRunner;
  }

  /**
   * Converts each chunk to N-Triples and concatenates the results, in the order
   * given, into `outputPath`.
   */
  async convert(chunkPaths: string[], outputPath: string): Promise<void> {
    const query = await readFile(this.queryFile, 'utf-8');
    const tempDir = await mkdtemp(join(tmpdir(), 'sparql-anything-'));
    try {
      const chunkOutputs: string[] = [];
      for (const [index, chunkPath] of chunkPaths.entries()) {
        const queryPath = join(tempDir, `query-${index}.rq`);
        await writeFile(
          queryPath,
          query.replaceAll(SOURCE_PLACEHOLDER, chunkPath),
        );
        const chunkOutput = `${chunkPath}.nt`;
        const task = await this.taskRunner.run(
          `java -jar ${this.jarPath} -q ${queryPath} --load ${this.adminCodesFile} --format NT --output ${chunkOutput}`,
        );
        // wait() rejects on a non-zero exit, aborting convert() before the
        // crashed chunk's missing output can be silently concatenated.
        await this.taskRunner.wait(task);
        chunkOutputs.push(chunkOutput);
      }
      await concatenate(chunkOutputs, outputPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Concatenates `inputPaths` into `outputPath`, streaming so multi-GB outputs do
 * not have to fit in memory. N-Triples has no prefixes or document structure, so
 * concatenating per-chunk files yields a single valid document.
 */
async function concatenate(
  inputPaths: string[],
  outputPath: string,
): Promise<void> {
  const output = createWriteStream(outputPath);
  try {
    for (const inputPath of inputPaths) {
      await pipeline(createReadStream(inputPath), output, { end: false });
    }
  } finally {
    output.end();
  }
}
