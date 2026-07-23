import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Importer } from '../src/importer.js';
import { DockerTaskRunner } from '@lde/task-runner-docker';
import { ImportFailed, ImportSuccessful } from '@lde/sparql-importer';
import { Distribution } from '@lde/dataset';
import { join, resolve } from 'node:path';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  copyFile,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { TaskRunner } from '@lde/task-runner';

function makeDistributions(): Distribution[] {
  return [
    new Distribution(
      new URL('https://example.com/dataset/distribution'),
      'text/turtle',
    ),
  ];
}

/**
 * Stub TaskRunner that records calls and returns fake QLever metadata output.
 */
function stubTaskRunner(tripleCount = 42): TaskRunner<string> & {
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    async run(command: string) {
      commands.push(command);
      return command;
    },
    async wait() {
      return `{"num-triples":{"normal":${tripleCount}}}`;
    },
    async stop() {
      return null;
    },
  };
}

describe('Importer', () => {
  describe('import', () => {
    it('imports Turtle data', async () => {
      const taskRunner = new DockerTaskRunner({
        image: process.env.QLEVER_IMAGE!,
        containerName: 'qlever-importer-test',
        mountDir: resolve('test/fixtures/importer'),
      });

      const importer = new Importer({
        taskRunner,
        indexName: 'test-index',
        downloader: {
          async download() {
            return {
              path: resolve('test/fixtures/importer/data.ttl'),
              headers: new Headers(),
            };
          },
        },
      });

      const distributions = [
        new Distribution(
          new URL('https://example.com/dataset/distribution'),
          'text/turtle',
        ),
      ];

      const result = await importer.import(distributions);
      expect(result).toBeInstanceOf(ImportSuccessful);
      expect((result as ImportSuccessful).tripleCount).toBe(1);
    }, 120_000);
  });

  describe('index caching', () => {
    let tempDir: string;
    let dataFile: string;
    const indexName = 'test-index';

    /** Write the QLever metadata file that `readTripleCount` reads on cache hits. */
    async function writeMetadata(tripleCount: number) {
      await writeFile(
        join(tempDir, `${indexName}.meta-data.json`),
        JSON.stringify({ 'num-triples': { normal: tripleCount } }),
      );
    }

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'qlever-cache-'));
      dataFile = join(tempDir, 'data.ttl');
      await copyFile(resolve('test/fixtures/importer/data.ttl'), dataFile);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    function createImporter(
      taskRunner: TaskRunner<unknown>,
      options?: { cacheIndex?: boolean },
    ) {
      return new Importer({
        taskRunner,
        indexName,
        downloader: {
          async download() {
            return { path: dataFile, headers: new Headers() };
          },
        },
        cacheIndex: options?.cacheIndex,
      });
    }

    it('writes cache marker after successful indexing', async () => {
      const runner = stubTaskRunner(42);
      const importer = createImporter(runner);

      const result = await importer.import(makeDistributions());

      expect(result).toBeInstanceOf(ImportSuccessful);
      expect((result as ImportSuccessful).tripleCount).toBe(42);
      expect(runner.commands.length).toBe(1);

      // Cache marker should exist with only the source file name.
      const cacheInfo = JSON.parse(
        await readFile(join(tempDir, `${indexName}.cache-info.json`), 'utf-8'),
      );
      expect(cacheInfo.sourceFile).toBe('data.ttl');
      expect(cacheInfo).not.toHaveProperty('tripleCount');
    });

    it('skips indexing when cache is up to date', async () => {
      const runner = stubTaskRunner(42);
      const importer = createImporter(runner);

      // First run: indexes and writes cache marker.
      await importer.import(makeDistributions());
      expect(runner.commands.length).toBe(1);

      // Write metadata file (normally created by qlever-index inside the task runner).
      await writeMetadata(42);

      // Second run: cache hit, no indexing.
      const result = await importer.import(makeDistributions());
      expect(result).toBeInstanceOf(ImportSuccessful);
      expect((result as ImportSuccessful).tripleCount).toBe(42);
      expect(runner.commands.length).toBe(1); // Still only one index call.
    });

    it('re-indexes when data file is newer than cache marker', async () => {
      const runner = stubTaskRunner(42);
      const importer = createImporter(runner);

      // First run: creates cache.
      await importer.import(makeDistributions());
      expect(runner.commands.length).toBe(1);

      // Simulate re-download: touch data file to be newer than cache marker.
      const futureTime = new Date(Date.now() + 10_000);
      await utimes(dataFile, futureTime, futureTime);

      // Second run: should re-index because data is newer.
      await importer.import(makeDistributions());
      expect(runner.commands.length).toBe(2);
    });

    it('re-indexes when no cache marker exists (first run)', async () => {
      const runner = stubTaskRunner(10);
      const importer = createImporter(runner);

      const result = await importer.import(makeDistributions());
      expect(result).toBeInstanceOf(ImportSuccessful);
      expect((result as ImportSuccessful).tripleCount).toBe(10);
      expect(runner.commands.length).toBe(1);
    });

    it('re-indexes when source file does not match', async () => {
      const runner = stubTaskRunner(42);
      const importer = createImporter(runner);

      // First run with current data file.
      await importer.import(makeDistributions());
      expect(runner.commands.length).toBe(1);

      // Manually write a cache marker with a different source file.
      await writeFile(
        join(tempDir, `${indexName}.cache-info.json`),
        JSON.stringify({ sourceFile: 'other-dataset.nt' }),
      );

      // Should re-index because source doesn't match.
      await importer.import(makeDistributions());
      expect(runner.commands.length).toBe(2);
    });

    it('returns ImportFailed when indexing produces 0 triples', async () => {
      const runner = stubTaskRunner(0);
      const importer = createImporter(runner);

      const result = await importer.import(makeDistributions());

      expect(result).toBeInstanceOf(ImportFailed);
      expect((result as ImportFailed).error).toBe(
        'Indexed 0 triples from distribution',
      );
    });

    it('returns ImportFailed when cached index has 0 triples', async () => {
      const runner = stubTaskRunner(42);
      const importer = createImporter(runner);

      // First run: indexes and writes cache marker.
      await importer.import(makeDistributions());

      // Write metadata with 0 triples.
      await writeMetadata(0);

      // Second run: cache hit but 0 triples.
      const result = await importer.import(makeDistributions());
      expect(result).toBeInstanceOf(ImportFailed);
      expect((result as ImportFailed).error).toBe(
        'Index is cached but contains 0 triples',
      );
    });

    it('retries with parallel parsing disabled on multiline string literal error', async () => {
      let callCount = 0;
      const runner: TaskRunner<string> & { commands: string[] } = {
        commands: [],
        async run(command: string) {
          runner.commands.push(command);
          return command;
        },
        async wait() {
          callCount++;
          if (callCount === 1) {
            throw new Error(
              'The input contains a multiline string literal, please retry with --parse-parallel false',
            );
          }
          return '{"num-triples":{"normal":42}}';
        },
        async stop() {
          return null;
        },
      };
      const importer = createImporter(runner);

      const result = await importer.import(makeDistributions());

      expect(result).toBeInstanceOf(ImportSuccessful);
      expect(runner.commands.length).toBe(2);
      expect(runner.commands[0]).toContain('-p true');
      expect(runner.commands[1]).toContain('-p false');
    });

    it('does not retry non-multiline-literal errors', async () => {
      const runner: TaskRunner<string> & { commands: string[] } = {
        commands: [],
        async run(command: string) {
          runner.commands.push(command);
          return command;
        },
        async wait() {
          throw new Error('some other indexing error');
        },
        async stop() {
          return null;
        },
      };
      const importer = createImporter(runner);

      const result = await importer.import(makeDistributions());

      expect(result).toBeInstanceOf(ImportFailed);
      expect((result as ImportFailed).error).toBe('some other indexing error');
      expect(runner.commands.length).toBe(1);
    });

    it('re-indexes when cacheIndex is false even with fresh cache', async () => {
      // First: create a cache marker via a cacheIndex=true run.
      const runner = stubTaskRunner(42);
      const importerWithCache = createImporter(runner, { cacheIndex: true });
      await importerWithCache.import(makeDistributions());
      expect(runner.commands.length).toBe(1);

      // Now create an importer with cacheIndex=false.
      const importerNoCache = createImporter(runner, { cacheIndex: false });
      await importerNoCache.import(makeDistributions());
      expect(runner.commands.length).toBe(2); // Forced re-index.
    });

    it('overrides format from server Content-Type when it contradicts declared MIME type', async () => {
      const runner = stubTaskRunner(42);
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download() {
            return {
              path: dataFile,
              headers: new Headers({ 'Content-Type': 'application/n-quads' }),
            };
          },
        },
      });

      // Distribution declares application/n-triples, server says application/n-quads.
      const distributions = [
        new Distribution(
          new URL('https://example.com/data.nq'),
          'application/n-triples',
        ),
      ];

      const result = await importer.import(distributions);

      expect(result).toBeInstanceOf(ImportSuccessful);
      expect(runner.commands[0]).toContain('-F nq');
      expect((result as ImportSuccessful).warnings).toEqual([
        'Server Content-Type application/n-quads does not match declared media type application/n-triples; using nq format',
      ]);
    });

    it('shell-escapes data filenames containing single quotes', async () => {
      // A dataset titled e.g. "'s-Hertogenbosch" maps to a local filename with
      // an apostrophe. Naive single-quoting (`cat '<name>'`) lets the apostrophe
      // terminate the quote, so cat/gunzip read a non-existent path and feed
      // qlever-index empty input – silently indexing 0 triples.
      const trickyFile = join(
        tempDir,
        "Dataset+Beeldbank+Erfgoed+'s-Hertogenbosch.ttl",
      );
      await copyFile(dataFile, trickyFile);

      const runner = stubTaskRunner(42);
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download() {
            return { path: trickyFile, headers: new Headers() };
          },
        },
      });

      const result = await importer.import(makeDistributions());

      expect(result).toBeInstanceOf(ImportSuccessful);

      const command = runner.commands[0];
      // The apostrophe is POSIX-escaped, not left to break the quoting.
      expect(command).toContain(
        "Dataset+Beeldbank+Erfgoed+'\\''s-Hertogenbosch.ttl",
      );
      expect(command).not.toContain("Erfgoed+'s"); // the broken, unescaped form

      // And the decompress sub-command actually reads the real file when a shell
      // runs it – this is what produced empty input (0 triples) before the fix.
      const decompress = command.slice(0, command.indexOf('| qlever-index'));
      const output = execFileSync('sh', ['-c', decompress], {
        cwd: tempDir,
      }).toString();
      expect(output).toContain('http://example.com/source');
    });

    it('falls back to file extension when Content-Type is a compression type', async () => {
      const nqFile = join(tempDir, 'data.nq');
      await copyFile(dataFile, nqFile);

      const runner = stubTaskRunner(42);
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download() {
            return {
              path: nqFile,
              headers: new Headers({ 'Content-Type': 'application/gzip' }),
            };
          },
        },
      });

      const distributions = [
        new Distribution(
          new URL('https://example.com/data.nq.gz'),
          'application/n-triples',
        ),
      ];

      const result = await importer.import(distributions);

      expect(result).toBeInstanceOf(ImportSuccessful);
      expect(runner.commands[0]).toContain('-F nq');
      expect((result as ImportSuccessful).warnings).toEqual([
        'Declared media type application/n-triples does not match file extension .nq; using nq format',
      ]);
    });

    it('uses declared MIME type format when all sources agree', async () => {
      const runner = stubTaskRunner(42);
      const importer = createImporter(runner);

      const result = await importer.import(makeDistributions());

      expect(result).toBeInstanceOf(ImportSuccessful);
      expect(runner.commands[0]).toContain('-F ttl');
      expect((result as ImportSuccessful).warnings).toEqual([]);
    });

    it('prefers native RDF formats over JSON-LD when both are offered', async () => {
      const runner = stubTaskRunner(42);
      const downloadedDistributions: Distribution[] = [];
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download(distribution: Distribution) {
            downloadedDistributions.push(distribution);
            return { path: dataFile, headers: new Headers() };
          },
        },
      });

      // JSON-LD first in the array; importer must sort it last.
      await importer.import([
        new Distribution(
          new URL('https://example.com/data.jsonld'),
          'application/ld+json',
        ),
        new Distribution(
          new URL('https://example.com/data.nq'),
          'application/n-quads',
        ),
      ]);

      expect(downloadedDistributions[0]?.mimeType).toBe('application/n-quads');
    });

    it('prefers a native streaming dump over TriG when both are offered', async () => {
      const runner = stubTaskRunner(42);
      const downloadedDistributions: Distribution[] = [];
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download(distribution: Distribution) {
            downloadedDistributions.push(distribution);
            return { path: dataFile, headers: new Headers() };
          },
        },
      });

      // TriG first in the array; importer must sort it last.
      await importer.import([
        new Distribution(
          new URL('https://example.com/data.trig'),
          'application/trig',
        ),
        new Distribution(
          new URL('https://example.com/data.nq'),
          'application/n-quads',
        ),
      ]);

      expect(downloadedDistributions[0]?.mimeType).toBe('application/n-quads');
    });

    it('orders distributions: native → JSON-LD', async () => {
      const runner = stubTaskRunner(0); // 0 triples → ImportFailed → tries next
      const downloadedDistributions: Distribution[] = [];
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download(distribution: Distribution) {
            downloadedDistributions.push(distribution);
            // Throw so JSON-LD preprocessing isn't attempted on data.ttl.
            throw new Error('download stub: skip this distribution');
          },
        },
      });

      await importer.import([
        new Distribution(
          new URL('https://example.com/data.jsonld'),
          'application/ld+json',
        ),
        new Distribution(
          new URL('https://example.com/data.nt'),
          'application/n-triples',
        ),
      ]);

      expect(downloadedDistributions.map((d) => d.mimeType)).toEqual([
        'application/n-triples',
        'application/ld+json',
      ]);
    });

    it('runs JSON-LD through the preprocessor and indexes the resulting N-Quads', async () => {
      const runner = stubTaskRunner(42);
      const jsonldFile = join(tempDir, 'data.jsonld');
      await copyFile(
        resolve('test/fixtures/preprocess/data.jsonld'),
        jsonldFile,
      );
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download() {
            return { path: jsonldFile, headers: new Headers() };
          },
        },
      });

      const result = await importer.import([
        new Distribution(
          new URL('https://example.com/data.jsonld'),
          'application/ld+json',
        ),
      ]);

      expect(result).toBeInstanceOf(ImportSuccessful);
      // The preprocessed N-Quads file is what reaches qlever-index.
      expect(runner.commands[0]).toContain('data.jsonld.preprocessed.nq');
      expect(runner.commands[0]).toContain('-F nq');
    });

    it('runs RDF/XML through the preprocessor and indexes the resulting N-Quads', async () => {
      const runner = stubTaskRunner(42);
      const rdfFile = join(tempDir, 'data.rdf');
      await copyFile(resolve('test/fixtures/preprocess/data.rdf'), rdfFile);
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download() {
            return { path: rdfFile, headers: new Headers() };
          },
        },
      });

      const result = await importer.import([
        new Distribution(
          new URL('https://example.com/data.rdf'),
          'application/rdf+xml',
        ),
      ]);

      expect(result).toBeInstanceOf(ImportSuccessful);
      // The preprocessed N-Quads file is what reaches qlever-index.
      expect(runner.commands[0]).toContain('data.rdf.preprocessed.nq');
      expect(runner.commands[0]).toContain('-F nq');
    });

    it('uses unzip -p in the shell pipeline for .zip files', async () => {
      const runner = stubTaskRunner(42);
      const zipFile = join(tempDir, 'data.nt.zip');
      // Reuse the data.zip fixture; what matters here is the .zip extension.
      await copyFile(resolve('test/fixtures/preprocess/data.zip'), zipFile);
      const importer = new Importer({
        taskRunner: runner,
        indexName,
        downloader: {
          async download() {
            return { path: zipFile, headers: new Headers() };
          },
        },
      });

      await importer.import([
        new Distribution(
          new URL('https://example.com/data.nt.zip'),
          'application/n-triples',
        ),
      ]);

      expect(runner.commands[0]).toContain("unzip -p 'data.nt.zip'");
      expect(runner.commands[0]).not.toContain('gunzip -c');
    });

    it('does not accept a standalone application/zip distribution', async () => {
      const runner = stubTaskRunner(42);
      const importer = createImporter(runner);

      const result = await importer.import([
        new Distribution(
          new URL('https://example.com/data.zip'),
          'application/zip',
        ),
      ]);

      // NotSupported indicates no distribution was acceptable.
      expect(result.constructor.name).toBe('NotSupported');
    });
  });
});
