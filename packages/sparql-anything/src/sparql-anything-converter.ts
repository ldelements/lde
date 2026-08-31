import { shellQuote, TaskRunner } from '@lde/task-runner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { finished, pipeline } from 'node:stream/promises';
import { basename, join } from 'node:path';

/** Placeholder in the query file that is replaced with each chunk's path. */
const SOURCE_PLACEHOLDER = '{SOURCE}';

/** A JVM heap size: a number of bytes, or one with a k/m/g suffix. */
const HEAP_SIZE = /^\d+[kmg]?$/i;

/**
 * Heap per chunk process when none is configured. Conservative on purpose: a
 * chunk that needs more fails loudly, with the JVM's OutOfMemoryError in the
 * output of a non-zero exit, where leaving the JVM uncapped instead lets it
 * take a quarter of host memory until the OOM killer takes the container.
 */
const DEFAULT_HEAP = '2g';

/**
 * Arguments the converter sets itself, with their aliases. Passing one again
 * through `cliArgs` would break what the converter does around the process:
 * it reads back the `--output` it named, in the `--format` it asked for.
 */
const RESERVED_ARGUMENTS = new Set([
  '-q',
  '--query',
  '-f',
  '--format',
  '-o',
  '--output',
  '-l',
  '--load',
]);

/** Configuration for a {@link SparqlAnythingConverter}. */
export interface SparqlAnythingConverterOptions<Task> {
  /**
   * Path to the SPARQL CONSTRUCT query run for every chunk. The literal
   * `{SOURCE}` is replaced with the chunk's path before each run.
   */
  queryFile: string;
  /** Path to the SPARQL Anything CLI jar, as the task runner sees it. */
  jarPath: string;
  /**
   * The task runner's working directory: `cwd` for a `NativeTaskRunner`,
   * `mountDir` for a `DockerTaskRunner`. The converter writes its generated
   * query files and per-chunk outputs into a fresh subdirectory here, removes
   * it when it is done, and refers to those files by a path relative to this
   * directory, so the same command works on the host and inside a container.
   */
  workDir: string;
  /**
   * Optional path passed to `--load`, as the task runner sees it. A file is
   * loaded into the default graph; a directory loads each RDF file it holds
   * into its own named graph.
   */
  load?: string;
  /**
   * Maximum JVM heap per chunk process, as `-Xmx` takes it: `'2g'`, `'512m'`.
   * One process per chunk bounds memory only together with a cap, since SPARQL
   * Anything materialises a chunk's whole result graph before writing it, so
   * there is always one. Raise it for chunks larger than the default suits.
   * @default '2g'
   */
  heap?: string;
  /**
   * Further arguments for the SPARQL Anything CLI, passed after the ones the
   * converter sets itself. Those it cannot repeat: `-q`, `-f`, `-o` and `-l`
   * are the converter's own, and are rejected here.
   */
  cliArgs?: string[];
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
  private readonly workDir: string;
  private readonly load?: string;
  private readonly heap: string;
  private readonly cliArgs: string[];
  private readonly taskRunner: TaskRunner<Task>;

  constructor(options: SparqlAnythingConverterOptions<Task>) {
    this.queryFile = options.queryFile;
    this.jarPath = options.jarPath;
    this.workDir = options.workDir;
    this.load = options.load;
    const heap = options.heap ?? DEFAULT_HEAP;
    if (!HEAP_SIZE.test(heap)) {
      throw new Error(
        `‘${heap}’ is not a heap size; give the value -Xmx takes, such as ‘2g’`,
      );
    }
    this.heap = heap;
    const reserved = (options.cliArgs ?? []).filter((argument) =>
      RESERVED_ARGUMENTS.has(argument),
    );
    if (reserved.length > 0) {
      throw new Error(
        `Cannot pass ${reserved.join(', ')} through cliArgs: the converter sets these itself, and reads back the output it named`,
      );
    }
    this.cliArgs = options.cliArgs ?? [];
    this.taskRunner = options.taskRunner;
  }

  /**
   * Converts each chunk to N-Triples and concatenates the results, in the order
   * given, into `outputPath`. Chunk paths are passed to SPARQL Anything as
   * given, so they too must be readable by the task runner.
   */
  async convert(chunkPaths: string[], outputPath: string): Promise<void> {
    if (chunkPaths.length === 0) {
      throw new Error(
        'Cannot convert without chunks; a run that produced none has failed upstream, and an empty output would hide that',
      );
    }
    const query = await readFile(this.queryFile, 'utf-8');
    // A fresh directory per run: a previous run's output left in place would
    // otherwise satisfy the non-empty check below with stale triples.
    const runDir = await mkdtemp(join(this.workDir, 'sparql-anything-'));
    const runDirName = basename(runDir);
    try {
      const chunkOutputs: string[] = [];
      for (const [index, chunkPath] of chunkPaths.entries()) {
        const queryPath = join(runDirName, `query-${index}.rq`);
        await writeFile(
          join(this.workDir, queryPath),
          query.replaceAll(SOURCE_PLACEHOLDER, chunkPath),
        );
        const chunkOutput = join(runDirName, `chunk-${index}.nt`);
        const task = await this.taskRunner.run(
          this.command(queryPath, chunkOutput),
        );
        // wait() rejects on a non-zero exit, aborting convert() before the
        // crashed chunk's missing output can be silently concatenated.
        await this.taskRunner.wait(task);
        const chunkOutputPath = join(this.workDir, chunkOutput);
        await assertNonEmpty(chunkOutputPath, chunkPath);
        chunkOutputs.push(chunkOutputPath);
      }
      await concatenate(chunkOutputs, outputPath);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /** The SPARQL Anything invocation for one chunk. */
  private command(queryPath: string, chunkOutput: string): string {
    return [
      'java',
      shellQuote(`-Xmx${this.heap}`),
      '-jar',
      shellQuote(this.jarPath),
      '-q',
      shellQuote(queryPath),
      ...(this.load === undefined ? [] : ['--load', shellQuote(this.load)]),
      '--format',
      'NT',
      '--output',
      shellQuote(chunkOutput),
      ...this.cliArgs.map(shellQuote),
    ].join(' ');
  }
}

/**
 * Throws unless the chunk's output holds at least one byte. SPARQL Anything
 * exits 0 when it cannot read or parse an input: it logs the problem, writes an
 * empty output and stops. Without this guard a run stays green while its output
 * silently misses every triple of the chunk.
 */
async function assertNonEmpty(
  outputPath: string,
  chunkPath: string,
): Promise<void> {
  const size = await stat(outputPath).then(
    (stats) => stats.size,
    (error: NodeJS.ErrnoException) => {
      // Anything but a missing file is a problem of its own, and reporting it
      // as an empty conversion would send the reader after the wrong cause.
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return 0;
    },
  );
  if (size === 0) {
    throw new Error(
      `SPARQL Anything produced no output for chunk ‘${chunkPath}’; it exits successfully when it cannot read or parse an input`,
    );
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
  for (const [index, inputPath] of inputPaths.entries()) {
    // A newline between files, in case one does not end in one: N-Triples
    // tolerates the blank line, but not two triples sharing a line.
    if (index > 0) {
      output.write('\n');
    }
    await pipeline(createReadStream(inputPath), output, { end: false });
  }
  output.end();
  // pipeline() with `end: false` resolves once the source ends, not once the
  // destination is flushed and closed, so await that before reporting success.
  // On an earlier rejection pipeline() has already destroyed the stream.
  await finished(output);
}
