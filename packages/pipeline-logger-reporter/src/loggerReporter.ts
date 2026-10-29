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
 * errors from. `pipelineStart`’s `name` is left out, as it would clash with the
 * logger’s own `name`.
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
    .filter(([key]) => !omittedKeys.has(key) && key !== 'dataset')
    .map(([key, value]) => [key === 'error' ? 'err' : key, loggable(value)]);
  return {
    ...('dataset' in event && { dataset: event.dataset.iri.toString() }),
    ...Object.fromEntries(fields),
  };
}

function loggable(value: unknown): unknown {
  if (value instanceof URL) return value.toString();
  if (value instanceof Error || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(loggable);
  if (hasAccessUrl(value)) return value.accessUrl.toString();

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, loggable(nested)]),
    );
  }
  return value;
}

const hasAccessUrl = (value: unknown): value is { accessUrl: URL } => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'accessUrl' in value &&
    value.accessUrl instanceof URL
  );
};
