/**
 * The per-dataset processing memory the pipeline keeps to decide whether a
 * dataset can be skipped on the next run.
 *
 * Both change fields ({@link sourceModified} and {@link pipelineVersion}) are
 * opaque strings, compared only for equality – never parsed or ordered.
 */
export interface ProcessingRecord {
  /**
   * The source-change signal at the time of processing (see `sourceSignal`),
   * or `null` when none could be established (e.g. a live SPARQL endpoint). A
   * `null` signal never compares equal, so the dataset is always reprocessed.
   */
  sourceModified: string | null;
  /** The consumer-declared pipeline version under which the dataset was processed. */
  pipelineVersion: string;
  /** ISO timestamp of when the record was written. */
  generatedAt: string;
  /**
   * Whether processing succeeded. Recorded so a dataset that failed but whose
   * source is unchanged is skipped on subsequent runs rather than re-imported
   * every run; it is retried at the next source change or version rotation.
   */
  status: 'success' | 'failed';
}

/** The two fields the skip rule compares for equality. */
export interface ChangeFields {
  sourceModified: string | null;
  pipelineVersion: string;
}
