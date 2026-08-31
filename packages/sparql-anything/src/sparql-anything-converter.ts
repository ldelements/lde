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

/**
 * One query, run over each of its chunks, with optional RDF loaded alongside
 * it. Every chunk gets its own process; what they share is stated once.
 */
export interface ConversionJob {
  /** Path to the SPARQL CONSTRUCT query to run. */
  queryFile: string;
  /**
   * Paths to the chunks the query reads, one process each, substituted for the
   * literal `{SOURCE}` in it. Omit for a query that names its own input.
   */
  chunks?: string[];
  /**
   * Optional path passed to `--load`, as the task runner sees it. A file is
   * loaded into the default graph; a directory loads each RDF file it holds
   * into its own named graph.
   */
  load?: string;
}

/** Configuration for a {@link SparqlAnythingConverter}. */
export interface SparqlAnythingConverterOptions<Task> {
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
  private readonly jarPath: string;
  private readonly workDir: string;
  private readonly heap: string;
  private readonly cliArgs: string[];
  private readonly taskRunner: TaskRunner<Task>;

  constructor(options: SparqlAnythingConverterOptions<Task>) {
    this.jarPath = options.jarPath;
    this.workDir = options.workDir;
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
   * Runs every job and concatenates their N-Triples, in the order given, into
   * `outputPath`.
   *
   * `queryFile` is read here, so it must be readable by this process; the chunk
   * and `load` paths are passed to SPARQL Anything as given, so those must be
   * readable by the task runner.
   *
   * Jobs of different shapes belong in one call: they are run by one converter,
   * so a long job and a short one pack together instead of draining in phases.
   */
  async convert(jobs: ConversionJob[], outputPath: string): Promise<void> {
    if (jobs.length === 0) {
      throw new Error(
        'Cannot convert without jobs; a run that produced none has failed upstream, and an empty output would hide that',
      );
    }
    const planned = await plan(jobs);
    // A fresh directory per run: a previous run's output left in place would
    // otherwise satisfy the non-empty check below with stale triples.
    const runDir = await mkdtemp(join(this.workDir, 'sparql-anything-'));
    const runDirName = basename(runDir);
    try {
      const outputs: string[] = [];
      let index = 0;
      for (const { job, query } of planned) {
        // Interpolated per chunk, at the point of use: holding a copy of the
        // query for every chunk up front would scale with the input.
        for (const chunk of job.chunks ?? [undefined]) {
          const queryPath = join(runDirName, `query-${index}.rq`);
          await writeFile(
            join(this.workDir, queryPath),
            chunk === undefined
              ? query
              : query.replaceAll(SOURCE_PLACEHOLDER, chunk),
          );
          const processOutput = join(runDirName, `output-${index}.nt`);
          const task = await this.taskRunner.run(
            this.command(queryPath, processOutput, job),
          );
          // wait() rejects on a non-zero exit, aborting convert() before the
          // crashed process's missing output can be silently concatenated.
          await this.taskRunner.wait(task);
          const processOutputPath = join(this.workDir, processOutput);
          await assertNonEmpty(processOutputPath, job, chunk);
          outputs.push(processOutputPath);
          index++;
        }
      }
      await concatenate(outputs, outputPath);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /** The SPARQL Anything invocation for one job. */
  private command(
    queryPath: string,
    jobOutput: string,
    job: ConversionJob,
  ): string {
    return [
      'java',
      shellQuote(`-Xmx${this.heap}`),
      '-jar',
      shellQuote(this.jarPath),
      '-q',
      shellQuote(queryPath),
      ...(job.load === undefined ? [] : ['--load', shellQuote(job.load)]),
      '--format',
      'NT',
      '--output',
      shellQuote(jobOutput),
      ...this.cliArgs.map(shellQuote),
    ].join(' ');
  }
}

/** A job whose query has been read, and checked against its chunks. */
interface PlannedJob {
  job: ConversionJob;
  /** The query as written, with `{SOURCE}` still in it. */
  query: string;
}

/**
 * Reads and checks every job's query before any process runs, so a
 * misconfigured job fails now rather than after the jobs before it have each
 * run a JVM.
 *
 * One query is held per job, not per chunk: a job's chunks are counted in
 * thousands, and a copy of the query for each would grow with the input rather
 * than with the work in hand.
 *
 * A query that names `{SOURCE}` needs chunks, and a chunk is only reachable
 * through the placeholder, so either half on its own is a misconfiguration
 * that SPARQL Anything would report as a parse error, or not at all.
 */
async function plan(jobs: ConversionJob[]): Promise<PlannedJob[]> {
  const planned: PlannedJob[] = [];
  for (const job of jobs) {
    const query = await readFile(job.queryFile, 'utf-8');
    const namesSource = query.includes(SOURCE_PLACEHOLDER);
    if (job.chunks === undefined) {
      if (namesSource) {
        throw new Error(
          `Query ‘${job.queryFile}’ names ${SOURCE_PLACEHOLDER} but its job has no chunks`,
        );
      }
    } else {
      if (!namesSource) {
        throw new Error(
          `Query ‘${job.queryFile}’ never names ${SOURCE_PLACEHOLDER}, so its job's chunks would go unread`,
        );
      }
      if (job.chunks.length === 0) {
        throw new Error(
          `Job for query ‘${job.queryFile}’ has no chunks; a step that produced none has failed upstream, and converting nothing would hide that`,
        );
      }
    }
    planned.push({ job, query });
  }
  return planned;
}

/**
 * Throws unless the job's output holds at least one byte. SPARQL Anything
 * exits 0 when it cannot read or parse an input: it logs the problem, writes an
 * empty output and stops. Without this guard a run stays green while its output
 * silently misses every triple of the chunk.
 */
async function assertNonEmpty(
  outputPath: string,
  job: ConversionJob,
  chunk?: string,
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
      `SPARQL Anything produced no output for ‘${job.queryFile}’${chunk === undefined ? '' : ` over ‘${chunk}’`}; it exits successfully when it cannot read or parse an input`,
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
