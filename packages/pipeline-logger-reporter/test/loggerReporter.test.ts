import { describe, it, expect, vi, type Mock } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import {
  levelOf,
  type PipelineEvent,
  type PipelineEventPayload,
} from '@lde/pipeline';
import { LoggerReporter, type Logger } from '../src/loggerReporter.js';

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset'),
  distributions: [],
});
const distribution = Distribution.sparql(new URL('http://example.org/sparql'));

function envelope<Payload extends PipelineEventPayload>(
  payload: Payload,
): PipelineEvent {
  return {
    ...payload,
    defaultLevel: levelOf(payload),
    timestamp: new Date('2026-10-23T00:00:00.000Z'),
    runId: 'run-1',
  } as PipelineEvent;
}

type LogMethod = (obj: object, msg: string) => void;

function makeLogger(): Record<keyof Logger, Mock<LogMethod>> {
  return {
    debug: vi.fn<LogMethod>(),
    info: vi.fn<LogMethod>(),
    warn: vi.fn<LogMethod>(),
    error: vi.fn<LogMethod>(),
  };
}

describe('LoggerReporter', () => {
  it('logs each event at its level with its type as the message', () => {
    const logger = makeLogger();
    const reporter = new LoggerReporter(logger);

    reporter.onEvent(envelope({ type: 'stageStart', dataset, stage: 's' }));
    reporter.onEvent(envelope({ type: 'pipelineStart', name: 'run' }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stageStart', stage: 's' }),
      'stageStart',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pipelineStart' }),
      'pipelineStart',
    );
  });

  it('leaves out the level and the logger’s reserved name', () => {
    const logger = makeLogger();

    new LoggerReporter(logger).onEvent(
      envelope({ type: 'pipelineStart', name: 'run' }),
    );

    const [logObject] = logger.info.mock.calls[0];
    expect(logObject).not.toHaveProperty('name');
    expect(logObject).not.toHaveProperty('defaultLevel');
  });

  it('logs datasets and distributions by IRI and URL, and errors under err', () => {
    const logger = makeLogger();
    const error = new Error('Parse error');

    new LoggerReporter(logger).onEvent(
      envelope({ type: 'importFailed', dataset, distribution, error }),
    );

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'importFailed',
        timestamp: new Date('2026-10-23T00:00:00.000Z'),
        runId: 'run-1',
        dataset: 'http://example.org/dataset',
        distribution: 'http://example.org/sparql',
        err: error,
      },
      'importFailed',
    );
  });

  it('makes nested values log-friendly', () => {
    const logger = makeLogger();

    new LoggerReporter(logger).onEvent(
      envelope({
        type: 'distributionProbed',
        dataset,
        result: {
          distribution,
          type: 'sparql',
          available: true,
          warnings: ['slow'],
        },
      }),
    );

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          distribution: 'http://example.org/sparql',
          type: 'sparql',
          available: true,
          warnings: ['slow'],
        },
      }),
      'distributionProbed',
    );
  });

  it('logs URLs as strings', () => {
    const logger = makeLogger();

    new LoggerReporter(logger).onEvent(
      envelope({
        type: 'timeoutTightened',
        dataset,
        endpoint: new URL('http://example.org/sparql'),
        fromTimeoutMs: 300_000,
        toTimeoutMs: 10_000,
        consecutiveTimeouts: 2,
      }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'http://example.org/sparql' }),
      'timeoutTightened',
    );
  });
});
