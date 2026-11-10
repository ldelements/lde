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

/** Why something was skipped: a stable `code` to branch on and a human-readable `message`. */
export interface Reason<Code extends string> {
  code: Code;
  message: string;
}

/** Why the pipeline skipped a dataset. */
export type DatasetSkipReason = Reason<
  'unchanged' | 'probeFailed' | 'resolveFailed' | 'noDistributionAvailable'
>;

/**
 * Why the pipeline skipped a stage for a dataset: `noItemsSelected` when the
 * stage’s item selector selected nothing, so the stage does not apply to the
 * dataset; `notSupported` when it could not run against the dataset’s
 * distribution.
 */
export type StageSkipReason = Reason<'notSupported' | 'noItemsSelected'>;

/** The outcome of probing one distribution. */
export interface DistributionAnalysisResult {
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

/**
 * Values a stage read from a dataset but could not interpret – an integer
 * field over `onbekend`, a date over `Z.j` – and so left out of the items it
 * produced, reported once per (dataset, target, field) when the dataset
 * completes. The item itself is still produced; only the value is missing.
 */
export interface ValuesUnread {
  /** The kind of item the values were read for, e.g. a search type’s name. */
  readonly target: string;
  /** The field that could not read them; dotted for a nested field. */
  readonly field: string;
  /** How many values the field left out. */
  readonly unread: number;
  /** A few of them, each a distinct value. Bounded, so a field that rejects
   *  every value cannot grow the report with the data. */
  readonly examples: readonly UnreadValue[];
}

/** One value a stage could not read, in {@link ValuesUnread.examples}. */
export interface UnreadValue {
  /** What the value was read from, as the stage names it – for a search
   *  document, the node it was projected from, which a publisher can look up
   *  even where the document is keyed on something else. */
  readonly id: string;
  /** The value as the source stated it. */
  readonly value: string;
}

/** The process’s memory use when the event was reported. */
export interface MemoryUsage {
  memoryUsageBytes: number;
  heapUsedBytes: number;
}

/** A run started; `name` is the pipeline’s name. */
export interface PipelineStartEvent extends EventEnvelope<'pipelineStart'> {
  name: string;
}

/** The datasets to process were selected: how many, and how long selecting took. */
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

/** A run finished. */
export interface PipelineCompleteEvent
  extends EventEnvelope<'pipelineComplete'>, MemoryUsage {
  durationMs: number;
}

/** The pipeline started processing a dataset. */
export type DatasetStartEvent = DatasetEventEnvelope<'datasetStart'>;

/** One of a dataset’s distributions was probed. */
export interface DistributionProbedEvent extends DatasetEventEnvelope<'distributionProbed'> {
  distribution: Distribution;
  result: DistributionAnalysisResult;
}

/** Reported for every distribution the pipeline attempted, even when the dataset is otherwise skipped. */
export interface DistributionValidatedEvent extends DatasetEventEnvelope<'distributionValidated'> {
  distribution: Distribution;
  verdict: ValidityVerdict;
}

/** A data dump started importing for a dataset. */
export type ImportStartedEvent = DatasetEventEnvelope<'importStarted'>;

/** Importing a distribution failed. */
export interface ImportFailedEvent extends DatasetEventEnvelope<'importFailed'> {
  distribution: Distribution;
  error: Error;
}

/** `imported` is set when `distribution` serves an imported data dump. */
export interface DistributionSelectedEvent extends DatasetEventEnvelope<'distributionSelected'> {
  distribution: Distribution;
  imported?: ImportDetails;
}

/** A stage started for a dataset. */
export interface StageStartEvent extends DatasetEventEnvelope<'stageStart'> {
  stage: string;
}

/** A running stage’s progress so far. */
export interface StageProgressEvent
  extends DatasetEventEnvelope<'stageProgress'>, MemoryUsage {
  stage: string;
  itemsProcessed: number;
  quadsGenerated: number;
}

/** A stage finished for a dataset. */
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

/** A stage was skipped for a dataset. */
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

/** The pipeline finished processing a dataset. */
export interface DatasetCompleteEvent
  extends DatasetEventEnvelope<'datasetComplete'>, MemoryUsage {
  durationMs: number;
}

/** A dataset the pipeline did not process, and why. */
export interface DatasetSkippedEvent extends DatasetEventEnvelope<'datasetSkipped'> {
  reason: DatasetSkipReason;
  /** The error that caused a `probeFailed` or `resolveFailed` skip. */
  error?: Error;
}

/**
 * Reported when a writer leaves some of a dataset’s items out rather than
 * failing the dataset, through `RunContext.itemsRejected`.
 */
export interface ItemsRejectedEvent extends DatasetEventEnvelope<'itemsRejected'> {
  rejection: ItemsRejected;
}

/**
 * Reported once per (target, field) that left values out of a dataset’s items
 * (`BatchContext.valueUnread`), just before `datasetComplete`. Not reported for
 * a dataset whose stages or write failed: nothing of it is kept, so neither is
 * what it could not read.
 */
export interface ValuesUnreadEvent extends DatasetEventEnvelope<'valuesUnread'> {
  unread: ValuesUnread;
}

/** The adaptive query timeout for an endpoint was tightened. */
export interface TimeoutTightenedEvent
  extends DatasetEventEnvelope<'timeoutTightened'>, TimeoutTransitionEvent {}

/** The adaptive query timeout for an endpoint was relaxed. */
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
  | ItemsRejectedEvent
  | ValuesUnreadEvent
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
    case 'stageSkipped':
      return event.reason.code === 'noItemsSelected' ? 'info' : 'warn';
    case 'selectionEmpty':
    case 'importFailed':
    case 'itemsRejected':
    case 'valuesUnread':
    case 'timeoutTightened':
      return 'warn';
    case 'stageFailed':
      return 'error';
  }
}
