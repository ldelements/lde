import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConsoleReporter } from '../src/consoleReporter.js';
import { Dataset, Distribution } from '@lde/dataset';
import {
  levelOf,
  type DistributionAnalysisResult,
  type PipelineEvent,
  type PipelineEventPayload,
} from '@lde/pipeline';

const dataset = makeDataset();

function event(payload: PipelineEventPayload): PipelineEvent {
  return {
    ...payload,
    defaultLevel: levelOf(payload),
    timestamp: new Date(),
    runId: 'run-1',
  } as PipelineEvent;
}

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

  describe('selectionEmpty', () => {
    it('warns that the run was abandoned, with the reason', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(event({ type: 'pipelineStart', name: 'test' }));
      reporter.onEvent(
        event({
          type: 'selectionEmpty',
          message: 'Selection produced no datasets',
        }),
      );

      const output = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('Selection produced no datasets');
    });

    it('still prints when no spinner is running', () => {
      // The warning matters most where no spinner was started at all; dropping
      // it there would silence exactly the unattended run it exists for.
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'selectionEmpty',
          message: 'Selection produced no datasets',
        }),
      );

      const output = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('Selection produced no datasets');
    });
  });

  describe('itemsRejected', () => {
    it('prints how many items went in, how many were left out, and why', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'itemsRejected',
          dataset,
          rejection: {
            target: 'CreativeWork',
            written: 753,
            rejected: 107,
            reasons: [
              {
                reason: 'missing required field “sdDatePublished”',
                count: 107,
                examples: ['https://example.org/note/1'],
              },
            ],
          },
        }),
      );

      const output = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('646 of 753 items written');
      expect(output).toContain('107 rejected');
      expect(output).toContain(
        '107 × missing required field “sdDatePublished”',
      );
      expect(output).toContain('https://example.org/note/1');
    });
  });

  describe('datasetValidated', () => {
    it('shows success when validation conforms', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'datasetValidated',
          dataset,
          report: { conforms: true, violations: 0, quadsValidated: 5000 },
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Validated');
      expect(output).toContain('5K');
    });

    it('shows failure with violation count when validation does not conform', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'datasetValidated',
          dataset,
          report: { conforms: false, violations: 3, quadsValidated: 10000 },
        }),
      );

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

      reporter.onEvent(
        event({ type: 'stageStart', dataset, stage: 'transform' }),
      );
      reporter.onEvent(
        event({
          type: 'stageComplete',
          dataset,
          stage: 'transform',
          itemsProcessed: 30_000,
          quadsGenerated: 327_500,
          durationMs: 506_000,
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('30K items');
      expect(output).toContain('327.5K quads');
    });

    it('omits counts when no items were processed', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({ type: 'stageStart', dataset, stage: 'transform' }),
      );
      reporter.onEvent(
        event({
          type: 'stageComplete',
          dataset,
          stage: 'transform',
          itemsProcessed: 0,
          quadsGenerated: 0,
          durationMs: 1000,
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).not.toContain('items');
      expect(output).toContain('took');
    });
  });

  describe('stageSkipped', () => {
    it('fails the running stage spinner with the reason', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({ type: 'stageStart', dataset, stage: 'transform' }),
      );
      reporter.onEvent(
        event({
          type: 'stageSkipped',
          dataset,
          stage: 'transform',
          reason: { code: 'notSupported', message: 'No SPARQL endpoint' },
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('transform');
      expect(output).toContain('skipped');
      expect(output).toContain('No SPARQL endpoint');
    });
  });

  describe('stageProgress', () => {
    it('shows counts and memory on the running stage spinner', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({ type: 'stageStart', dataset, stage: 'transform' }),
      );
      reporter.onEvent(
        event({
          type: 'stageProgress',
          dataset,
          stage: 'transform',
          itemsProcessed: 1_500,
          quadsGenerated: 12_000,
          memoryUsageBytes: 200 * 1024 * 1024,
          heapUsedBytes: 100 * 1024 * 1024,
        }),
      );
      reporter.onEvent(
        event({
          type: 'stageComplete',
          dataset,
          stage: 'transform',
          itemsProcessed: 1_500,
          quadsGenerated: 12_000,
          durationMs: 1000,
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('1.5K items');
      expect(output).toContain('12K quads');
    });
  });

  describe('stageFailed', () => {
    it('fails the running stage spinner with the error', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({ type: 'stageStart', dataset, stage: 'transform' }),
      );
      reporter.onEvent(
        event({
          type: 'stageFailed',
          dataset,
          stage: 'transform',
          error: new Error('HTTP status 502'),
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Stage');
      expect(output).toContain('HTTP status 502');
    });

    it('still prints when no spinner is running', () => {
      // The pipeline reports writer, provenance and fallback failures outside
      // any stage; dropping those would hide exactly the errors that leave a
      // dataset recorded as failed.
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'stageFailed',
          dataset,
          stage: 'reactive-dump-fallback',
          error: new Error('delete-by-filter timed out'),
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('reactive-dump-fallback');
      expect(output).toContain('delete-by-filter timed out');
    });
  });

  describe('concurrent spinners', () => {
    it('stageStart after importStarted does not crash and produces output for both', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(event({ type: 'importStarted', dataset }));
      reporter.onEvent(
        event({ type: 'stageStart', dataset, stage: 'transform' }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Stage');
    });
  });

  describe('datasetStart', () => {
    it('prints a header with a counter when several datasets were selected', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(event({ type: 'pipelineStart', name: 'testPipeline' }));
      reporter.onEvent(
        event({ type: 'datasetsSelected', count: 2, durationMs: 100 }),
      );
      reporter.onEvent(event({ type: 'datasetStart', dataset }));
      reporter.onEvent(event({ type: 'datasetStart', dataset }));

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('http://example.org/dataset');
      expect(output).toContain('[1/2]');
      expect(output).toContain('[2/2]');
    });

    it('omits the counter for a single dataset', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({ type: 'datasetsSelected', count: 1, durationMs: 100 }),
      );
      reporter.onEvent(event({ type: 'datasetStart', dataset }));

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('http://example.org/dataset');
      expect(output).not.toContain('[1/1]');
    });
  });

  describe('datasetComplete', () => {
    it('includes heap usage', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(event({ type: 'datasetStart', dataset }));
      reporter.onEvent(
        event({
          type: 'datasetComplete',
          dataset,
          durationMs: 3_000,
          memoryUsageBytes: 150 * 1024 * 1024,
          heapUsedBytes: 100 * 1024 * 1024,
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('150 MB RSS');
      expect(output).toContain('100 MB heap');
    });
  });

  describe('pipelineComplete', () => {
    it('includes heap usage', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'pipelineComplete',
          durationMs: 60_000,
          memoryUsageBytes: 200 * 1024 * 1024,
          heapUsedBytes: 130 * 1024 * 1024,
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('200 MB RSS');
      expect(output).toContain('130 MB heap');
    });
  });

  describe('distributionSelected', () => {
    it('includes triple count when present', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'distributionSelected',
          dataset,
          distribution: Distribution.sparql(
            new URL('http://localhost:7001/sparql'),
          ),
          imported: {
            from: new Distribution(
              new URL('http://example.org/data.nt'),
              'application/n-triples',
            ),
            duration: 5000,
            tripleCount: 4800000,
          },
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('4.8M triples');
      expect(output).toContain('to http://localhost:7001/sparql');
    });

    it('names the engine that built the import when present', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'distributionSelected',
          dataset,
          distribution: Distribution.sparql(
            new URL('http://localhost:7001/sparql'),
          ),
          imported: {
            from: new Distribution(
              new URL('http://example.org/data.nt'),
              'application/n-triples',
            ),
            duration: 5000,
            engine: { name: 'QLever', version: '9352d0' },
          },
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain(
        'Imported http://example.org/data.nt into QLever 9352d0 (to http://localhost:7001/sparql)',
      );
    });

    it('prints "(selected)" without cursor escapes on non-TTY', () => {
      // Tests run in non-TTY mode, so this exercises the non-TTY path.
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(event({ type: 'datasetStart', dataset }));

      const sparqlUrl = 'http://sparql.example.com/';
      reporter.onEvent(
        event({
          type: 'distributionProbed',
          dataset,
          result: makeProbeResult(sparqlUrl),
        }),
      );
      reporter.onEvent(
        event({
          type: 'distributionSelected',
          dataset,
          distribution: Distribution.sparql(new URL(sparqlUrl)),
        }),
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

      reporter.onEvent(
        event({
          type: 'distributionSelected',
          dataset,
          distribution: Distribution.sparql(
            new URL('http://localhost:7001/sparql'),
          ),
          imported: {
            from: new Distribution(
              new URL('http://example.org/data.nt'),
              'application/n-triples',
            ),
            duration: 5000,
          },
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).not.toContain('triples');
      expect(output).toContain('to http://localhost:7001/sparql');
    });
  });

  describe('timeout transitions', () => {
    it('prints a tightened-timeout line', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'timeoutTightened',
          dataset,
          endpoint: new URL('https://data.razu.nl/sparql'),
          fromTimeoutMs: 300_000,
          toTimeoutMs: 10_000,
          consecutiveTimeouts: 2,
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Tightened');
      expect(output).toContain('https://data.razu.nl/sparql');
      expect(output).toContain('10s');
      expect(output).toContain('2');
    });

    it('prints a relaxed-timeout line', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'timeoutRelaxed',
          dataset,
          endpoint: new URL('https://data.razu.nl/sparql'),
          fromTimeoutMs: 10_000,
          toTimeoutMs: 300_000,
          consecutiveTimeouts: 0,
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Relaxed');
      expect(output).toContain('https://data.razu.nl/sparql');
    });
  });

  describe('datasetSkipped', () => {
    it.each([
      ['unchanged', 'Unchanged since last run'],
      ['noDistributionAvailable', 'No SPARQL endpoint'],
    ] as const)('prints the %s reason', (code, message) => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({ type: 'datasetSkipped', dataset, reason: { code, message } }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain(message);
    });
  });

  describe('importFailed', () => {
    it('prints the error message', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.onEvent(
        event({
          type: 'importFailed',
          dataset,
          distribution: Distribution.sparql(new URL('http://example.org/s')),
          error: new Error('Parse error'),
        }),
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Import failed: Parse error');
    });
  });
});
