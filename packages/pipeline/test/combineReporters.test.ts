import { describe, it, expect, vi } from 'vitest';
import { Dataset } from '@lde/dataset';
import { combineReporters } from '../src/combineReporters.js';
import type { ProgressReporter } from '../src/progressReporter.js';

function makeDataset(iri = 'http://example.org/dataset'): Dataset {
  return new Dataset({ iri: new URL(iri), distributions: [] });
}

/**
 * Every {@link ProgressReporter} method. Kept here so the forward-to-all test
 * exercises each forwarder; a method added to the interface that is missed here
 * leaves its forwarder uncovered, which the coverage threshold flags.
 */
const REPORTER_METHODS = [
  'pipelineStart',
  'datasetsSelected',
  'datasetStart',
  'distributionProbed',
  'importStarted',
  'importFailed',
  'distributionValidated',
  'distributionSelected',
  'stageStart',
  'stageProgress',
  'stageComplete',
  'stageFailed',
  'stageSkipped',
  'datasetValidated',
  'datasetComplete',
  'datasetSkipped',
  'pipelineComplete',
  'timeoutTightened',
  'timeoutRelaxed',
] as const satisfies readonly (keyof ProgressReporter)[];

type FullReporter = ProgressReporter &
  Record<(typeof REPORTER_METHODS)[number], ReturnType<typeof vi.fn>>;

function makeReporter(): FullReporter {
  return Object.fromEntries(
    REPORTER_METHODS.map((method) => [method, vi.fn()]),
  ) as unknown as FullReporter;
}

describe('combineReporters', () => {
  it('forwards every method to each child', () => {
    const first = makeReporter();
    const second = makeReporter();
    const combined = combineReporters([first, second]);

    for (const method of REPORTER_METHODS) {
      (combined[method] as () => void)();
    }

    for (const reporter of [first, second]) {
      for (const method of REPORTER_METHODS) {
        expect(reporter[method]).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('skips children that do not implement the called method', () => {
    const withMethod = { datasetStart: vi.fn() } satisfies ProgressReporter;
    const withoutMethod = { pipelineStart: vi.fn() } satisfies ProgressReporter;
    const dataset = makeDataset();

    // Must not throw even though `withoutMethod` has no `datasetStart`.
    combineReporters([withMethod, withoutMethod]).datasetStart?.(dataset);

    expect(withMethod.datasetStart).toHaveBeenCalledWith(dataset);
    expect(withoutMethod.pipelineStart).not.toHaveBeenCalled();
  });

  it('passes every argument through unchanged', () => {
    const reporter = { datasetsSelected: vi.fn() } satisfies ProgressReporter;

    combineReporters([reporter]).datasetsSelected?.(42, 1234);

    expect(reporter.datasetsSelected).toHaveBeenCalledWith(42, 1234);
  });

  it('dispatches to children in array order', () => {
    const order: number[] = [];
    const first = {
      pipelineStart: vi.fn(() => order.push(1)),
    } satisfies ProgressReporter;
    const second = {
      pipelineStart: vi.fn(() => order.push(2)),
    } satisfies ProgressReporter;

    combineReporters([first, second]).pipelineStart?.('run');

    expect(order).toEqual([1, 2]);
  });

  it('is a no-op for an empty array of reporters', () => {
    expect(() => combineReporters([]).pipelineStart?.('run')).not.toThrow();
  });
});
