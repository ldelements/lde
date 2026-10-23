import type { PipelineEvent } from './pipelineEvent.js';

/**
 * Observer of a pipeline run. The pipeline hands every {@link PipelineEvent}
 * to {@link onEvent}, synchronously and in order; a reporter that throws
 * propagates into the run. Each reporter filters by level itself.
 */
export interface Reporter {
  onEvent(event: PipelineEvent): void;
}
