import type { PipelineEvent, Reporter } from '@lde/pipeline';

/**
 * A logger with the structured-first `(obj, msg)` call shape. Message-first
 * loggers need a small adapter.
 */
export interface Logger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * {@link Reporter} that writes one structured log line per event to your
 * {@link Logger}, such as Pino, at the event’s level and with its `type` as the
 * message.
 * Filtering is left to the logger’s own level.
 *
 * A dataset is logged as its IRI, a distribution as its access URL, and an
 * `error` under `err`, the key structured loggers conventionally serialise
 * errors from. Every other value is passed through as is, leaving its
 * serialisation, cycles included, to the logger.
 *
 * @example
 * ```ts
 * new Pipeline({ …, reporter: new LoggerReporter(logger) });
 * ```
 */
export class LoggerReporter implements Reporter {
  constructor(private readonly logger: Logger) {}

  onEvent(event: PipelineEvent): void {
    this.logger[event.defaultLevel](toLogObject(event), event.type);
  }
}

// Left out: `defaultLevel` is already the line’s level, and structured loggers
// reserve `name` for their own name.
const omittedKeys = new Set(['defaultLevel', 'name']);

function toLogObject(event: PipelineEvent): Record<string, unknown> {
  const fields = Object.entries(event)
    .filter(([key]) => !omittedKeys.has(key))
    .map(([key, value]) => [key === 'error' ? 'err' : key, value]);
  return {
    ...Object.fromEntries(fields),
    ...('dataset' in event && { dataset: event.dataset.iri.toString() }),
    ...('distribution' in event && {
      distribution: event.distribution.accessUrl.toString(),
    }),
  };
}
