import { describe, it, expect } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import { levelOf, type PipelineEventPayload } from '../src/pipelineEvent.js';

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});
const distribution = Distribution.sparql(new URL('http://example.org/sparql'));

describe('levelOf', () => {
  it.each<[PipelineEventPayload, string]>([
    [{ type: 'stageStart', dataset, stage: 'stage1' }, 'debug'],
    [{ type: 'importStarted', dataset }, 'debug'],
    [{ type: 'pipelineStart', name: 'run' }, 'info'],
    [
      {
        type: 'datasetSkipped',
        dataset,
        reason: { code: 'unchanged', message: 'Unchanged since last run' },
      },
      'info',
    ],
    [
      {
        type: 'datasetSkipped',
        dataset,
        reason: { code: 'noDistributionAvailable', message: 'None' },
      },
      'warn',
    ],
    [
      {
        type: 'distributionValidated',
        dataset,
        distribution,
        verdict: { valid: true, validatedFingerprint: null, depth: 'deep' },
      },
      'info',
    ],
    [
      {
        type: 'distributionValidated',
        dataset,
        distribution,
        verdict: { valid: false, validatedFingerprint: null, depth: 'deep' },
      },
      'warn',
    ],
    [
      {
        type: 'datasetValidated',
        dataset,
        report: { conforms: true, violations: 0, quadsValidated: 1 },
      },
      'info',
    ],
    [
      {
        type: 'datasetValidated',
        dataset,
        report: { conforms: false, violations: 2, quadsValidated: 1 },
      },
      'warn',
    ],
    [{ type: 'selectionEmpty', message: 'Nothing selected' }, 'warn'],
    [
      { type: 'stageFailed', dataset, stage: 'stage1', error: new Error() },
      'error',
    ],
  ])('levels %o as %s', (payload, level) => {
    expect(levelOf(payload)).toBe(level);
  });
});
