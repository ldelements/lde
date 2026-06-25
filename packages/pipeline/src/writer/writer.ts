import { Dataset } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';

/**
 * Interface for writing RDF data to a destination.
 */
export interface Writer {
  /**
   * Write RDF data for a dataset to the destination.
   *
   * @param dataset The dataset metadata
   * @param quads The RDF quads to write
   */
  write(dataset: Dataset, quads: AsyncIterable<Quad>): Promise<void>;

  /**
   * Finalize writing for a dataset. Called after all stages complete.
   *
   * Writers that buffer output across multiple {@link write} calls (e.g. to
   * share Turtle prefix declarations) should implement this to flush remaining
   * data and release resources.
   */
  flush?(dataset: Dataset): Promise<void>;

  /**
   * Discard a dataset’s already-written output so a subsequent run starts from
   * a clean slate. Called by the pipeline before it re-runs all stages against
   * a fallback source (an imported data dump), so endpoint-sourced partial
   * results are not mixed with the dump-sourced re-run.
   *
   * Writers that build a complete replacement per dataset (e.g.
   * {@link SparqlUpdateWriter}, which clears each graph on first write) should
   * implement this to reset that per-dataset state. Writers without
   * replaceable output may omit it; the re-run then appends.
   */
  reset?(dataset: Dataset): Promise<void>;
}
