import type { Dataset, Distribution } from '@lde/dataset';
import type { ValidityVerdict } from '@lde/distribution-health';
import type { ValidationReport } from './validator.js';
import type { ImportDetails } from './distribution/resolver.js';
import type { TimeoutTransitionEvent } from './sparql/timeoutPolicy.js';

/**
 * Deliberately without `fatal`: the pipeline never ends the process; an
 * unrecoverable failure rejects {@link Pipeline.run}.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Fields every {@link PipelineEvent} carries. Owning the `type` discriminator
 * here means no event can join the union without one. `defaultLevel` is the
 * pipeline’s default; reporters may remap it.
 */
export interface EventEnvelope<Type extends string> {
  type: Type;
  defaultLevel: Level;
  timestamp: Date;
  runId: string;
}

/** The envelope of every event that belongs to a single dataset. */
export interface DatasetEventEnvelope<
  Type extends string,
> extends EventEnvelope<Type> {
  dataset: Dataset;
}

export interface Reason<Code extends string> {
  code: Code;
  message: string;
}

export type DatasetSkipReason = Reason<
  'unchanged' | 'probeFailed' | 'resolveFailed' | 'noDistributionAvailable'
>;

export type StageSkipReason = Reason<'notSupported'>;

export interface DistributionAnalysisResult {
  distribution: Distribution;
  type: 'sparql' | 'data-dump' | 'network-error';
  available: boolean;
  statusCode?: number;
  error?: string;
  warnings: string[];
  /**
   * The source-change fingerprint observed for this distribution, or `null`
   * when none could be established (e.g. a live SPARQL endpoint). The shared
   * key against which a validity verdict's `validatedFingerprint` is matched,
   * so a consumer can record it on the reachability rail. Always populated by
   * the pipeline; optional so consumers constructing the result need not set it.
   */
  fingerprint?: string | null;
}

export interface MemoryUsage {
  memoryUsageBytes: number;
  heapUsedBytes: number;
}

export interface PipelineStartEvent extends EventEnvelope<'pipelineStart'> {
  name: string;
}

export interface DatasetsSelectedEvent extends EventEnvelope<'datasetsSelected'> {
  count: number;
  durationMs: number;
}

/**
 * The run was abandoned because the selection was empty: the writers were told
 * to abort, so the destination is unchanged.
 */
export interface SelectionEmptyEvent extends EventEnvelope<'selectionEmpty'> {
  message: string;
}

export interface PipelineCompleteEvent
  extends EventEnvelope<'pipelineComplete'>, MemoryUsage {
  durationMs: number;
}

export type DatasetStartEvent = DatasetEventEnvelope<'datasetStart'>;

export interface DistributionProbedEvent extends DatasetEventEnvelope<'distributionProbed'> {
  result: DistributionAnalysisResult;
}

/** Reported for every distribution the pipeline attempted, even when the dataset is otherwise skipped. */
export interface DistributionValidatedEvent extends DatasetEventEnvelope<'distributionValidated'> {
  distribution: Distribution;
  verdict: ValidityVerdict;
}

export type ImportStartedEvent = DatasetEventEnvelope<'importStarted'>;

export interface ImportFailedEvent extends DatasetEventEnvelope<'importFailed'> {
  distribution: Distribution;
  error: Error;
}

/** `imported` is set when `distribution` serves an imported data dump. */
export interface DistributionSelectedEvent extends DatasetEventEnvelope<'distributionSelected'> {
  distribution: Distribution;
  imported?: ImportDetails;
}

export interface StageStartEvent extends DatasetEventEnvelope<'stageStart'> {
  stage: string;
}

export interface StageProgressEvent
  extends DatasetEventEnvelope<'stageProgress'>, MemoryUsage {
  stage: string;
  itemsProcessed: number;
  quadsGenerated: number;
}

export interface StageCompleteEvent extends DatasetEventEnvelope<'stageComplete'> {
  stage: string;
  itemsProcessed: number;
  quadsGenerated: number;
  durationMs: number;
}

/**
 * Also reported for per-dataset failures outside any stage, with `stage` set
 * to `write`, `provenance` or `reactive-dump-fallback`.
 */
export interface StageFailedEvent extends DatasetEventEnvelope<'stageFailed'> {
  stage: string;
  error: Error;
}

export interface StageSkippedEvent extends DatasetEventEnvelope<'stageSkipped'> {
  stage: string;
  reason: StageSkipReason;
}

/**
 * Reported once per (dataset, validator) pair, even when nothing was validated:
 * read `quadsValidated` to tell ‘not tested’ from ‘tested and passed’.
 */
export interface DatasetValidatedEvent extends DatasetEventEnvelope<'datasetValidated'> {
  report: ValidationReport;
}

export interface DatasetCompleteEvent
  extends DatasetEventEnvelope<'datasetComplete'>, MemoryUsage {
  durationMs: number;
}

export interface DatasetSkippedEvent extends DatasetEventEnvelope<'datasetSkipped'> {
  reason: DatasetSkipReason;
}

export interface TimeoutTightenedEvent
  extends DatasetEventEnvelope<'timeoutTightened'>, TimeoutTransitionEvent {}

export interface TimeoutRelaxedEvent
  extends DatasetEventEnvelope<'timeoutRelaxed'>, TimeoutTransitionEvent {}

/** Everything a pipeline run reports, discriminated on `type`. */
export type PipelineEvent =
  | PipelineStartEvent
  | DatasetsSelectedEvent
  | SelectionEmptyEvent
  | PipelineCompleteEvent
  | DatasetStartEvent
  | DistributionProbedEvent
  | DistributionValidatedEvent
  | ImportStartedEvent
  | ImportFailedEvent
  | DistributionSelectedEvent
  | StageStartEvent
  | StageProgressEvent
  | StageCompleteEvent
  | StageFailedEvent
  | StageSkippedEvent
  | DatasetValidatedEvent
  | DatasetCompleteEvent
  | DatasetSkippedEvent
  | TimeoutTightenedEvent
  | TimeoutRelaxedEvent;

/** A {@link PipelineEvent} without the envelope fields the pipeline fills in. */
export type PipelineEventPayload = PipelineEvent extends infer Event
  ? Event extends PipelineEvent
    ? Omit<Event, 'defaultLevel' | 'timestamp' | 'runId'>
    : never
  : never;

/** The pipeline’s default {@link Level} for an event. */
export function levelOf(event: PipelineEventPayload): Level {
  switch (event.type) {
    case 'stageProgress':
    case 'distributionProbed':
    case 'importStarted':
    case 'stageStart':
      return 'debug';
    case 'pipelineStart':
    case 'pipelineComplete':
    case 'datasetsSelected':
    case 'datasetStart':
    case 'datasetComplete':
    case 'distributionSelected':
    case 'stageComplete':
    case 'timeoutRelaxed':
      return 'info';
    case 'datasetSkipped':
      return event.reason.code === 'unchanged' ? 'info' : 'warn';
    case 'distributionValidated':
      return event.verdict.valid ? 'info' : 'warn';
    case 'datasetValidated':
      return event.report.conforms ? 'info' : 'warn';
    case 'selectionEmpty':
    case 'importFailed':
    case 'stageSkipped':
    case 'timeoutTightened':
      return 'warn';
    case 'stageFailed':
      return 'error';
  }
}
