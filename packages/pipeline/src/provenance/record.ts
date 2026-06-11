/**
 * The per-dataset processing memory the pipeline keeps to decide whether a
 * dataset can be skipped on the next run.
 *
 * Both change fields ({@link sourceFingerprint} and {@link pipelineVersion})
 * are opaque strings, compared only for equality – never parsed or ordered.
 */
export interface ProcessingRecord {
  /**
   * The source-change fingerprint at the time of processing (see
   * `sourceFingerprint`), or `null` when none could be established (e.g. a live
   * SPARQL endpoint). Derived automatically from observed source metadata, not
   * a declared version. A `null` fingerprint never compares equal, so the
   * dataset is always reprocessed.
   */
  sourceFingerprint: string | null;
  /**
   * The consumer-declared pipeline version under which the dataset was
   * processed. Kept separate from {@link sourceFingerprint}, never combined
   * into a single fingerprint: the data side is observed, the logic side is
   * intentionally declared.
   */
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
export type ChangeKey = Pick<
  ProcessingRecord,
  'sourceFingerprint' | 'pipelineVersion'
>;
