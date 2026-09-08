import { shellQuote, TaskRunner } from '@lde/task-runner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, isAbsolute, join } from 'node:path';

/** Placeholder in the query file that is replaced with each chunk's path. */
const SOURCE_PLACEHOLDER = '{SOURCE}';

/**
 * A JVM heap size: a non-zero number of bytes, or one with a k/m/g suffix.
 * Zero passes -Xmx's own syntax but kills every process at JVM startup, which
 * is the one value a check meant to fail fast must not let through.
 */
const HEAP_SIZE = /^(?!0+[kmg]?$)\d+[kmg]?$/i;

/**
 * Heap per chunk process when none is configured. Conservative on purpose: a
 * chunk that needs more fails loudly, with the JVM's OutOfMemoryError in the
 * output of a non-zero exit, where leaving the JVM uncapped instead lets it
 * take a quarter of host memory until the OOM killer takes the container.
 */
const DEFAULT_HEAP = '2g';

/**
 * The signals that end this process on a Ctrl-C or a cancelled job. The
 * processes a run started would survive them: a task runner spawns each in a
 * process group of its own, which is what lets it stop them as a whole.
 */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

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

/** What a chunk's conversion reports when it is done. */
export interface ChunkProgress {
  /** Position of this process in the run, counting from one. */
  index: number;
  /** How many processes the run holds in all. */
  total: number;
  /** The chunk converted, for a job that has chunks. */
  chunk?: string;
  /** The query the job ran, which is what tells two jobs apart. */
  queryFile: string;
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
  /**
   * How many chunks to convert at once. Each one is a JVM of its own, so this
   * multiplies against {@link heap}: the memory a run needs is `concurrency ×
   * heap`, and the machine that has to hold it is the task runner's, not this
   * process's. Left at one, chunks are converted one after another.
   * @default 1
   */
  concurrency?: number;
  /** Runs the SPARQL Anything process for each chunk. */
  taskRunner: TaskRunner<Task>;
  /**
   * Called as each chunk finishes, for a conversion that would otherwise say
   * nothing for as long as it takes – the GeoNames run is a quarter of an hour
   * over eighteen chunks. Called once per chunk, in the order they finish
   * rather than the order they were given, and not at all for a chunk that
   * failed. A callback that throws aborts the run, like any other failure.
   */
  onChunkConverted?: (progress: ChunkProgress) => void;
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
  private readonly concurrency: number;
  private readonly taskRunner: TaskRunner<Task>;
  private readonly onChunkConverted?: (progress: ChunkProgress) => void;

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
      // Also in the `--format=NT` form, which is a single token.
      RESERVED_ARGUMENTS.has(argument.split('=')[0]),
    );
    if (reserved.length > 0) {
      throw new Error(
        `Cannot pass ${reserved.join(', ')} through cliArgs: the converter sets these itself, and reads back the output it named`,
      );
    }
    this.cliArgs = options.cliArgs ?? [];
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        `‘${concurrency}’ is not a number of chunks to convert at once; give a whole number of one or more`,
      );
    }
    this.concurrency = concurrency;
    this.taskRunner = options.taskRunner;
    this.onChunkConverted = options.onChunkConverted;
  }

  /**
   * Runs every job and concatenates their N-Triples, in the order given, into
   * `outputPath`.
   *
   * `queryFile` is read here, so it must be readable by this process; the chunk
   * and `load` paths are passed to SPARQL Anything as given, so those must be
   * readable by the task runner. `load` is the one input SPARQL Anything does
   * not fail on when it is missing, so it is checked here first, where a
   * relative path resolves against `workDir` on both sides.
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
    const planned = await plan(jobs, this.workDir);
    // A fresh directory per run: a previous run's output left in place would
    // otherwise satisfy the non-empty check below with stale triples.
    const runDir = await mkdtemp(join(this.workDir, 'sparql-anything-'));
    const runDirName = basename(runDir);
    const state: RunState<Task> = {
      total: countOf(planned),
      inFlight: new Set(),
    };
    const stopListeningForSignals = this.stopOnSignal(state, runDir);
    try {
      const count = await this.runAll(planned, runDirName, state);
      // By index, not by completion: the order the jobs and their chunks were
      // given is the order of the triples, however the processes finished.
      await concatenate(
        Array.from({ length: count }, (_, index) =>
          join(this.workDir, runDirName, `output-${index}.nt`),
        ),
        outputPath,
      );
    } finally {
      stopListeningForSignals();
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /**
   * Stops the run when this process is told to stop, so that a Ctrl-C or a
   * cancelled job does not leave the processes running and the run directory
   * behind, which `convert()`’s cleanup never gets to. The signal is then
   * raised again with the listeners gone, so the process ends as it would have
   * without them, with the same exit status.
   *
   * Returns what removes the listeners again. Each run listens for itself, so
   * one that ends does not stop listening for another still going.
   */
  private stopOnSignal(state: RunState<Task>, runDir: string): () => void {
    let stopping = false;
    const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
      // A second signal while stopping changes nothing: the processes have
      // been told to stop, and the run is about to end.
      if (stopping) {
        return;
      }
      stopping = true;
      // The run’s failure now, whatever else went wrong: no further chunk is
      // started while the processes are being stopped.
      state.failure = new Error(`Interrupted by ${signal}`);
      await this.stopInFlight(state);
      await rm(runDir, { recursive: true, force: true });
      stopListening();
      process.kill(process.pid, signal);
    };
    const stopListening = (): void => {
      for (const signal of STOP_SIGNALS) {
        process.off(signal, onSignal);
      }
    };
    for (const signal of STOP_SIGNALS) {
      process.on(signal, onSignal);
    }
    return stopListening;
  }

  /**
   * Runs every chunk, at most {@link concurrency} at a time, and returns how
   * many processes that was.
   *
   * The first failure aborts the run: no further chunk is started, and the
   * processes still going are stopped rather than left writing into a
   * directory this is about to delete.
   */
  private async runAll(
    planned: PlannedJob[],
    runDirName: string,
    state: RunState<Task>,
  ): Promise<number> {
    const pending = processesOf(planned);

    // Pulled one at a time rather than with `for...of`: leaving a for-of early
    // closes the iterator, so the first worker to give up would end the queue
    // for the others, whatever the reason it stopped.
    const convertChunks = async (): Promise<void> => {
      while (state.failure === undefined) {
        const next = pending.next();
        if (next.done === true) {
          return;
        }
        try {
          await this.convertChunk(next.value, runDirName, state);
        } catch (error) {
          state.failure ??= error;
          await this.stopInFlight(state);
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: this.concurrency }, () => convertChunks()),
    );
    if (state.failure !== undefined) {
      throw state.failure;
    }
    return state.total;
  }

  /** Converts one chunk, writing `output-<index>.nt` in the run directory. */
  private async convertChunk(
    { index, job, chunk, query, outputMayBeEmpty }: PlannedProcess,
    runDirName: string,
    state: RunState<Task>,
  ): Promise<void> {
    const queryPath = join(runDirName, `query-${index}.rq`);
    await writeFile(
      join(this.workDir, queryPath),
      chunk === undefined
        ? query
        : // A replacer function, so `$&` and friends in a chunk path are the
          // characters they look like rather than replacement patterns.
          query.replaceAll(SOURCE_PLACEHOLDER, () => chunk),
    );
    const output = join(runDirName, `output-${index}.nt`);
    const task = await this.taskRunner.run(
      this.command(queryPath, output, job),
    );
    state.inFlight.add(task);
    try {
      if (state.failure !== undefined) {
        // Started in the window between another chunk failing and this worker
        // seeing it, so it is not in the set that failure stopped.
        await this.stopQuietly(task);
        return;
      }
      // wait() rejects on a non-zero exit, aborting convert() before the
      // crashed chunk's missing output can be silently concatenated.
      await this.taskRunner.wait(task);
    } finally {
      state.inFlight.delete(task);
    }
    await checkOutput(join(this.workDir, output), job, chunk, outputMayBeEmpty);
    this.onChunkConverted?.({
      index: index + 1,
      total: state.total,
      chunk,
      queryFile: job.queryFile,
    });
  }

  /** Stops every process still running, so none outlives the run. */
  private async stopInFlight(state: RunState<Task>): Promise<void> {
    await Promise.all(
      [...state.inFlight].map((task) => this.stopQuietly(task)),
    );
  }

  /**
   * Stops a task, ignoring a failure to stop it. Stopping is best effort by
   * nature – a process that has just exited cannot be stopped, and reporting
   * that would replace the failure that is actually worth reporting, and leave
   * the other workers unawaited while the run directory is deleted.
   */
  private async stopQuietly(task: Task): Promise<void> {
    await this.taskRunner.stop(task).catch(() => undefined);
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

/** One SPARQL Anything process: a job's query, to run over one of its chunks. */
interface PlannedProcess {
  /** Position in the run, which orders the outputs and names their files. */
  index: number;
  job: ConversionJob;
  chunk?: string;
  /** The job's query as written, with `{SOURCE}` still in it. */
  query: string;
  /** Whether an empty output is a result rather than a failure. */
  outputMayBeEmpty: boolean;
}

/**
 * The processes the planned jobs call for, in order: one per chunk, and one
 * for a job that has none. Lazy, so the workers pulling from it hold one
 * process each rather than the whole run.
 */
function* processesOf(planned: PlannedJob[]): Generator<PlannedProcess> {
  let index = 0;
  for (const { job, query, outputMayBeEmpty } of planned) {
    for (const chunk of job.chunks ?? [undefined]) {
      yield { index: index++, job, chunk, query, outputMayBeEmpty };
    }
  }
}

/** How many processes the planned jobs call for. */
function countOf(planned: PlannedJob[]): number {
  return planned.reduce(
    (total, { job }) => total + (job.chunks?.length ?? 1),
    0,
  );
}

/** What the workers of one run share. */
interface RunState<Task> {
  /** How many processes the run holds, for what reports progress. */
  total: number;
  /** Tasks that have been started and not yet finished. */
  inFlight: Set<Task>;
  /** The first failure, which aborts the run. */
  failure?: unknown;
}

/** A job whose query has been read, and checked against its chunks. */
interface PlannedJob {
  job: ConversionJob;
  /** The query as written, with `{SOURCE}` still in it. */
  query: string;
  /**
   * Whether an empty output is a result rather than a failure: true unless the
   * job has a `load` this process could not see.
   */
  outputMayBeEmpty: boolean;
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
async function plan(
  jobs: ConversionJob[],
  workDir: string,
): Promise<PlannedJob[]> {
  const planned: PlannedJob[] = [];
  for (const job of jobs) {
    const query = await readFile(job.queryFile, 'utf-8');
    const outputMayBeEmpty = await checkLoad(job, workDir);
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
          `Query ‘${job.queryFile}’ never names ${SOURCE_PLACEHOLDER}, so its job’s chunks would go unread`,
        );
      }
      if (job.chunks.length === 0) {
        throw new Error(
          `Job for query ‘${job.queryFile}’ has no chunks; a step that produced none has failed upstream, and converting nothing would hide that`,
        );
      }
    }
    planned.push({ job, query, outputMayBeEmpty });
  }
  return planned;
}

/**
 * Checks the job's `load` before any process runs, and says whether its
 * outputs may be empty.
 *
 * A missing or unparseable chunk makes SPARQL Anything exit non-zero, which
 * aborts the run on its own. A missing `--load` file does not: it logs the
 * problem and runs the query anyway, with exit 0, so a query that reads only
 * loaded data writes an empty output – the same as one whose FILTER matched
 * nothing. Seeing the file from here resolves that: a relative path resolves
 * against `workDir` for the runner as for this process, so one that is missing
 * or empty fails now, naming the file. An absolute path is the runner's – under
 * a container's mount, say – and one this process cannot find proves nothing,
 * so the job's outputs then have to be non-empty.
 */
async function checkLoad(
  job: ConversionJob,
  workDir: string,
): Promise<boolean> {
  if (job.load === undefined) {
    return true;
  }
  const size = await sizeOf(
    isAbsolute(job.load) ? job.load : join(workDir, job.load),
  );
  if (size === undefined) {
    if (isAbsolute(job.load)) {
      return false;
    }
    throw new Error(
      `Load file ‘${job.load}’ does not exist under ‘${workDir}’; a step that should have produced it has failed upstream`,
    );
  }
  if (size === 0) {
    throw new Error(
      `Load file ‘${job.load}’ is empty; a step that produced it has failed upstream, and converting nothing would hide that`,
    );
  }
  return true;
}

/**
 * Throws when the process left no output, or an empty one where that cannot be
 * told from a missing `--load` file (see {@link checkLoad}). Without this a
 * run stays green while its output silently misses every triple of the job.
 */
async function checkOutput(
  outputPath: string,
  job: ConversionJob,
  chunk: string | undefined,
  outputMayBeEmpty: boolean,
): Promise<void> {
  const size = await sizeOf(outputPath);
  const subject = `‘${job.queryFile}’${chunk === undefined ? '' : ` over ‘${chunk}’`}`;
  if (size === undefined) {
    throw new Error(`SPARQL Anything produced no output for ${subject}`);
  }
  if (size === 0 && !outputMayBeEmpty) {
    throw new Error(
      `SPARQL Anything produced no output for ${subject}, and its load file ‘${job.load}’ cannot be seen from here; a missing --load is the one input SPARQL Anything exits 0 on`,
    );
  }
}

/** The size of the file at `path` in bytes, or undefined when there is none. */
async function sizeOf(path: string): Promise<number | undefined> {
  return stat(path).then(
    (stats) => stats.size,
    (error: NodeJS.ErrnoException) => {
      // Anything but a missing file is a problem of its own, and reporting it
      // as an empty conversion would send the reader after the wrong cause.
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return undefined;
    },
  );
}

/** The byte that ends an N-Triples line. */
const NEWLINE = '\n'.charCodeAt(0);

/**
 * Concatenates `inputPaths` into `outputPath`, streaming so multi-GB outputs do
 * not have to fit in memory. N-Triples has no prefixes or document structure, so
 * concatenating per-chunk files yields a single valid document.
 *
 * One pipeline over every input rather than one per input into a shared
 * destination: each pipeline() leaves its listeners on the destination, and
 * past ten of them Node warns of a leak.
 */
async function concatenate(
  inputPaths: string[],
  outputPath: string,
): Promise<void> {
  await pipeline(async function* () {
    let endsInNewline = true;
    for (const inputPath of inputPaths) {
      // A newline between files only when one does not end in one, so the
      // result is byte for byte what `cat` gives: N-Triples tolerates a blank
      // line, but not two triples sharing a line.
      if (!endsInNewline) {
        yield '\n';
      }
      for await (const chunk of createReadStream(
        inputPath,
      ) as AsyncIterable<Buffer>) {
        yield chunk;
        endsInNewline = chunk.at(-1) === NEWLINE;
      }
    }
  }, createWriteStream(outputPath));
}
