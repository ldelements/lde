import { FileWriter } from '../../src/writer/fileWriter.js';
import { Dataset, Distribution } from '@lde/dataset';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const { namedNode, literal, quad, blankNode } = DataFactory;

async function* quadsOf(...quads: Quad[]): AsyncIterable<Quad> {
  yield* quads;
}

describe('FileWriter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'file-writer-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createDataset(iri: string): Dataset {
    return new Dataset({
      iri: new URL(iri),
      distributions: [
        Distribution.sparql(new URL('http://example.com/sparql')),
      ],
    });
  }

  describe('write', () => {
    it('writes quads to N-Triples file by default', async () => {
      const writer = await new FileWriter({ outputDir: tempDir }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );
      await writer.flush(dataset);

      const files = await readFile(
        join(tempDir, 'example.com-dataset-1.nt'),
        'utf-8',
      );
      expect(files).toContain('<http://example.com/subject>');
      expect(files).toContain('<http://example.com/predicate>');
      expect(files).toContain('"object"');
    });

    it('writes N-Triples format', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-triples',
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.nt'),
        'utf-8',
      );
      expect(content).toContain('<http://example.com/subject>');
    });

    it('does not write empty data', async () => {
      const writer = await new FileWriter({ outputDir: tempDir }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(dataset, quadsOf());
      await writer.flush(dataset);

      await expect(
        readFile(join(tempDir, 'example.com-dataset-1.nt')),
      ).rejects.toThrow();
    });

    it('combines quads from multiple write calls into a single file', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-triples',
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s1'),
            namedNode('http://example.com/p'),
            literal('first'),
          ),
        ),
      );

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s2'),
            namedNode('http://example.com/p'),
            literal('second'),
          ),
        ),
      );

      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.nt'),
        'utf-8',
      );
      expect(content).toContain('<http://example.com/s1>');
      expect(content).toContain('<http://example.com/s2>');
      expect(content).toContain('"first"');
      expect(content).toContain('"second"');
    });

    it('uses custom replacement character in filenames', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        replacementCharacter: '_',
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com_dataset_1.nt'),
        'utf-8',
      );
      expect(content).toBeTruthy();
    });

    it('creates nested output directories', async () => {
      const nestedDir = join(tempDir, 'nested', 'output');
      const writer = await new FileWriter({ outputDir: nestedDir }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(nestedDir, 'example.com-dataset-1.nt'),
        'utf-8',
      );
      expect(content).toBeTruthy();
    });
  });

  describe('named graphs (n-quads)', () => {
    it('writes each quad into the graph derived from graphIri', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
        graphIri: (dataset) => dataset.iri,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.nq'),
        'utf-8',
      );
      // The graph is the 4th term on the line.
      expect(content.trim()).toBe(
        '<http://example.com/subject> <http://example.com/predicate> "object" <http://example.com/dataset/1> .',
      );
    });

    it('supports a graphIri unrelated to the dataset IRI (e.g. validation report)', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
        graphIri: (dataset) =>
          new URL(
            `https://reports.example/${encodeURIComponent(dataset.iri.toString())}`,
          ),
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.nq'),
        'utf-8',
      );
      expect(content).toContain(
        '<https://reports.example/http%3A%2F%2Fexample.com%2Fdataset%2F1>',
      );
    });

    it('writes the default graph when graphIri is omitted', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.nq'),
        'utf-8',
      );
      // No 4th term: the triple sits in the default graph.
      expect(content.trim()).toBe(
        '<http://example.com/subject> <http://example.com/predicate> "object" .',
      );
    });

    it('ignores graphIri for turtle output', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'turtle',
        graphIri: (dataset) => dataset.iri,
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.ttl'),
        'utf-8',
      );
      expect(content).not.toContain('http://example.com/dataset/1');
    });
  });

  describe('blank-node skolemisation (n-quads)', () => {
    const HAS_MEASUREMENT = 'http://www.w3.org/ns/dqv#hasQualityMeasurement';
    const VALUE = 'http://www.w3.org/ns/dqv#value';
    const measurement = (datasetIri: string) =>
      quadsOf(
        quad(
          namedNode(datasetIri),
          namedNode(HAS_MEASUREMENT),
          blankNode('b0'),
        ),
        quad(blankNode('b0'), namedNode(VALUE), literal('true')),
      );
    const skolemIris = (content: string) =>
      [...content.matchAll(/<[^>]*\/\.well-known\/skolem#[^>]*>/g)].map(
        (match) => match[0],
      );

    it('rewrites blank nodes to dataset-scoped skolem IRIs', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
        graphIri: (dataset) => dataset.iri,
      }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(dataset, measurement('http://example.com/dataset/1'));
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.nq'),
        'utf-8',
      );
      expect(content).not.toContain('_:');
      expect(content).toContain(
        'http://example.com/dataset/1/.well-known/skolem#',
      );
    });

    it('keeps the same blank-node label distinct across datasets (no fusion)', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
        graphIri: (dataset) => dataset.iri,
      }).openRun();
      const a = createDataset('http://example.com/dataset/a');
      const b = createDataset('http://example.com/dataset/b');

      await writer.write(a, measurement('http://example.com/dataset/a'));
      await writer.flush(a);
      await writer.write(b, measurement('http://example.com/dataset/b'));
      await writer.flush(b);

      const [ia] = skolemIris(
        await readFile(join(tempDir, 'example.com-dataset-a.nq'), 'utf-8'),
      );
      const [ib] = skolemIris(
        await readFile(join(tempDir, 'example.com-dataset-b.nq'), 'utf-8'),
      );
      expect(ia).toContain('/dataset/a/');
      expect(ib).toContain('/dataset/b/');
      expect(ia).not.toBe(ib);
    });

    it('maps a coreferenced blank node to one IRI within a write', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
        graphIri: (dataset) => dataset.iri,
      }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');

      // b0 appears as object, then as subject: both must resolve to one IRI.
      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            blankNode('b0'),
          ),
          quad(
            blankNode('b0'),
            namedNode('http://example.com/q'),
            literal('x'),
          ),
        ),
      );
      await writer.flush(dataset);

      const iris = skolemIris(
        await readFile(join(tempDir, 'example.com-dataset-1.nq'), 'utf-8'),
      );
      expect(iris).toHaveLength(2);
      expect(new Set(iris).size).toBe(1);
    });

    it('does not skolemise blank nodes for turtle output', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'turtle',
      }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');

      // Two quads so the (non-skolemising) streaming path writes past the first.
      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            blankNode('b0'),
          ),
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p2'),
            literal('plain'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.ttl'),
        'utf-8',
      );
      expect(content).not.toContain('/.well-known/skolem#');
      expect(content).toContain('plain');
    });
  });

  describe('atomic flush', () => {
    it('only materializes the final file on flush, never a truncated one', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
      }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');
      const finalPath = join(tempDir, 'example.com-dataset-1.nq');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );

      // Before flush: the final file does not exist yet — a crash here leaves
      // only a `.tmp`, never a half-written final file.
      expect(await exists(finalPath)).toBe(false);

      await writer.flush(dataset);

      // After flush: the final file exists and the temp is gone.
      expect(await exists(finalPath)).toBe(true);
      expect(await exists(`${finalPath}.tmp`)).toBe(false);
    });

    it('cleans up the temp file and rejects when the stream fails', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'n-quads',
      }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');
      const finalPath = join(tempDir, 'example.com-dataset-1.nq');
      const tempPath = `${finalPath}.tmp`;

      // Pre-create a directory exactly where the temp file would be opened, so
      // the write stream fails to open (EISDIR) — a deterministic stand-in for
      // a mid-flush I/O failure.
      await mkdir(tempPath, { recursive: true });

      await writer
        .write(
          dataset,
          quadsOf(
            quad(
              namedNode('http://example.com/s'),
              namedNode('http://example.com/p'),
              literal('o'),
            ),
          ),
        )
        .catch(() => undefined);
      // Let the asynchronous open error settle.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await expect(writer.flush(dataset)).rejects.toThrow();

      // No final file was produced, and the temp path was cleaned up.
      expect(await exists(finalPath)).toBe(false);
      expect(await exists(tempPath)).toBe(false);
    });
  });

  describe('flush', () => {
    it('is a no-op when no write was made for the dataset', async () => {
      const writer = await new FileWriter({ outputDir: tempDir }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');

      // Should not throw.
      await writer.flush(dataset);
    });
  });

  describe('run lifecycle', () => {
    it('commit finalizes files that were never flushed per dataset', async () => {
      const run = await new FileWriter({ outputDir: tempDir }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');
      const finalPath = join(tempDir, 'example.com-dataset-1.nt');

      await run.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );
      await run.commit();

      expect(await exists(finalPath)).toBe(true);
      expect(await exists(`${finalPath}.tmp`)).toBe(false);
    });

    it('abort discards temp output and produces no final file', async () => {
      const run = await new FileWriter({ outputDir: tempDir }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');
      const finalPath = join(tempDir, 'example.com-dataset-1.nt');

      await run.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );
      await run.abort(new Error('failure elsewhere in the run'));

      expect(await exists(finalPath)).toBe(false);
      expect(await exists(`${finalPath}.tmp`)).toBe(false);
    });

    it('keeps runs isolated: files flushed in one run are untouched by another run’s abort', async () => {
      const writer = new FileWriter({ outputDir: tempDir });
      const dataset = createDataset('http://example.com/dataset/1');
      const finalPath = join(tempDir, 'example.com-dataset-1.nt');

      const firstRun = await writer.openRun();
      await firstRun.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/kept'),
            namedNode('http://example.com/p'),
            literal('first run'),
          ),
        ),
      );
      await firstRun.commit();

      const secondRun = await writer.openRun();
      await secondRun.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/discarded'),
            namedNode('http://example.com/p'),
            literal('second run'),
          ),
        ),
      );
      await secondRun.abort(new Error('second run failed'));

      const content = await readFile(finalPath, 'utf-8');
      expect(content).toContain('<http://example.com/kept>');
      expect(content).not.toContain('<http://example.com/discarded>');
    });
  });

  describe('Turtle prefixes', () => {
    it('writes prefix declarations and compacts IRIs', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'turtle',
        prefixes: {
          ex: 'http://example.com/',
        },
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.ttl'),
        'utf-8',
      );
      expect(content).toContain('@prefix ex: <http://example.com/>');
      expect(content).toContain('ex:subject');
      expect(content).toContain('ex:predicate');
    });

    it('writes a single prefix block across multiple write calls', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'turtle',
        prefixes: {
          ex: 'http://example.com/',
        },
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s1'),
            namedNode('http://example.com/p'),
            literal('first'),
          ),
        ),
      );

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s2'),
            namedNode('http://example.com/p'),
            literal('second'),
          ),
        ),
      );

      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.ttl'),
        'utf-8',
      );

      // Prefix block should appear exactly once.
      const prefixCount = content.split('@prefix').length - 1;
      expect(prefixCount).toBe(1);

      // Both triples should be present.
      expect(content).toContain('"first"');
      expect(content).toContain('"second"');
    });

    it('writes full IRIs when no prefixes are provided', async () => {
      const writer = await new FileWriter({
        outputDir: tempDir,
        format: 'turtle',
      }).openRun();

      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/subject'),
            namedNode('http://example.com/predicate'),
            literal('object'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.ttl'),
        'utf-8',
      );
      expect(content).toContain('<http://example.com/subject>');
      expect(content).not.toContain('@prefix');
    });
  });

  describe('reset', () => {
    it('discards quads written before the reset', async () => {
      const writer = await new FileWriter({ outputDir: tempDir }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');

      // First pass (e.g. endpoint-sourced) writes a quad, then is discarded.
      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/discarded'),
            namedNode('http://example.com/p'),
            literal('endpoint'),
          ),
        ),
      );
      await writer.reset(dataset);

      // Second pass (dump-sourced) writes a different quad.
      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/kept'),
            namedNode('http://example.com/p'),
            literal('dump'),
          ),
        ),
      );
      await writer.flush(dataset);

      const content = await readFile(
        join(tempDir, 'example.com-dataset-1.nt'),
        'utf-8',
      );
      expect(content).toContain('<http://example.com/kept>');
      expect(content).not.toContain('<http://example.com/discarded>');
    });

    it('removes the dataset’s temp file so a discarded pass leaves nothing behind', async () => {
      const writer = await new FileWriter({ outputDir: tempDir }).openRun();
      const dataset = createDataset('http://example.com/dataset/1');

      await writer.write(
        dataset,
        quadsOf(
          quad(
            namedNode('http://example.com/s'),
            namedNode('http://example.com/p'),
            literal('o'),
          ),
        ),
      );
      await writer.reset(dataset);

      expect(await exists(join(tempDir, 'example.com-dataset-1.nt.tmp'))).toBe(
        false,
      );
    });
  });
});
