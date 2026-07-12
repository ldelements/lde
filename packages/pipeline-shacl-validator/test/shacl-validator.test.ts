import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Parser } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Dataset } from '@lde/dataset';
import {
  FileWriter,
  assertNoBlankNodes,
  type RunContext,
  type Writer,
} from '@lde/pipeline';
import { ShaclValidator, severity } from '../src/shacl-validator.js';

const SH_RESULT = 'http://www.w3.org/ns/shacl#result';
const SH_CONFORMS = 'http://www.w3.org/ns/shacl#conforms';
const SH_CONFORMANCE_DISALLOWS =
  'http://www.w3.org/ns/shacl#conformanceDisallows';

/**
 * A transactional fake report writer exposing its run's `write` and `flush`
 * mocks directly, so tests can stub and assert per-dataset behaviour.
 */
function makeReportWriter(): Writer & {
  write: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  const write = vi.fn().mockResolvedValue(undefined);
  const flush = vi.fn().mockResolvedValue(undefined);
  return {
    write,
    flush,
    openRun: async () => ({
      write,
      flush,
      commit: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    }),
  };
}

async function reportQuadsFor(
  filename: string,
  forDataset: Dataset = dataset,
): Promise<Quad[]> {
  let received: Quad[] = [];
  const writer = makeReportWriter();
  writer.write.mockImplementation(async (_dataset: Dataset, quads) => {
    received = await collectQuads(quads);
  });
  const validator = new ShaclValidator({ shapesFile, reportWriters: [writer] });
  await validator.validate(parseFixture(filename), forDataset);
  return received;
}

const shapesFile = join(__dirname, 'fixtures', 'shapes.ttl');

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});

function parseFixture(filename: string): Quad[] {
  const parser = new Parser();
  const content = readFileSync(join(__dirname, 'fixtures', filename), 'utf-8');
  return parser.parse(content);
}

async function collectQuads(iterable: AsyncIterable<Quad>): Promise<Quad[]> {
  const quads: Quad[] = [];
  for await (const quad of iterable) quads.push(quad);
  return quads;
}

describe('ShaclValidator', () => {
  it('returns conforms:true for valid data', async () => {
    const validator = new ShaclValidator({ shapesFile });
    const quads = parseFixture('valid.ttl');

    const result = await validator.validate(quads, dataset);

    expect(result.conforms).toBe(true);
    expect(result.violations).toBe(0);
  });

  it('returns violations for invalid data', async () => {
    const validator = new ShaclValidator({ shapesFile });
    const quads = parseFixture('invalid.ttl');

    const result = await validator.validate(quads, dataset);

    expect(result.conforms).toBe(false);
    expect(result.violations).toBeGreaterThan(0);
  });

  it('sets a message on the result when reportWriters consumed violations', async () => {
    // The pipeline's halt-mode error reads ValidationResult.message to point
    // operators at the report; without writers there is nowhere to point.
    const writer = makeReportWriter();
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    const withViolations = await validator.validate(
      parseFixture('invalid.ttl'),
      dataset,
    );
    expect(withViolations.message).toMatch(/writer/i);

    const withoutWriters = await new ShaclValidator({ shapesFile }).validate(
      parseFixture('invalid.ttl'),
      dataset,
    );
    expect(withoutWriters.message).toBeUndefined();
  });

  it('streams report quads to every configured writer on violations', async () => {
    const writer1 = makeReportWriter();
    writer1.write.mockImplementation(async (_dataset: Dataset, quads) => {
      await collectQuads(quads);
    });
    const writer2 = makeReportWriter();
    writer2.write.mockImplementation(async (_dataset: Dataset, quads) => {
      await collectQuads(quads);
    });
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer1, writer2],
    });

    await validator.validate(parseFixture('invalid.ttl'), dataset);

    expect(writer1.write).toHaveBeenCalledOnce();
    expect(writer2.write).toHaveBeenCalledOnce();
    const [received1] = writer1.write.mock.calls[0];
    expect(received1.iri.toString()).toBe(dataset.iri.toString());
  });

  it('opens one report run per writer with a context of its own', async () => {
    const contexts: RunContext[] = [];
    const writer: Writer = {
      openRun: async (context) => {
        contexts.push(context);
        return {
          write: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          abort: () => Promise.resolve(),
        };
      },
    };
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await validator.validate(parseFixture('invalid.ttl'), dataset);
    await validator.validate(parseFixture('invalid.ttl'), dataset);

    // One long-lived run across all validate calls, with an identity of its
    // own and an empty selection (report writers do not sweep by membership).
    expect(contexts).toHaveLength(1);
    expect(contexts[0].runId).toBeTruthy();
    expect([...contexts[0].selectedSources()]).toEqual([]);
  });

  it('defers the report to report() when validate() finds no results', async () => {
    // A conforming batch streams nothing from validate(); the report – a
    // minimal conforming one – is written once at report() time instead, so
    // every validated dataset yields a report.
    const writer = makeReportWriter();
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await validator.validate(parseFixture('valid.ttl'), dataset);
    expect(writer.write).not.toHaveBeenCalled();

    await validator.report(dataset);
    expect(writer.write).toHaveBeenCalledOnce();
  });

  it('writes a minimal conforming report for a validated clean dataset', async () => {
    let received: Quad[] = [];
    const writer = makeReportWriter();
    writer.write.mockImplementation(async (_dataset: Dataset, quads) => {
      received = await collectQuads(quads);
    });
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await validator.validate(parseFixture('valid.ttl'), dataset);
    await validator.report(dataset);

    const conforms = received.filter(
      (quad) => quad.predicate.value === SH_CONFORMS,
    );
    expect(conforms).toHaveLength(1);
    expect(conforms[0].object.value).toBe('true');
    // A conforming report has no results, and is skolemised like any other.
    expect(received.some((quad) => quad.predicate.value === SH_RESULT)).toBe(
      false,
    );
    assertNoBlankNodes(received);
  });

  it('writes no report for a dataset that was never validated', async () => {
    // Report absence must mean "not validated" – so an unseen dataset (no
    // accumulator) writes nothing, only flushes.
    const writer = makeReportWriter();
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await validator.report(dataset);

    expect(writer.write).not.toHaveBeenCalled();
    expect(writer.flush).toHaveBeenCalledOnce();
  });

  it('does not synthesise a conforming report when a violation write failed', async () => {
    // If a report write throws mid-batch for a non-conforming dataset (leaving
    // reportWritten false), report() must not relabel it conforming by writing
    // a minimal conforming report over the missing violations.
    let synthesised = false;
    const writer: Writer = {
      openRun: async () => ({
        write: async (_dataset: Dataset, quads: AsyncIterable<Quad>) => {
          const collected = await collectQuads(quads);
          // A synthesised conforming report is the only write carrying
          // sh:conforms "true" (the violation write from validate() carries
          // sh:conforms "false"); flag if report() ever emits one here.
          if (
            collected.some(
              (quad) =>
                quad.predicate.value === SH_CONFORMS &&
                quad.object.value === 'true',
            )
          ) {
            synthesised = true;
          }
          throw new Error('writer boom');
        },
        flush: () => Promise.resolve(),
        commit: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      }),
    };
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await expect(
      validator.validate(parseFixture('invalid.ttl'), dataset),
    ).rejects.toThrow('writer boom');

    const report = await validator.report(dataset);
    expect(report.conforms).toBe(false);
    expect(synthesised).toBe(false);
  });

  it('passes report quads (sh:ValidationResult triples) to writers', async () => {
    let received: Quad[] = [];
    const writer = makeReportWriter();
    writer.write.mockImplementation(async (_dataset: Dataset, quads) => {
      received = await collectQuads(quads);
    });
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await validator.validate(parseFixture('invalid.ttl'), dataset);

    expect(received.length).toBeGreaterThan(0);
    expect(
      received.some((q) =>
        q.predicate.value.startsWith('http://www.w3.org/ns/shacl#'),
      ),
    ).toBe(true);
  });

  it('skolemises report blank nodes to dataset-scoped IRIs', async () => {
    // shacl-engine emits the report and every result as blank nodes, which fuse
    // across datasets in a file-based store's cat-built index (ldelements/lde#478).
    const received = await reportQuadsFor('invalid.ttl');

    expect(received.length).toBeGreaterThan(0);
    assertNoBlankNodes(received);
    const base = 'http://example.org/dataset/.well-known/shacl#';
    expect(
      received.every(
        (quad) =>
          (quad.subject.termType === 'NamedNode'
            ? quad.subject.value.startsWith(base)
            : true) &&
          (quad.object.termType === 'NamedNode' &&
          quad.object.value.includes('/.well-known/shacl#')
            ? quad.object.value.startsWith(base)
            : true),
      ),
    ).toBe(true);
  });

  it('keys result IRIs on the dataset, so they do not fuse across datasets', async () => {
    const other = new Dataset({
      iri: new URL('http://example.org/other'),
      distributions: [],
    });
    const resultsOf = (quads: Quad[]) =>
      quads
        .filter((quad) => quad.predicate.value === SH_RESULT)
        .map((quad) => quad.object.value);

    const here = resultsOf(await reportQuadsFor('invalid.ttl'));
    const there = resultsOf(await reportQuadsFor('invalid.ttl', other));

    expect(here.length).toBeGreaterThan(0);
    expect(there.length).toBeGreaterThan(0);
    expect(here.some((result) => there.includes(result))).toBe(false);
  });

  it('gives each violation a distinct result IRI within one report', async () => {
    const results = (await reportQuadsFor('invalid-two.ttl'))
      .filter((quad) => quad.predicate.value === SH_RESULT)
      .map((quad) => quad.object.value);

    expect(results).toHaveLength(2);
    expect(new Set(results).size).toBe(2);
  });

  it('flushes each writer when report() is called', async () => {
    const writer = makeReportWriter();
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await validator.validate(parseFixture('invalid.ttl'), dataset);
    await validator.report(dataset);

    expect(writer.flush).toHaveBeenCalledOnce();
    expect(writer.flush).toHaveBeenCalledWith(dataset, 'success');
  });

  it('flushes writers even when no violations were emitted for the dataset', async () => {
    // Reports a still-conformant dataset: flush is the lifecycle hook for
    // "this dataset is done", independent of whether violations occurred.
    const writer = makeReportWriter();
    const validator = new ShaclValidator({
      shapesFile,
      reportWriters: [writer],
    });

    await validator.validate(parseFixture('valid.ttl'), dataset);
    await validator.report(dataset);

    expect(writer.flush).toHaveBeenCalledOnce();
  });

  it('accumulates results across validate calls', async () => {
    const validator = new ShaclValidator({ shapesFile });
    const validQuads = parseFixture('valid.ttl');
    const invalidQuads = parseFixture('invalid.ttl');

    await validator.validate(validQuads, dataset);
    await validator.validate(invalidQuads, dataset);

    const report = await validator.report(dataset);
    expect(report.conforms).toBe(false);
    expect(report.violations).toBeGreaterThan(0);
    expect(report.quadsValidated).toBe(validQuads.length + invalidQuads.length);
  });

  it('returns empty report for unseen dataset', async () => {
    const validator = new ShaclValidator({ shapesFile });
    const other = new Dataset({
      iri: new URL('http://example.org/other'),
      distributions: [],
    });

    const report = await validator.report(other);
    expect(report.conforms).toBe(true);
    expect(report.violations).toBe(0);
    expect(report.quadsValidated).toBe(0);
  });

  it('returns conforms:true for empty quads', async () => {
    const validator = new ShaclValidator({ shapesFile });

    const result = await validator.validate([], dataset);

    expect(result.conforms).toBe(true);
    expect(result.violations).toBe(0);
  });

  it('caches shapes across validate calls', async () => {
    const validator = new ShaclValidator({ shapesFile });
    const quads = parseFixture('valid.ttl');

    await validator.validate(quads, dataset);
    await validator.validate(quads, dataset);

    const report = await validator.report(dataset);
    expect(report.conforms).toBe(true);
    expect(report.quadsValidated).toBe(quads.length * 2);
  });

  describe('conformanceDisallows', () => {
    const severitiesShapesFile = join(
      __dirname,
      'fixtures',
      'shapes-severities.ttl',
    );

    it('fails on warning-only results by default, per the SHACL 1.2 default set', async () => {
      const validator = new ShaclValidator({
        shapesFile: severitiesShapesFile,
      });

      const result = await validator.validate(
        parseFixture('warning-only.ttl'),
        dataset,
      );

      expect(result.conforms).toBe(false);
      expect(result.violations).toBe(1);
    });

    it('lets warning-only results conform when only sh:Violation disallows conformance', async () => {
      const validator = new ShaclValidator({
        shapesFile: severitiesShapesFile,
        conformanceDisallows: [severity.violation],
      });

      const result = await validator.validate(
        parseFixture('warning-only.ttl'),
        dataset,
      );

      expect(result.conforms).toBe(true);
      expect(result.violations).toBe(0);
    });

    it('still fails on violations when only sh:Violation disallows conformance', async () => {
      const validator = new ShaclValidator({
        shapesFile: severitiesShapesFile,
        conformanceDisallows: [severity.violation],
      });

      // Triggers all three property shapes: one Violation, one Warning, one
      // custom severity — only the Violation counts.
      const result = await validator.validate(
        parseFixture('invalid.ttl'),
        dataset,
      );

      expect(result.conforms).toBe(false);
      expect(result.violations).toBe(1);
    });

    it('supports custom severity IRIs in the disallow set', async () => {
      const validator = new ShaclValidator({
        shapesFile: severitiesShapesFile,
        conformanceDisallows: ['http://example.org/Critical'],
      });

      const result = await validator.validate(
        parseFixture('custom-severity-only.ttl'),
        dataset,
      );

      expect(result.conforms).toBe(false);
      expect(result.violations).toBe(1);
    });

    it('streams below-threshold results to writers even when the dataset conforms', async () => {
      let received: Quad[] = [];
      const writer = makeReportWriter();
      writer.write.mockImplementation(async (_dataset: Dataset, quads) => {
        received = await collectQuads(quads);
      });
      const validator = new ShaclValidator({
        shapesFile: severitiesShapesFile,
        conformanceDisallows: [severity.violation],
        reportWriters: [writer],
      });

      const result = await validator.validate(
        parseFixture('warning-only.ttl'),
        dataset,
      );

      expect(result.conforms).toBe(true);
      expect(
        received.filter((quad) => quad.predicate.value === SH_RESULT),
      ).toHaveLength(1);
    });

    it('writes a report whose sh:conforms and sh:conformanceDisallows reflect the configured set', async () => {
      let received: Quad[] = [];
      const writer = makeReportWriter();
      writer.write.mockImplementation(async (_dataset: Dataset, quads) => {
        received = await collectQuads(quads);
      });
      const validator = new ShaclValidator({
        shapesFile: severitiesShapesFile,
        conformanceDisallows: [severity.violation],
        reportWriters: [writer],
      });

      await validator.validate(parseFixture('warning-only.ttl'), dataset);

      const conformsQuads = received.filter(
        (quad) => quad.predicate.value === SH_CONFORMS,
      );
      expect(conformsQuads).toHaveLength(1);
      expect(conformsQuads[0].object.value).toBe('true');
      const disallowsQuads = received.filter(
        (quad) => quad.predicate.value === SH_CONFORMANCE_DISALLOWS,
      );
      expect(disallowsQuads.map((quad) => quad.object.value)).toEqual([
        severity.violation,
      ]);
    });

    it('declares sh:conformanceDisallows on the conforming report synthesised at report() time', async () => {
      // valid.ttl produces no results, so report() writes the minimal
      // conforming report – which must still be self-describing per SHACL 1.2.
      let received: Quad[] = [];
      const writer = makeReportWriter();
      writer.write.mockImplementation(async (_dataset: Dataset, quads) => {
        received = await collectQuads(quads);
      });
      const validator = new ShaclValidator({
        shapesFile,
        conformanceDisallows: [severity.violation],
        reportWriters: [writer],
      });

      await validator.validate(parseFixture('valid.ttl'), dataset);
      await validator.report(dataset);

      expect(
        received
          .filter((quad) => quad.predicate.value === SH_CONFORMS)
          .map((quad) => quad.object.value),
      ).toEqual(['true']);
      expect(
        received
          .filter((quad) => quad.predicate.value === SH_CONFORMANCE_DISALLOWS)
          .map((quad) => quad.object.value),
      ).toEqual([severity.violation]);
    });

    it('does not add sh:conformanceDisallows to reports when the option is absent', async () => {
      const received = await reportQuadsFor('invalid.ttl');

      expect(
        received.some(
          (quad) => quad.predicate.value === SH_CONFORMANCE_DISALLOWS,
        ),
      ).toBe(false);
    });

    it('accumulates conformance against the configured set across validate calls', async () => {
      const validator = new ShaclValidator({
        shapesFile: severitiesShapesFile,
        conformanceDisallows: [severity.violation],
      });

      await validator.validate(parseFixture('warning-only.ttl'), dataset);
      await validator.validate(parseFixture('valid.ttl'), dataset);

      const report = await validator.report(dataset);
      expect(report.conforms).toBe(true);
      expect(report.violations).toBe(0);
    });
  });

  describe('with FileWriter', () => {
    let outputDir: string;

    beforeEach(async () => {
      outputDir = await mkdtemp(join(tmpdir(), 'shacl-validator-test-'));
    });

    afterEach(async () => {
      await rm(outputDir, { recursive: true, force: true });
    });

    it('writes a report file when configured with a FileWriter', async () => {
      const fileWriter = new FileWriter({ outputDir, format: 'turtle' });
      const validator = new ShaclValidator({
        shapesFile,
        reportWriters: [fileWriter],
      });

      await validator.validate(parseFixture('invalid.ttl'), dataset);
      await validator.report(dataset);

      const files = await readdir(outputDir);
      expect(files).toHaveLength(1);
      const content = await readFile(join(outputDir, files[0]), 'utf-8');
      expect(content).toContain('shacl');
    });

    it('writes a conforming report file when there are no violations', async () => {
      const fileWriter = new FileWriter({ outputDir, format: 'turtle' });
      const validator = new ShaclValidator({
        shapesFile,
        reportWriters: [fileWriter],
      });

      await validator.validate(parseFixture('valid.ttl'), dataset);
      await validator.report(dataset);

      const entries = await readdir(outputDir);
      expect(entries).toHaveLength(1);
      const content = await readFile(join(outputDir, entries[0]), 'utf-8');
      expect(content).toContain('ValidationReport');
      expect(content).not.toContain('ValidationResult');
    });

    it('overwrites a prior run’s violation report when the dataset becomes conforming', async () => {
      // The #421 case: a first run leaves a report file full of violations; a
      // later run in which the dataset conforms must replace it, not leave the
      // stale violations behind for the served index to keep surfacing.
      const firstRun = new ShaclValidator({
        shapesFile,
        reportWriters: [new FileWriter({ outputDir, format: 'turtle' })],
      });
      await firstRun.validate(parseFixture('invalid.ttl'), dataset);
      await firstRun.report(dataset);
      const [firstFile] = await readdir(outputDir);
      expect(await readFile(join(outputDir, firstFile), 'utf-8')).toContain(
        'ValidationResult',
      );

      const secondRun = new ShaclValidator({
        shapesFile,
        reportWriters: [new FileWriter({ outputDir, format: 'turtle' })],
      });
      await secondRun.validate(parseFixture('valid.ttl'), dataset);
      await secondRun.report(dataset);

      const entries = await readdir(outputDir);
      expect(entries).toHaveLength(1);
      const content = await readFile(join(outputDir, entries[0]), 'utf-8');
      expect(content).not.toContain('ValidationResult');
      expect(content).toContain('ValidationReport');
    });
  });
});
