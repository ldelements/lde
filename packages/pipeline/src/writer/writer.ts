import { Dataset } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import type { ProvenanceStore } from '../provenance/store.js';

/**
 * Context for one pipeline run, handed to {@link Writer.openRun}.
 */
export interface RunContext {
  /**
   * Unique identifier of this run. An In-place writer stamps written documents
   * with it so its commit sweep can delete what the run did not touch; a
   * Blue/green writer may use it to name the fresh collection it builds.
   */
  readonly runId: string;
  /**
   * ISO 8601 timestamp taken when the run opened. Injected so writers need no
   * clock of their own.
   */
  readonly startedAt: string;
  /**
   * IRIs of every dataset the selector produced this run – including datasets
   * the pipeline skipped as unchanged. Grows while the pipeline iterates the
   * selection; it is complete by the time {@link RunWriter.commit} runs, which
   * is when a registry-membership sweep should read it.
   */
  selectedSources(): Iterable<string>;
  /**
   * The pipeline’s per-dataset processing memory, present when skip-unchanged
   * is enabled ({@link PipelineOptions.provenanceStore}).
   */
  readonly provenance?: ProvenanceStore;
}

/**
 * The per-dataset write surface of a {@link RunWriter}: what a stage writes
 * its output through. Separate from the run lifecycle so stages can write but
 * never commit or abort the run.
 */
export interface DatasetWriter<Item = Quad> {
  /**
   * Write a dataset’s items to the destination. Called one or more times per
   * dataset (once per stage) within an open run.
   *
   * @param dataset The dataset metadata
   * @param items The items to write
   */
  write(dataset: Dataset, items: AsyncIterable<Item>): Promise<void>;
}

/**
 * One open run transaction on a destination: per-dataset writes bracketed by
 * exactly one {@link commit} or {@link abort}. Obtained from
 * {@link Writer.openRun}; the pipeline drives
 * `openRun → write* → commit/abort` uniformly and never branches on the
 * writer’s update mode – an atomic swap or a deletion sweep is the writer’s
 * own business, inside {@link commit}.
 */
export interface RunWriter<Item = Quad> extends DatasetWriter<Item> {
  /**
   * Finalize writing for a dataset. Called after all stages complete for that
   * dataset.
   *
   * Writers that buffer output across multiple {@link write} calls (e.g. to
   * share Turtle prefix declarations) should implement this to flush remaining
   * data and release per-dataset resources.
   */
  flush?(dataset: Dataset): Promise<void>;

  /**
   * Discard a dataset’s already-written output so a subsequent pass starts
   * from a clean slate. Called by the pipeline before it re-runs all stages
   * against a fallback source (an imported data dump), so endpoint-sourced
   * partial results are not mixed with the dump-sourced re-run.
   *
   * Writers that build a complete replacement per dataset should implement
   * this to reset that per-dataset state. Writers without replaceable output
   * may omit it; the re-run then appends.
   */
  reset?(dataset: Dataset): Promise<void>;

  /**
   * Finalize the run: the one place a destination goes live. A Blue/green
   * writer atomically swaps its alias to the freshly built collection; an
   * In-place writer sweeps documents the run did not touch and releases its
   * lock. Called exactly once, after every dataset has been processed.
   *
   * The driver flushes every written dataset before committing (the Pipeline
   * does), so unflushed writes only reach `commit` under direct use; a writer
   * that can encounter them should finalize them non-destructively.
   */
  commit(): Promise<void>;

  /**
   * Abandon the run after a failure: the live destination must be left as it
   * was before the run. A Blue/green writer drops its half-built collection;
   * an In-place writer releases its lock and lets the next run reconcile.
   *
   * @param error The failure that ended the run
   */
  abort(error: unknown): Promise<void>;
}

/**
 * A destination for pipeline output: a factory of per-run transactions.
 *
 * Each pipeline run opens one {@link RunWriter} via {@link openRun} – the
 * home of run-level lifecycle such as alias swaps, deletion sweeps and
 * cross-pod locks. Writers without run-level lifecycle can be built with
 * {@link perDatasetWriter} instead of hand-writing no-op `commit`/`abort`.
 */
export interface Writer<Item = Quad> {
  /**
   * Open a run transaction against this destination.
   *
   * @param context The run’s identity and selection scope
   */
  openRun(context: RunContext): Promise<RunWriter<Item>>;
}

/**
 * Wrap a lifecycle-free per-dataset writer into a {@link Writer} whose run
 * lifecycle is a no-op: every run writes through the same underlying writer,
 * and `commit`/`abort` do nothing.
 *
 * Use this for destinations without run-level state (no swap, no sweep, no
 * lock) instead of implementing `openRun` by hand.
 */
export function perDatasetWriter<Item = Quad>(
  writer: DatasetWriter<Item> & {
    flush?(dataset: Dataset): Promise<void>;
    reset?(dataset: Dataset): Promise<void>;
  },
): Writer<Item> {
  return {
    async openRun(): Promise<RunWriter<Item>> {
      return {
        write: (dataset, items) => writer.write(dataset, items),
        flush: writer.flush?.bind(writer),
        reset: writer.reset?.bind(writer),
        commit: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      };
    },
  };
}
