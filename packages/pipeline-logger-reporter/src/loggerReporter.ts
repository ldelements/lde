import type { Level, PipelineEvent, Reporter } from '@lde/pipeline';

/**
 * A logger with the structured-first `(obj, msg)` call shape. Message-first
 * loggers need a small adapter.
 */
export interface Logger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  /**
   * Whether the logger would write a line at `level`, such as Pino’s method of
   * the same name. When present, events below the logger’s level are dropped
   * before their log object is built.
   */
  isLevelEnabled?(level: Level): boolean;
}

/**
 * {@link Reporter} that writes one structured log line per event to your
 * {@link Logger}, such as Pino, at the event’s level and with its `type` as the
 * message.
 * Filtering is left to the logger’s own level: an event is dropped when its
 * level is below the logger’s, asked through `isLevelEnabled` when the logger
 * has it.
 *
 * A dataset is logged as its IRI, a distribution – including an import’s
 * `imported.from` – as its access URL, and an `error` under `err`, the key
 * structured loggers conventionally serialise errors from. A pipeline’s
 * `name` is logged as `pipeline`, because structured loggers reserve `name` for
 * their own. Every other value is passed through as is, leaving its
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
    if (this.logger.isLevelEnabled?.(event.defaultLevel) === false) return;
    this.logger[event.defaultLevel](toLogObject(event), event.type);
  }
}

// `defaultLevel` is already the line’s level.
const omittedKeys = new Set(['defaultLevel']);
const renamedKeys = new Map([
  ['error', 'err'],
  ['name', 'pipeline'],
]);

function toLogObject(event: PipelineEvent): Record<string, unknown> {
  const fields = Object.entries(event)
    .filter(([key]) => !omittedKeys.has(key))
    .map(([key, value]) => [renamedKeys.get(key) ?? key, value]);
  return {
    ...Object.fromEntries(fields),
    ...('dataset' in event && { dataset: event.dataset.iri.toString() }),
    ...('distribution' in event && {
      distribution: event.distribution.accessUrl.toString(),
    }),
    ...('imported' in event &&
      event.imported && {
        imported: {
          ...event.imported,
          from: event.imported.from.accessUrl.toString(),
        },
      }),
  };
}
