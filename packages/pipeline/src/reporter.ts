import type { PipelineEvent } from './pipelineEvent.js';

/**
 * Observer of a pipeline run. The pipeline hands every {@link PipelineEvent}
 * to {@link onEvent}, synchronously and in order. Each reporter filters by
 * level itself.
 *
 * A reporter cannot break a run: when {@link onEvent} throws, the pipeline
 * still hands the event to the other reporters, carries on, and surfaces the
 * error as a `ReporterWarning` through `process.emitWarning`.
 */
export interface Reporter {
  onEvent(event: PipelineEvent): void;
}
