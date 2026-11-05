import type { Dataset, Distribution } from '@lde/dataset';
import type { ValidityVerdict } from '@lde/distribution-health';
import type { ValidationReport } from './validator.js';
import type { ImportDetails } from './distribution/resolver.js';
import type { TimeoutTransitionEvent } from './sparql/timeoutPolicy.js';

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

export interface ProgressReporter {
  pipelineStart?(name: string): void;
  datasetsSelected?(count: number, duration: number): void;
  /**
   * Called when the run is abandoned because the selection was empty – no
   * commit, destination unchanged. Distinct from a completed run that indexed
   * nothing: the writers were told to abort, so nothing was swept or swapped.
   */
  selectionEmpty?(reason: string): void;
  datasetStart?(dataset: Dataset): void;
  /** Called each time a single distribution probe completes. */
  distributionProbed?(result: DistributionAnalysisResult): void;
  /** Called when a data-dump import begins. */
  importStarted?(): void;
  /** Called when importing a distribution fails. */
  importFailed?(distribution: Distribution, error: string): void;
  /**
   * Called with the RDF-validity verdict for a distribution the pipeline
   * attempted, whether valid or invalid, and even when the dataset is
   * otherwise skipped (no summary produced). The verdict is a plain
   * TypeScript value; consumers decide how (and whether) to record it as RDF.
   */
  distributionValidated?(
    distribution: Distribution,
    verdict: ValidityVerdict,
  ): void;
  /** Called when a dataset’s source is resolved; `imported` is set when the
   *  source serves an imported data dump. */
  distributionSelected?(
    dataset: Dataset,
    distribution: Distribution,
    imported?: ImportDetails,
  ): void;
  stageStart?(stage: string): void;
  stageProgress?(update: {
    itemsProcessed: number;
    quadsGenerated: number;
    memoryUsageBytes: number;
    heapUsedBytes: number;
  }): void;
  stageComplete?(
    stage: string,
    result: {
      itemsProcessed: number;
      quadsGenerated: number;
      duration: number;
    },
  ): void;
  stageFailed?(stage: string, error: Error): void;
  stageSkipped?(stage: string, reason: string): void;
  /**
   * Called once per (dataset, validator) pair after all stages for a dataset
   * have run. Fires regardless of whether any stage actually invoked
   * `validate()` – the report reflects the validator’s accumulated state.
   * When no stage produced data, the report typically carries
   * `quadsValidated: 0` and `conforms: true` (the SHACL vacuous-truth
   * default); consumers that want to distinguish ‘not tested’ from ‘tested
   * and passed’ can read `quadsValidated`.
   */
  datasetValidated?(dataset: Dataset, report: ValidationReport): void;
  datasetComplete?(
    dataset: Dataset,
    result: { memoryUsageBytes: number; heapUsedBytes: number },
  ): void;
  datasetSkipped?(dataset: Dataset, reason: string): void;
  /**
   * Called when a writer leaves some of a dataset’s items out rather than
   * failing the dataset ({@link RunContext.itemsRejected}).
   */
  itemsRejected?(dataset: Dataset, rejection: ItemsRejected): void;
  pipelineComplete?(result: {
    duration: number;
    memoryUsageBytes: number;
    heapUsedBytes: number;
  }): void;
  /**
   * Called when a {@link TimeoutPolicy} tightens the budget for an
   * endpoint after a run of consecutive timeouts. Lets operators
   * distinguish a fast-failed stage from an unexpected speedup.
   */
  timeoutTightened?(event: TimeoutTransitionEvent): void;
  /**
   * Called when a {@link TimeoutPolicy} relaxes the budget back to the
   * default after a successful request on a previously-tightened endpoint.
   */
  timeoutRelaxed?(event: TimeoutTransitionEvent): void;
}
