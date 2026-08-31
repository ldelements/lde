import { ConversionJob, SparqlAnythingConverter } from '../src/index.js';
import { TaskRunner } from '@lde/task-runner';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

/** Options for a {@link FakeTaskRunner}. */
interface FakeTaskRunnerOptions {
  /** When set, `wait()` rejects for commands whose output path contains this. */
  failOutputContaining?: string;
  /**
   * When set, chunks whose output path contains this get an empty `--output`
   * file, as SPARQL Anything writes when it cannot read or parse an input.
   */
  emptyOutputContaining?: string;
  /**
   * When set, chunks whose output path contains this get no `--output` file at
   * all, as SPARQL Anything leaves behind when it crashes before writing.
   */
  missingOutputContaining?: string;
  /**
   * When set, chunks whose output path contains this get an `--output` that
   * cannot be inspected – a symlink to itself, which fails `stat` with ELOOP.
   */
  unreadableOutputContaining?: string;
  /** Milliseconds `wait()` takes, per output path, to order completions. */
  waitFor?: Record<string, number>;
  /** Milliseconds `wait()` takes for any output not named in `waitFor`. */
  waitForAll?: number;
  /** Milliseconds `run()` takes, per output path, before the task exists. */
  runFor?: Record<string, number>;
  /** When set, `stop()` rejects, as a runner does for a container already gone. */
  stopFails?: boolean;
}

/**
 * Records the commands it is asked to run and simulates SPARQL Anything:
 * it captures the query passed via `-q <file>` and writes the `--output <file>`
 * the converter later concatenates. The output content is the output path
 * itself, so concatenation order is observable.
 *
 * Like a real task runner, it resolves relative paths against its working
 * directory.
 */
class FakeTaskRunner implements TaskRunner<{ command: string }> {
  readonly commands: string[] = [];
  readonly queries: string[] = [];
  /** Commands that were stopped before they finished. */
  readonly stopped: string[] = [];
  /** The most processes that were ever in flight at the same time. */
  peakInFlight = 0;
  private inFlight = 0;

  constructor(
    private readonly workDir: string,
    private readonly options: FakeTaskRunnerOptions = {},
  ) {}

  async run(command: string): Promise<{ command: string }> {
    this.commands.push(command);
    const queryFile = tokenAfter(command, '-q');
    if (queryFile) {
      this.queries.push(await readFile(this.resolve(queryFile), 'utf-8'));
    }
    const outputFile = tokenAfter(command, '--output');
    if (outputFile) {
      await this.writeOutput(outputFile);
      const delay = delayFor(this.options.runFor, outputFile) ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return { command };
  }

  /** Resolves a runner-relative path the way a working directory does. */
  private resolve(path: string): string {
    return isAbsolute(path) ? path : join(this.workDir, path);
  }

  /** Writes what SPARQL Anything would leave at `outputFile`. */
  private async writeOutput(outputFile: string): Promise<void> {
    const {
      emptyOutputContaining,
      missingOutputContaining,
      unreadableOutputContaining,
    } = this.options;
    if (matches(outputFile, missingOutputContaining)) {
      return;
    }
    const path = this.resolve(outputFile);
    if (matches(outputFile, unreadableOutputContaining)) {
      await symlink(path, path);
      return;
    }
    await writeFile(
      path,
      matches(outputFile, emptyOutputContaining) ? '' : `${outputFile}\n`,
    );
  }

  async wait(task: { command: string }): Promise<string> {
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      const delay =
        delayFor(this.options.waitFor, tokenAfter(task.command, '--output')) ??
        this.options.waitForAll ??
        0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (matches(task.command, this.options.failOutputContaining)) {
        throw new Error('Process failed with code 1');
      }
      return '';
    } finally {
      this.inFlight--;
    }
  }

  async stop(task: { command: string }): Promise<string | null> {
    this.stopped.push(task.command);
    if (this.options.stopFails === true) {
      throw new Error('No such container');
    }
    return null;
  }
}

/**
 * The delay configured for an output path. Keyed by file name, while the
 * command names it relative to the run directory.
 */
function delayFor(
  delays: Record<string, number> | undefined,
  outputPath?: string,
): number | undefined {
  if (delays === undefined || outputPath === undefined) {
    return undefined;
  }
  const named = Object.entries(delays).find(([name]) =>
    outputPath.endsWith(name),
  );
  return named?.[1];
}

/** Whether `needle` is configured and `haystack` contains it. */
function matches(haystack: string, needle?: string): boolean {
  return needle !== undefined && haystack.includes(needle);
}

/** Reads the whitespace-delimited token following `flag` in a command string. */
function tokenAfter(command: string, flag: string): string | undefined {
  const tokens = command.split(/\s+/);
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1]?.replaceAll("'", '') : undefined;
}

describe('SparqlAnythingConverter', () => {
  let workDir: string;
  let queryFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sparql-anything-test-'));
    queryFile = join(workDir, 'places.rq');
    await writeFile(
      queryFile,
      'CONSTRUCT { ?s ?p ?o } WHERE { fx:location "{SOURCE}" }',
    );
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** A converter over `taskRunner`, with the options every test shares. */
  function converterFor(taskRunner: FakeTaskRunner) {
    return new SparqlAnythingConverter({
      jarPath: '/bin/sparql-anything.jar',
      workDir,
      taskRunner,
    });
  }

  /** One job running the shared query over every one of `chunks`. */
  function jobsFor(chunks: string[], load?: string): ConversionJob[] {
    return [{ queryFile, chunks, load }];
  }

  /** Writes `count` chunk files and returns their paths. */
  async function writeChunks(count: number): Promise<string[]> {
    const chunks = Array.from({ length: count }, (_, index) =>
      join(workDir, `chunk-${index}.csv`),
    );
    for (const chunk of chunks) {
      await writeFile(chunk, 'header\nrow');
    }
    return chunks;
  }

  it('runs SPARQL Anything for a chunk with the SPARQL Anything CLI contract', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await converterFor(taskRunner).convert(
      jobsFor([chunk], '/data/reference.ttl'),
      join(workDir, 'output.nt'),
    );

    expect(taskRunner.commands).toHaveLength(1);
    const command = taskRunner.commands[0];
    expect(command).toContain("java '-Xmx2g' -jar '/bin/sparql-anything.jar'");
    expect(command).toContain("--load '/data/reference.ttl'");
    expect(command).toContain('--format NT');
    expect(command).toMatch(/-q 'sparql-anything-\S+\/query-0\.rq'/);
    expect(command).toMatch(/--output 'sparql-anything-\S+\/output-0\.nt'/);
  });

  it('quotes every interpolated path, so a space or a metacharacter cannot break out', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await new SparqlAnythingConverter({
      jarPath: '/bin/sparql anything.jar',
      workDir,
      taskRunner,
    }).convert(
      jobsFor([chunk], "/data/'s-Hertogenbosch.ttl"),
      join(workDir, 'output.nt'),
    );

    const command = taskRunner.commands[0];
    expect(command).toContain("java '-Xmx2g' -jar '/bin/sparql anything.jar'");
    expect(command).toContain("--load '/data/'\\''s-Hertogenbosch.ttl'");
  });

  it('caps the heap even when none is configured', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await converterFor(taskRunner).convert(
      jobsFor([chunk]),
      join(workDir, 'output.nt'),
    );

    // An uncapped JVM takes a quarter of host memory; a chunk that outgrows
    // this default fails loudly instead, on the JVM's own OutOfMemoryError.
    expect(taskRunner.commands[0]).toMatch(/^java '-Xmx2g' -jar /);
  });

  it('caps the heap before -jar, and appends extra CLI arguments', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await new SparqlAnythingConverter({
      jarPath: '/bin/sparql-anything.jar',
      workDir,
      heap: '512m',
      cliArgs: ['-ad'],
      taskRunner,
    }).convert(jobsFor([chunk]), join(workDir, 'output.nt'));

    expect(taskRunner.commands[0]).toMatch(
      /^java '-Xmx512m' -jar '\/bin\/sparql-anything\.jar' .* '-ad'$/,
    );
  });

  it('rejects a heap that is not a size -Xmx takes', () => {
    const taskRunner = new FakeTaskRunner(workDir);

    expect(
      () =>
        new SparqlAnythingConverter({
          jarPath: '/bin/sparql-anything.jar',
          workDir,
          heap: '-Xmx2g',
          taskRunner,
        }),
    ).toThrow('is not a heap size');
  });

  it('substitutes a chunk path literally, however it looks', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    // `$&` is a replacement pattern in a JavaScript string replacement, and
    // would otherwise put the placeholder itself back into the query.
    const chunk = join(workDir, 'chunk-$&.csv');
    await writeFile(chunk, 'header\nrow');

    await converterFor(taskRunner).convert(
      [{ queryFile, chunks: [chunk] }],
      join(workDir, 'output.nt'),
    );

    expect(taskRunner.queries[0]).toContain(`fx:location "${chunk}"`);
  });

  it('rejects a heap of zero, which no process would survive', () => {
    const taskRunner = new FakeTaskRunner(workDir);

    expect(
      () =>
        new SparqlAnythingConverter({
          jarPath: '/bin/sparql-anything.jar',
          workDir,
          heap: '0g',
          taskRunner,
        }),
    ).toThrow('is not a heap size');
  });

  it('rejects CLI arguments the converter sets itself', () => {
    const taskRunner = new FakeTaskRunner(workDir);

    // Overriding --output would leave the converter reading back a file
    // SPARQL Anything never wrote, reported as an empty conversion.
    expect(
      () =>
        new SparqlAnythingConverter({
          jarPath: '/bin/sparql-anything.jar',
          workDir,
          cliArgs: ['-o', 'elsewhere.nt'],
          taskRunner,
        }),
    ).toThrow('the converter sets these itself');
  });

  it('rejects a reserved CLI argument in its --flag=value form', () => {
    const taskRunner = new FakeTaskRunner(workDir);

    // Left through, this would have concatenated Turtle as if it were
    // N-Triples, and the run would have stayed green.
    expect(
      () =>
        new SparqlAnythingConverter({
          jarPath: '/bin/sparql-anything.jar',
          workDir,
          cliArgs: ['--format=TTL'],
          taskRunner,
        }),
    ).toThrow('the converter sets these itself');
  });

  it('omits --load when no path is configured', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await converterFor(taskRunner).convert(
      jobsFor([chunk]),
      join(workDir, 'output.nt'),
    );

    expect(taskRunner.commands[0]).not.toContain('--load');
  });

  it('substitutes the chunk path into the query, leaving no placeholder', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await converterFor(taskRunner).convert(
      jobsFor([chunk]),
      join(workDir, 'output.nt'),
    );

    expect(taskRunner.queries).toHaveLength(1);
    expect(taskRunner.queries[0]).toContain(`fx:location "${chunk}"`);
    expect(taskRunner.queries[0]).not.toContain('{SOURCE}');
  });

  it('runs every chunk and concatenates their outputs in order', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const chunks = await writeChunks(3);
    const outputPath = join(workDir, 'output.nt');

    await converterFor(taskRunner).convert(jobsFor(chunks), outputPath);

    expect(taskRunner.commands).toHaveLength(3);
    // The FakeTaskRunner writes each chunk's output path as that file's
    // content, so the result reflects the order the chunks were processed.
    expect(await readFile(outputPath, 'utf-8')).toMatch(
      /^sparql-anything-\S+\/output-0\.nt\n\nsparql-anything-\S+\/output-1\.nt\n\nsparql-anything-\S+\/output-2\.nt\n$/,
    );
  });

  it('leaves nothing behind in the working directory', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const chunks = await writeChunks(2);

    await converterFor(taskRunner).convert(
      jobsFor(chunks),
      join(workDir, 'output.nt'),
    );

    // Only the caller's own files: the chunks, the query and the output. A
    // leftover chunk output would satisfy the non-empty check on a later run.
    expect((await readdir(workDir)).sort()).toEqual([
      'chunk-0.csv',
      'chunk-1.csv',
      'output.nt',
      'places.rq',
    ]);
  });

  it('states a query and its --load once for every chunk of a job', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const chunks = await writeChunks(3);

    await converterFor(taskRunner).convert(
      [{ queryFile, chunks, load: '/data/reference.ttl' }],
      join(workDir, 'output.nt'),
    );

    // One process per chunk, each with the job's query and --load.
    expect(taskRunner.commands).toHaveLength(3);
    for (const command of taskRunner.commands) {
      expect(command).toContain("--load '/data/reference.ttl'");
    }
    expect(taskRunner.queries.map((query) => query)).toEqual(
      chunks.map(
        (chunk) => `CONSTRUCT { ?s ?p ?o } WHERE { fx:location "${chunk}" }`,
      ),
    );
  });

  it('refuses a job whose chunk list is empty', async () => {
    const taskRunner = new FakeTaskRunner(workDir);

    await expect(
      converterFor(taskRunner).convert(
        [{ queryFile, chunks: [] }],
        join(workDir, 'output.nt'),
      ),
    ).rejects.toThrow('has no chunks; a step that produced none');
  });

  it('runs a job whose query names its own input', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const ontologyQuery = join(workDir, 'ontology.rq');
    await writeFile(ontologyQuery, 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');

    // Not every invocation reads a chunk: some name their input in the query,
    // or take it through --load.
    await converterFor(taskRunner).convert(
      [{ queryFile: ontologyQuery, load: '/data/ontology.rdf' }],
      join(workDir, 'output.nt'),
    );

    expect(taskRunner.commands[0]).toContain("--load '/data/ontology.rdf'");
  });

  it('names the query when a chunkless job produces no output', async () => {
    const taskRunner = new FakeTaskRunner(workDir, {
      emptyOutputContaining: 'output-0.nt',
    });
    const ontologyQuery = join(workDir, 'ontology.rq');
    await writeFile(ontologyQuery, 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');

    await expect(
      converterFor(taskRunner).convert(
        [{ queryFile: ontologyQuery, load: '/data/ontology.rdf' }],
        join(workDir, 'output.nt'),
      ),
    ).rejects.toThrow(/produced no output for ‘.*ontology\.rq’;/);
  });

  it('refuses a job whose query names {SOURCE} but has no chunk', async () => {
    const taskRunner = new FakeTaskRunner(workDir);

    await expect(
      converterFor(taskRunner).convert(
        [{ queryFile }],
        join(workDir, 'output.nt'),
      ),
    ).rejects.toThrow('has no chunks');
  });

  it('refuses a job whose query would leave its chunks unread', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);
    const ontologyQuery = join(workDir, 'ontology.rq');
    await writeFile(ontologyQuery, 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');

    await expect(
      converterFor(taskRunner).convert(
        [{ queryFile: ontologyQuery, chunks: [chunk] }],
        join(workDir, 'output.nt'),
      ),
    ).rejects.toThrow('would go unread');
  });

  it('converts several chunks at once, up to the configured concurrency', async () => {
    // A delay every chunk shares, so the overlap does not depend on timing.
    const taskRunner = new FakeTaskRunner(workDir, { waitForAll: 20 });
    const chunks = await writeChunks(6);

    await new SparqlAnythingConverter({
      jarPath: '/bin/sparql-anything.jar',
      workDir,
      concurrency: 3,
      taskRunner,
    }).convert([{ queryFile, chunks }], join(workDir, 'output.nt'));

    expect(taskRunner.commands).toHaveLength(6);
    expect(taskRunner.peakInFlight).toBe(3);
  });

  it('converts one chunk at a time by default', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const chunks = await writeChunks(3);

    await converterFor(taskRunner).convert(
      [{ queryFile, chunks }],
      join(workDir, 'output.nt'),
    );

    expect(taskRunner.peakInFlight).toBe(1);
  });

  it('concatenates in the order given, not the order they finished', async () => {
    const chunks = await writeChunks(3);
    // The first chunk finishes last.
    const taskRunner = new FakeTaskRunner(workDir, {
      waitFor: { 'output-0.nt': 30, 'output-1.nt': 10 },
    });
    const outputPath = join(workDir, 'output.nt');

    await new SparqlAnythingConverter({
      jarPath: '/bin/sparql-anything.jar',
      workDir,
      concurrency: 3,
      taskRunner,
    }).convert([{ queryFile, chunks }], outputPath);

    expect(await readFile(outputPath, 'utf-8')).toMatch(
      /^sparql-anything-\S+\/output-0\.nt\n\nsparql-anything-\S+\/output-1\.nt\n\nsparql-anything-\S+\/output-2\.nt\n$/,
    );
  });

  it('stops the chunks still running when one fails', async () => {
    const chunks = await writeChunks(4);
    const taskRunner = new FakeTaskRunner(workDir, {
      failOutputContaining: 'output-0.nt',
      // The others outlive the failure, so they have to be stopped rather than
      // left writing into the directory convert() is about to delete.
      waitFor: { 'output-1.nt': 200, 'output-2.nt': 200 },
    });

    await expect(
      new SparqlAnythingConverter({
        jarPath: '/bin/sparql-anything.jar',
        workDir,
        concurrency: 3,
        taskRunner,
      }).convert([{ queryFile, chunks }], join(workDir, 'output.nt')),
    ).rejects.toThrow('Process failed');

    expect(taskRunner.stopped).toHaveLength(2);
    // The fourth chunk was never started.
    expect(taskRunner.commands).toHaveLength(3);
  });

  it('reports the conversion failure even when stopping the others fails', async () => {
    const chunks = await writeChunks(3);
    // A task runner cannot stop a container that has already gone; saying so
    // must not replace the failure that is worth reporting.
    const taskRunner = new FakeTaskRunner(workDir, {
      failOutputContaining: 'output-0.nt',
      waitFor: { 'output-1.nt': 100, 'output-2.nt': 100 },
      stopFails: true,
    });

    await expect(
      new SparqlAnythingConverter({
        jarPath: '/bin/sparql-anything.jar',
        workDir,
        concurrency: 3,
        taskRunner,
      }).convert([{ queryFile, chunks }], join(workDir, 'output.nt')),
    ).rejects.toThrow('Process failed');
  });

  it('stops a chunk that started while the run was failing', async () => {
    const chunks = await writeChunks(2);
    // The second chunk's process appears only after the first has failed, so
    // it is not among the ones that failure stopped.
    const taskRunner = new FakeTaskRunner(workDir, {
      failOutputContaining: 'output-0.nt',
      runFor: { 'output-1.nt': 50 },
    });

    await expect(
      new SparqlAnythingConverter({
        jarPath: '/bin/sparql-anything.jar',
        workDir,
        concurrency: 2,
        taskRunner,
      }).convert([{ queryFile, chunks }], join(workDir, 'output.nt')),
    ).rejects.toThrow('Process failed');

    expect(taskRunner.stopped).toEqual([
      expect.stringContaining('output-1.nt'),
    ]);
  });

  it('rejects a concurrency that is not a whole number of processes', () => {
    const taskRunner = new FakeTaskRunner(workDir);

    expect(
      () =>
        new SparqlAnythingConverter({
          jarPath: '/bin/sparql-anything.jar',
          workDir,
          concurrency: 0,
          taskRunner,
        }),
    ).toThrow('is not a number of chunks to convert at once');
  });

  it('refuses an empty job list rather than writing an empty output', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const outputPath = join(workDir, 'output.nt');

    await expect(
      converterFor(taskRunner).convert([], outputPath),
    ).rejects.toThrow('without jobs');

    expect(taskRunner.commands).toHaveLength(0);
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
  });

  it('aborts when a chunk produces an empty output', async () => {
    const chunks = await writeChunks(3);
    // SPARQL Anything exits 0 but writes nothing when it cannot read an input.
    const taskRunner = new FakeTaskRunner(workDir, {
      emptyOutputContaining: 'output-1.nt',
    });
    const outputPath = join(workDir, 'output.nt');

    await expect(
      converterFor(taskRunner).convert(jobsFor(chunks), outputPath),
    ).rejects.toThrow('produced no output');

    // The second chunk was empty, so the third never ran and nothing was merged.
    expect(taskRunner.commands).toHaveLength(2);
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
  });

  it('aborts when a chunk produces no output file', async () => {
    const chunks = await writeChunks(2);
    const taskRunner = new FakeTaskRunner(workDir, {
      missingOutputContaining: 'output-0.nt',
    });

    await expect(
      converterFor(taskRunner).convert(
        jobsFor(chunks),
        join(workDir, 'output.nt'),
      ),
    ).rejects.toThrow('produced no output');

    expect(taskRunner.commands).toHaveLength(1);
  });

  it('surfaces an output that cannot be inspected as itself', async () => {
    const chunks = await writeChunks(2);
    const taskRunner = new FakeTaskRunner(workDir, {
      unreadableOutputContaining: 'output-0.nt',
    });

    // Not reported as an empty conversion: the cause is a different one.
    await expect(
      converterFor(taskRunner).convert(
        jobsFor(chunks),
        join(workDir, 'output.nt'),
      ),
    ).rejects.toThrow(/ELOOP/);

    expect(taskRunner.commands).toHaveLength(1);
  });

  it('aborts without writing output when a chunk fails', async () => {
    const chunks = await writeChunks(3);
    const taskRunner = new FakeTaskRunner(workDir, {
      failOutputContaining: 'output-1.nt',
    });
    const outputPath = join(workDir, 'output.nt');

    await expect(
      converterFor(taskRunner).convert(jobsFor(chunks), outputPath),
    ).rejects.toThrow('Process failed');

    // The second chunk failed, so the third never ran and no output was merged.
    expect(taskRunner.commands).toHaveLength(2);
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
  });
});
