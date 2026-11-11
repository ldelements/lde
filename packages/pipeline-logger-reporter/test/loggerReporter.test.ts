import { describe, it, expect, vi, type Mock } from 'vitest';
import { Dataset, Distribution } from '@lde/dataset';
import {
  levelOf,
  type Level,
  type DistributionAnalysisResult,
  type PipelineEvent,
  type PipelineEventPayload,
} from '@lde/pipeline';
import { LoggerReporter } from '../src/loggerReporter.js';

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

function makeLogger(): Record<Level, Mock<LogMethod>> {
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

  it('leaves out the level and logs the pipeline name as pipeline', () => {
    const logger = makeLogger();

    new LoggerReporter(logger).onEvent(
      envelope({ type: 'pipelineStart', name: 'run' }),
    );

    const [logObject] = logger.info.mock.calls[0];
    expect(logObject).not.toHaveProperty('name');
    expect(logObject).toHaveProperty('pipeline', 'run');
    expect(logObject).not.toHaveProperty('defaultLevel');
  });

  it('skips events below the logger’s level', () => {
    const logger = {
      ...makeLogger(),
      isLevelEnabled: (level: string) => level !== 'debug',
    };

    const reporter = new LoggerReporter(logger);
    reporter.onEvent(envelope({ type: 'stageStart', dataset, stage: 's' }));
    reporter.onEvent(envelope({ type: 'pipelineStart', name: 'run' }));

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('logs the data dump an import came from by its URL', () => {
    const logger = makeLogger();
    const dump = Distribution.sparql(new URL('http://example.org/dump.nt'));

    new LoggerReporter(logger).onEvent(
      envelope({
        type: 'distributionSelected',
        dataset,
        distribution,
        imported: { from: dump, durationMs: 5 },
      }),
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        imported: { from: 'http://example.org/dump.nt', durationMs: 5 },
      }),
      'distributionSelected',
    );
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

  it('logs a distribution from another @lde/dataset copy by its URL', () => {
    const logger = makeLogger();
    const foreignDistribution = {
      accessUrl: new URL('http://example.org/sparql'),
    } as Distribution;

    new LoggerReporter(logger).onEvent(
      envelope({
        type: 'distributionSelected',
        dataset,
        distribution: foreignDistribution,
      }),
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ distribution: 'http://example.org/sparql' }),
      'distributionSelected',
    );
  });

  it('leaves serialising other values to the logger', () => {
    const logger = makeLogger();
    const result: DistributionAnalysisResult = {
      type: 'sparql',
      available: true,
      warnings: ['slow'],
    };

    new LoggerReporter(logger).onEvent(
      envelope({ type: 'distributionProbed', dataset, distribution, result }),
    );

    const [logObject] = logger.debug.mock.calls[0];
    expect(logObject).toHaveProperty('result');
    expect((logObject as { result: unknown }).result).toBe(result);
  });
});
