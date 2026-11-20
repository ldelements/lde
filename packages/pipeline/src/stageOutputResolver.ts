import { Distribution } from '@lde/dataset';

/**
 * Makes a chained stage’s scratch output queryable for the next stage in the
 * chain.
 */
export interface StageOutputResolver {
  /**
   * Serve the N-Triples file at `outputPath` as a {@link Distribution}. The
   * file is empty when the stage produced nothing; serve it as an empty graph.
   */
  resolve(outputPath: string): Promise<Distribution>;
  /** Release what {@link resolve} started, once the chain finishes. */
  cleanup(): Promise<void>;
}
