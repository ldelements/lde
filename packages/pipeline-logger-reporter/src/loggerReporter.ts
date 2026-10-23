import { Dataset, Distribution } from '@lde/dataset';
import type { PipelineEvent, Reporter } from '@lde/pipeline';

/**
 * A logger with the structured-first `(obj, msg)` call shape of Pino and
 * Bunyan. Message-first loggers such as Winston need a small adapter.
 */
export interface Logger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * {@link Reporter} that writes one structured log line per event to your
 * {@link Logger}, at the event’s level and with its `type` as the message.
 * Filtering is left to the logger’s own level.
 *
 * A dataset is logged as its IRI, a distribution as its access URL, and an
 * `error` under `err`, the key Pino and Bunyan serialise errors from.
 *
 * @example
 * ```ts
 * new Pipeline({ …, reporter: new LoggerReporter(pino()) });
 * ```
 */
export class LoggerReporter implements Reporter {
  constructor(private readonly logger: Logger) {}

  onEvent(event: PipelineEvent): void {
    this.logger[event.level](toLogObject(event), event.type);
  }
}

function toLogObject(event: PipelineEvent): Record<string, unknown> {
  // The logger records the level itself; a second `level` key would clash.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { level, ...fields } = event;
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key === 'error' ? 'err' : key,
      loggable(value),
    ]),
  );
}

function loggable(value: unknown): unknown {
  if (value instanceof Dataset) return value.iri.toString();
  if (value instanceof Distribution) return value.accessUrl.toString();
  if (value instanceof URL) return value.toString();
  if (value instanceof Error || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(loggable);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, loggable(nested)]),
    );
  }
  return value;
}
