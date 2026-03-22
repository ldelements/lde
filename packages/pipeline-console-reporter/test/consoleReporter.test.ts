import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConsoleReporter } from '../src/consoleReporter.js';
import { Dataset, Distribution } from '@lde/dataset';
import type { DistributionAnalysisResult } from '@lde/pipeline';

function makeDataset(): Dataset {
  return new Dataset({
    iri: new URL('http://example.org/dataset'),
    distributions: [],
  });
}

function makeProbeResult(
  url: string,
  overrides: Partial<DistributionAnalysisResult> = {},
): DistributionAnalysisResult {
  return {
    distribution: Distribution.sparql(new URL(url)),
    type: 'sparql',
    available: true,
    statusCode: 200,
    warnings: [],
    ...overrides,
  };
}

describe('ConsoleReporter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('can be instantiated', () => {
    const reporter = new ConsoleReporter();
    expect(reporter).toBeInstanceOf(ConsoleReporter);
  });

  describe('stageValidated', () => {
    it('shows success when validation conforms', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.stageValidated('transform', {
        conforms: true,
        violations: 0,
        quadsValidated: 5000,
      });

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Validated');
      expect(output).toContain('5K');
    });

    it('shows failure with violation count when validation does not conform', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.stageValidated('transform', {
        conforms: false,
        violations: 3,
        quadsValidated: 10000,
      });

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Validated');
      expect(output).toContain('10K');
      expect(output).toContain('violation');
    });
  });

  describe('stageComplete', () => {
    it('includes item and quad counts when items were processed', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.stageStart('transform');
      reporter.stageComplete('transform', {
        itemsProcessed: 30_000,
        quadsGenerated: 327_500,
        duration: 506_000,
      });

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('30K items');
      expect(output).toContain('327.5K quads');
    });

    it('omits counts when no items were processed', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.stageStart('transform');
      reporter.stageComplete('transform', {
        itemsProcessed: 0,
        quadsGenerated: 0,
        duration: 1000,
      });

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).not.toContain('items');
      expect(output).toContain('took');
    });
  });

  describe('concurrent spinners', () => {
    it('stageStart after importStarted does not crash and produces output for both', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.importStarted();
      reporter.stageStart('transform');

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Stage');
    });
  });

  describe('datasetComplete', () => {
    it('includes heap usage', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.datasetStart(makeDataset());
      reporter.datasetComplete(makeDataset(), {
        memoryUsageBytes: 150 * 1024 * 1024,
        heapUsedBytes: 100 * 1024 * 1024,
      });

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('150 MB RSS');
      expect(output).toContain('100 MB heap');
    });
  });

  describe('pipelineComplete', () => {
    it('includes heap usage', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.pipelineComplete({
        duration: 60_000,
        memoryUsageBytes: 200 * 1024 * 1024,
        heapUsedBytes: 130 * 1024 * 1024,
      });

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('200 MB RSS');
      expect(output).toContain('130 MB heap');
    });
  });

  describe('distributionSelected', () => {
    it('includes triple count when present', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.distributionSelected(
        makeDataset(),
        Distribution.sparql(new URL('http://localhost:7001/sparql')),
        new Distribution(
          new URL('http://example.org/data.nt'),
          'application/n-triples',
        ),
        5000,
        4800000,
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('4.8M triples');
      expect(output).toContain('to http://localhost:7001/sparql');
    });

    it('prints "(selected)" without cursor escapes on non-TTY', () => {
      // Tests run in non-TTY mode, so this exercises the non-TTY path.
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.datasetStart(makeDataset());

      const sparqlUrl = 'http://sparql.example.com/';
      reporter.distributionProbed(makeProbeResult(sparqlUrl));
      reporter.distributionSelected(
        makeDataset(),
        Distribution.sparql(new URL(sparqlUrl)),
      );

      const output = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('SPARQL endpoint');
      expect(output).toContain('(selected)');
      // No cursor-movement escapes in non-TTY mode.
      expect(output).not.toContain('\x1B[1A');
    });

    it('omits triple count when absent', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.distributionSelected(
        makeDataset(),
        Distribution.sparql(new URL('http://localhost:7001/sparql')),
        new Distribution(
          new URL('http://example.org/data.nt'),
          'application/n-triples',
        ),
        5000,
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).not.toContain('triples');
      expect(output).toContain('to http://localhost:7001/sparql');
    });
  });
});
