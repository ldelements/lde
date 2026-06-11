import { describe, it, expect } from 'vitest';
import type { ProcessingRecord } from '../../src/provenance/record.js';
import { shouldReprocess } from '../../src/provenance/reprocessDecision.js';

function record(overrides: Partial<ProcessingRecord> = {}): ProcessingRecord {
  return {
    sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
    pipelineVersion: 'v1',
    generatedAt: '2024-06-02T00:00:00.000Z',
    status: 'success',
    ...overrides,
  };
}

describe('shouldReprocess', () => {
  it('reprocesses when there is no stored record', () => {
    expect(
      shouldReprocess(
        {
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
        },
        null,
      ),
    ).toBe(true);
  });

  it('skips when both change fields equal the stored record', () => {
    expect(
      shouldReprocess(
        {
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
        },
        record({
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
        }),
      ),
    ).toBe(false);
  });

  it('reprocesses when the source signal changed', () => {
    expect(
      shouldReprocess(
        {
          sourceFingerprint: '2024-07-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
        },
        record({
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
        }),
      ),
    ).toBe(true);
  });

  it('reprocesses when the pipeline version changed', () => {
    expect(
      shouldReprocess(
        {
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v2',
        },
        record({
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
        }),
      ),
    ).toBe(true);
  });

  it('reprocesses when the current source signal is null, even against a stored null', () => {
    expect(
      shouldReprocess(
        { sourceFingerprint: null, pipelineVersion: 'v1' },
        record({ sourceFingerprint: null, pipelineVersion: 'v1' }),
      ),
    ).toBe(true);
  });

  it('ignores status: a failed-but-unchanged dataset is skipped', () => {
    // Failure handling is by equality, not a status gate – an unchanged failed
    // dataset is skipped until its source changes or the version rotates.
    expect(
      shouldReprocess(
        {
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
        },
        record({
          sourceFingerprint: '2024-06-01T00:00:00.000Z|1000',
          pipelineVersion: 'v1',
          status: 'failed',
        }),
      ),
    ).toBe(false);
  });
});
