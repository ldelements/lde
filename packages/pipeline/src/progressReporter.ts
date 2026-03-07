import type { Dataset, Distribution } from '@lde/dataset';

export interface DistributionAnalysisResult {
  distribution: Distribution;
  type: 'sparql' | 'data-dump' | 'network-error';
  available: boolean;
  statusCode?: number;
  error?: string;
}

export interface ProgressReporter {
  pipelineStart?(name: string): void;
  datasetsSelected?(count: number, duration: number): void;
  datasetStart?(dataset: Dataset): void;
  /** Called each time a single distribution probe completes. */
  distributionProbed?(result: DistributionAnalysisResult): void;
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
  datasetComplete?(dataset: Dataset): void;
  datasetSkipped?(dataset: Dataset, reason: string): void;
  pipelineComplete?(result: { duration: number }): void;
}
