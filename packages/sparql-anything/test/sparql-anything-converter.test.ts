import { SparqlAnythingConverter } from '../src/index.js';
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
    const { failOutputContaining } = this.options;
    if (matches(task.command, failOutputContaining)) {
      throw new Error('Process failed with code 1');
    }
    return '';
  }

  async stop(): Promise<string | null> {
    return null;
  }
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
  function converterFor(taskRunner: FakeTaskRunner, load?: string) {
    return new SparqlAnythingConverter({
      queryFile,
      jarPath: '/bin/sparql-anything.jar',
      workDir,
      load,
      taskRunner,
    });
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

    await converterFor(taskRunner, '/data/reference.ttl').convert(
      [chunk],
      join(workDir, 'output.nt'),
    );

    expect(taskRunner.commands).toHaveLength(1);
    const command = taskRunner.commands[0];
    expect(command).toContain("java -jar '/bin/sparql-anything.jar'");
    expect(command).toContain("--load '/data/reference.ttl'");
    expect(command).toContain('--format NT');
    expect(command).toMatch(/-q 'sparql-anything-\S+\/query-0\.rq'/);
    expect(command).toMatch(/--output 'sparql-anything-\S+\/chunk-0\.nt'/);
  });

  it('quotes every interpolated path, so a space or a metacharacter cannot break out', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await new SparqlAnythingConverter({
      queryFile,
      jarPath: '/bin/sparql anything.jar',
      workDir,
      load: "/data/'s-Hertogenbosch.ttl",
      taskRunner,
    }).convert([chunk], join(workDir, 'output.nt'));

    const command = taskRunner.commands[0];
    expect(command).toContain("java -jar '/bin/sparql anything.jar'");
    expect(command).toContain("--load '/data/'\\''s-Hertogenbosch.ttl'");
  });

  it('passes JVM options before -jar, and extra CLI arguments after', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await new SparqlAnythingConverter({
      queryFile,
      jarPath: '/bin/sparql-anything.jar',
      workDir,
      javaOptions: ['-Xmx2g'],
      cliArgs: ['-ad'],
      taskRunner,
    }).convert([chunk], join(workDir, 'output.nt'));

    expect(taskRunner.commands[0]).toMatch(
      /^java '-Xmx2g' -jar '\/bin\/sparql-anything\.jar' .* '-ad'$/,
    );
  });

  it('runs a bare java command when neither is configured', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await converterFor(taskRunner).convert([chunk], join(workDir, 'output.nt'));

    expect(taskRunner.commands[0]).toMatch(/^java -jar /);
  });

  it('omits --load when no path is configured', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await converterFor(taskRunner).convert([chunk], join(workDir, 'output.nt'));

    expect(taskRunner.commands[0]).not.toContain('--load');
  });

  it('substitutes the chunk path into the query, leaving no placeholder', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const [chunk] = await writeChunks(1);

    await converterFor(taskRunner).convert([chunk], join(workDir, 'output.nt'));

    expect(taskRunner.queries).toHaveLength(1);
    expect(taskRunner.queries[0]).toContain(`fx:location "${chunk}"`);
    expect(taskRunner.queries[0]).not.toContain('{SOURCE}');
  });

  it('runs every chunk and concatenates their outputs in order', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const chunks = await writeChunks(3);
    const outputPath = join(workDir, 'output.nt');

    await converterFor(taskRunner).convert(chunks, outputPath);

    expect(taskRunner.commands).toHaveLength(3);
    // The FakeTaskRunner writes each chunk's output path as that file's
    // content, so the result reflects the order the chunks were processed.
    expect(await readFile(outputPath, 'utf-8')).toMatch(
      /^sparql-anything-\S+\/chunk-0\.nt\n\nsparql-anything-\S+\/chunk-1\.nt\n\nsparql-anything-\S+\/chunk-2\.nt\n$/,
    );
  });

  it('leaves nothing behind in the working directory', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const chunks = await writeChunks(2);

    await converterFor(taskRunner).convert(chunks, join(workDir, 'output.nt'));

    // Only the caller's own files: the chunks, the query and the output. A
    // leftover chunk output would satisfy the non-empty check on a later run.
    expect((await readdir(workDir)).sort()).toEqual([
      'chunk-0.csv',
      'chunk-1.csv',
      'output.nt',
      'places.rq',
    ]);
  });

  it('refuses an empty chunk list rather than writing an empty output', async () => {
    const taskRunner = new FakeTaskRunner(workDir);
    const outputPath = join(workDir, 'output.nt');

    await expect(
      converterFor(taskRunner).convert([], outputPath),
    ).rejects.toThrow('without chunks');

    expect(taskRunner.commands).toHaveLength(0);
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
  });

  it('aborts when a chunk produces an empty output', async () => {
    const chunks = await writeChunks(3);
    // SPARQL Anything exits 0 but writes nothing when it cannot read an input.
    const taskRunner = new FakeTaskRunner(workDir, {
      emptyOutputContaining: 'chunk-1.nt',
    });
    const outputPath = join(workDir, 'output.nt');

    await expect(
      converterFor(taskRunner).convert(chunks, outputPath),
    ).rejects.toThrow('produced no output');

    // The second chunk was empty, so the third never ran and nothing was merged.
    expect(taskRunner.commands).toHaveLength(2);
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
  });

  it('aborts when a chunk produces no output file', async () => {
    const chunks = await writeChunks(2);
    const taskRunner = new FakeTaskRunner(workDir, {
      missingOutputContaining: 'chunk-0.nt',
    });

    await expect(
      converterFor(taskRunner).convert(chunks, join(workDir, 'output.nt')),
    ).rejects.toThrow('produced no output');

    expect(taskRunner.commands).toHaveLength(1);
  });

  it('surfaces an output that cannot be inspected as itself', async () => {
    const chunks = await writeChunks(2);
    const taskRunner = new FakeTaskRunner(workDir, {
      unreadableOutputContaining: 'chunk-0.nt',
    });

    // Not reported as an empty conversion: the cause is a different one.
    await expect(
      converterFor(taskRunner).convert(chunks, join(workDir, 'output.nt')),
    ).rejects.toThrow(/ELOOP/);

    expect(taskRunner.commands).toHaveLength(1);
  });

  it('aborts without writing output when a chunk fails', async () => {
    const chunks = await writeChunks(3);
    const taskRunner = new FakeTaskRunner(workDir, {
      failOutputContaining: 'chunk-1.nt',
    });
    const outputPath = join(workDir, 'output.nt');

    await expect(
      converterFor(taskRunner).convert(chunks, outputPath),
    ).rejects.toThrow('Process failed');

    // The second chunk failed, so the third never ran and no output was merged.
    expect(taskRunner.commands).toHaveLength(2);
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
  });
});
