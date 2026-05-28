import type { Dataset, Distribution } from '@lde/dataset';
import type { ValidationReport } from './validator.js';
import type { TimeoutTransitionEvent } from './sparql/timeoutPolicy.js';

export interface DistributionAnalysisResult {
  distribution: Distribution;
  type: 'sparql' | 'data-dump' | 'network-error';
  available: boolean;
  statusCode?: number;
  error?: string;
  warnings: string[];
}

export interface ProgressReporter {
  pipelineStart?(name: string): void;
  datasetsSelected?(count: number, duration: number): void;
  datasetStart?(dataset: Dataset): void;
  /** Called each time a single distribution probe completes. */
  distributionProbed?(result: DistributionAnalysisResult): void;
  /** Called when a data-dump import begins. */
  importStarted?(): void;
  /** Called when importing a distribution fails. */
  importFailed?(distribution: Distribution, error: string): void;
  distributionSelected?(
    dataset: Dataset,
    distribution: Distribution,
    importedFrom?: Distribution,
    importDuration?: number,
    tripleCount?: number,
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
   * `validate()` — the report reflects the validator’s accumulated state.
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
