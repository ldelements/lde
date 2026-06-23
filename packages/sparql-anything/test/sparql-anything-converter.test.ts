import { SparqlAnythingConverter } from '../src/index.js';
import { TaskRunner } from '@lde/task-runner';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Records the commands it is asked to run and simulates SPARQL Anything:
 * it captures the query passed via `-q <file>` and writes the `--output <file>`
 * the converter later concatenates. The output content is the output path
 * itself, so concatenation order is observable.
 */
class FakeTaskRunner implements TaskRunner<{ command: string }> {
  readonly commands: string[] = [];
  readonly queries: string[] = [];

  /** When set, `wait()` rejects for commands whose output path contains this. */
  constructor(private readonly failOutputContaining?: string) {}

  async run(command: string): Promise<{ command: string }> {
    this.commands.push(command);
    const queryFile = tokenAfter(command, '-q');
    if (queryFile) {
      this.queries.push(await readFile(queryFile, 'utf-8'));
    }
    const outputFile = tokenAfter(command, '--output');
    if (outputFile) {
      await writeFile(outputFile, `${outputFile}\n`);
    }
    return { command };
  }

  async wait(task: { command: string }): Promise<string> {
    if (
      this.failOutputContaining &&
      task.command.includes(this.failOutputContaining)
    ) {
      throw new Error('Process failed with code 1');
    }
    return '';
  }

  async stop(): Promise<string | null> {
    return null;
  }
}

/** Reads the whitespace-delimited token following `flag` in a command string. */
function tokenAfter(command: string, flag: string): string | undefined {
  const tokens = command.split(/\s+/);
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
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

  it('runs SPARQL Anything for a chunk with the SPARQL Anything CLI contract', async () => {
    const taskRunner = new FakeTaskRunner();
    const converter = new SparqlAnythingConverter({
      queryFile,
      jarPath: '/bin/sparql-anything.jar',
      adminCodesFile: '/data/admin-codes.ttl',
      taskRunner,
    });
    const chunk = join(workDir, 'geonames_aa.csv');
    await writeFile(chunk, 'header\nrow');

    await converter.convert([chunk], join(workDir, 'geonames.nt'));

    expect(taskRunner.commands).toHaveLength(1);
    const command = taskRunner.commands[0];
    expect(command).toContain('java -jar /bin/sparql-anything.jar');
    expect(command).toContain('--load /data/admin-codes.ttl');
    expect(command).toContain('--format NT');
    expect(command).toContain(`--output ${chunk}.nt`);
    expect(command).toMatch(/-q \S+\.rq/);
  });

  it('substitutes the chunk path into the query, leaving no placeholder', async () => {
    const taskRunner = new FakeTaskRunner();
    const converter = new SparqlAnythingConverter({
      queryFile,
      jarPath: '/bin/sparql-anything.jar',
      adminCodesFile: '/data/admin-codes.ttl',
      taskRunner,
    });
    const chunk = join(workDir, 'geonames_aa.csv');
    await writeFile(chunk, 'header\nrow');

    await converter.convert([chunk], join(workDir, 'geonames.nt'));

    expect(taskRunner.queries).toHaveLength(1);
    expect(taskRunner.queries[0]).toContain(`fx:location "${chunk}"`);
    expect(taskRunner.queries[0]).not.toContain('{SOURCE}');
  });

  it('runs every chunk and concatenates their outputs in order', async () => {
    const taskRunner = new FakeTaskRunner();
    const converter = new SparqlAnythingConverter({
      queryFile,
      jarPath: '/bin/sparql-anything.jar',
      adminCodesFile: '/data/admin-codes.ttl',
      taskRunner,
    });
    const chunks = [
      join(workDir, 'geonames_aa.csv'),
      join(workDir, 'geonames_ab.csv'),
      join(workDir, 'geonames_ac.csv'),
    ];
    for (const chunk of chunks) {
      await writeFile(chunk, 'header\nrow');
    }
    const outputPath = join(workDir, 'geonames.nt');

    await converter.convert(chunks, outputPath);

    expect(taskRunner.commands).toHaveLength(3);
    // The FakeTaskRunner writes each chunk's `.nt` path as that file's content,
    // so the concatenated output reflects the order the chunks were processed.
    const output = await readFile(outputPath, 'utf-8');
    expect(output).toBe(chunks.map((chunk) => `${chunk}.nt\n`).join(''));
  });

  it('aborts without writing output when a chunk fails', async () => {
    const chunks = [
      join(workDir, 'geonames_aa.csv'),
      join(workDir, 'geonames_ab.csv'),
      join(workDir, 'geonames_ac.csv'),
    ];
    for (const chunk of chunks) {
      await writeFile(chunk, 'header\nrow');
    }
    const taskRunner = new FakeTaskRunner('geonames_ab.csv.nt');
    const converter = new SparqlAnythingConverter({
      queryFile,
      jarPath: '/bin/sparql-anything.jar',
      adminCodesFile: '/data/admin-codes.ttl',
      taskRunner,
    });
    const outputPath = join(workDir, 'geonames.nt');

    await expect(converter.convert(chunks, outputPath)).rejects.toThrow(
      'Process failed',
    );

    // The second chunk failed, so the third never ran and no output was merged.
    expect(taskRunner.commands).toHaveLength(2);
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
  });
});
