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
 * here means no event can join the union without one. `level` is the
 * pipeline’s default; reporters may remap it.
 */
export interface EventEnvelope<Type extends string> {
  type: Type;
  level: Level;
  timestamp: Date;
  runId: string;
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

/**
 * Items a writer left out of a dataset’s output instead of failing the
 * dataset – documents a destination refused, say – reported once per
 * (dataset, target) as the writer finalizes the dataset.
 */
export interface ItemsRejected {
  /** The part of the destination that refused them, e.g. a search index’s
   *  type name. */
  readonly target: string;
  /** Items the dataset wrote to {@link target}, the rejected ones included. */
  readonly written: number;
  /** Items left out. */
  readonly rejected: number;
  /** Why, most frequent first: each distinct reason, how many items it
   *  rejected, and the ids of a few of them. Bounded by the writer, so a
   *  reason that varies per item cannot grow it without limit. */
  readonly reasons: readonly RejectionReason[];
}

/** One reason a writer rejected items, in {@link ItemsRejected.reasons}. */
export interface RejectionReason {
  readonly reason: string;
  readonly count: number;
  /** Ids of some of the items rejected for this reason. */
  readonly examples: readonly string[];
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

export interface DatasetStartEvent extends EventEnvelope<'datasetStart'> {
  dataset: Dataset;
}

export interface DistributionProbedEvent extends EventEnvelope<'distributionProbed'> {
  dataset: Dataset;
  result: DistributionAnalysisResult;
}

/** Reported for every distribution the pipeline attempted, even when the dataset is otherwise skipped. */
export interface DistributionValidatedEvent extends EventEnvelope<'distributionValidated'> {
  dataset: Dataset;
  distribution: Distribution;
  verdict: ValidityVerdict;
}

export interface ImportStartedEvent extends EventEnvelope<'importStarted'> {
  dataset: Dataset;
}

export interface ImportFailedEvent extends EventEnvelope<'importFailed'> {
  dataset: Dataset;
  distribution: Distribution;
  error: Error;
}

/** `imported` is set when `distribution` serves an imported data dump. */
export interface DistributionSelectedEvent extends EventEnvelope<'distributionSelected'> {
  dataset: Dataset;
  distribution: Distribution;
  imported?: ImportDetails;
}

export interface StageStartEvent extends EventEnvelope<'stageStart'> {
  dataset: Dataset;
  stage: string;
}

export interface StageProgressEvent
  extends EventEnvelope<'stageProgress'>, MemoryUsage {
  dataset: Dataset;
  stage: string;
  itemsProcessed: number;
  quadsGenerated: number;
}

export interface StageCompleteEvent extends EventEnvelope<'stageComplete'> {
  dataset: Dataset;
  stage: string;
  itemsProcessed: number;
  quadsGenerated: number;
  durationMs: number;
}

/**
 * Also reported for per-dataset failures outside any stage, with `stage` set
 * to `write`, `provenance` or `reactive-dump-fallback`.
 */
export interface StageFailedEvent extends EventEnvelope<'stageFailed'> {
  dataset: Dataset;
  stage: string;
  error: Error;
}

export interface StageSkippedEvent extends EventEnvelope<'stageSkipped'> {
  dataset: Dataset;
  stage: string;
  reason: StageSkipReason;
}

/**
 * Reported once per (dataset, validator) pair, even when nothing was validated:
 * read `quadsValidated` to tell ‘not tested’ from ‘tested and passed’.
 */
export interface DatasetValidatedEvent extends EventEnvelope<'datasetValidated'> {
  dataset: Dataset;
  report: ValidationReport;
}

export interface DatasetCompleteEvent
  extends EventEnvelope<'datasetComplete'>, MemoryUsage {
  dataset: Dataset;
  durationMs: number;
}

export interface DatasetSkippedEvent extends EventEnvelope<'datasetSkipped'> {
  dataset: Dataset;
  reason: DatasetSkipReason;
}

/**
 * Reported when a writer leaves some of a dataset’s items out rather than
 * failing the dataset, through `RunContext.itemsRejected`.
 */
export interface ItemsRejectedEvent extends EventEnvelope<'itemsRejected'> {
  dataset: Dataset;
  rejection: ItemsRejected;
}

export interface TimeoutTightenedEvent
  extends EventEnvelope<'timeoutTightened'>, TimeoutTransitionEvent {
  dataset: Dataset;
}

export interface TimeoutRelaxedEvent
  extends EventEnvelope<'timeoutRelaxed'>, TimeoutTransitionEvent {
  dataset: Dataset;
}

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
  | ItemsRejectedEvent
  | TimeoutTightenedEvent
  | TimeoutRelaxedEvent;

/** A {@link PipelineEvent} without the envelope fields the pipeline fills in. */
export type PipelineEventPayload = PipelineEvent extends infer Event
  ? Event extends PipelineEvent
    ? Omit<Event, 'level' | 'timestamp' | 'runId'>
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
    case 'itemsRejected':
    case 'timeoutTightened':
      return 'warn';
    case 'stageFailed':
      return 'error';
  }
}
