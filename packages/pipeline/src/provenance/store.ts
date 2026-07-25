import type { ProcessingRecord } from './record.js';

/**
 * The pipeline’s per-dataset processing memory.
 *
 * The framework owns the skip semantics (see `shouldReprocess`); a
 * `ProvenanceStore` owns only the physical storage of {@link ProcessingRecord}s,
 * keyed by dataset URI. Implementations are free to back this with a
 * triplestore, files, or anything else.
 */
export interface ProvenanceStore {
  /**
   * Verify the store can persist records, throwing when it cannot. The
   * pipeline calls this once at the start of a run, so a store that would
   * fail every write – e.g. a provenance file on a mount the runtime user
   * cannot write to – fails the run immediately instead of silently
   * disabling skip-unchanged.
   */
  check?(): Promise<void>;
  /**
   * The record from the dataset’s last processing, or `null` if it has never
   * been processed (or the store was wiped). A `null` result drives a
   * reprocess.
   */
  get(datasetUri: URL): Promise<ProcessingRecord | null>;
  /** Persist the record for a dataset, replacing any previous one. */
  set(datasetUri: URL, record: ProcessingRecord): Promise<void>;
}
