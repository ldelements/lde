import { Dataset } from '@lde/dataset';
import {
  Client,
  Paginator,
  type SearchCriteria,
} from '@lde/dataset-registry-client';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Select {@link Dataset}s for processing in a pipeline.
 */
export interface DatasetSelector {
  select(): Promise<Paginator<Dataset>>;
}

export class ManualDatasetSelection implements DatasetSelector {
  constructor(private readonly datasets: Dataset[]) {}

  async select(): Promise<Paginator<Dataset>> {
    return new Paginator(async () => this.datasets, this.datasets.length);
  }
}

/**
 * Select one {@link Dataset} per RDF file directly inside a local directory, by
 * {@link Dataset.localFile}: the directory acts as a registry of data dumps
 * without descriptions. A file whose extension names no RDF format is skipped
 * with a warning, and subdirectories are ignored.
 *
 * Only pass a directory you trust: everything in it gets read.
 */
export class DirectorySelector implements DatasetSelector {
  /** @param directory Path of the directory. */
  constructor(private readonly directory: string) {}

  async select(): Promise<Paginator<Dataset>> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const datasets = entries
      .filter((entry) => !entry.isDirectory())
      .map((entry) => join(this.directory, entry.name))
      .sort()
      .flatMap((path) => {
        try {
          return [Dataset.localFile(path)];
        } catch (error) {
          console.warn(`Skipping ${path}: ${(error as Error).message}`);
          return [];
        }
      });

    return new ManualDatasetSelection(datasets).select();
  }
}

/**
 * Select the {@link Dataset}s of several selectors in one run, in the order
 * given, so a run can take datasets from a registry and from local files alike.
 * Each selector is read one page at a time.
 */
export class CombinedSelector implements DatasetSelector {
  constructor(private readonly selectors: readonly DatasetSelector[]) {}

  async select(): Promise<Paginator<Dataset>> {
    return new ConcatenatedPaginator(
      await Promise.all(this.selectors.map((selector) => selector.select())),
    );
  }
}

/**
 * Select Datasets from a Dataset Registry.
 *
 *
 *
 * @example
 * ```typescript
 *
 * ```
 *
 * @param {object} options
 * @param Client options.registry The Dataset Registry Client to query for datasets.
 * @param string options.query Optional custom SPARQL query to select datasets.
 * @param SearchCriteria options.criteria Optional search criteria to select datasets.
 */
export class RegistrySelector implements DatasetSelector {
  private readonly registry: Client;
  private readonly query?: string;
  private readonly criteria?: SearchCriteria;

  constructor({
    registry,
    query,
    criteria,
  }: {
    registry: Client;
    query?: string;
    criteria?: SearchCriteria;
  }) {
    this.registry = registry;
    this.query = query;
    this.criteria = criteria;
  }

  async select() {
    if (this.query) {
      return this.registry.query(this.query);
    } else {
      return this.registry.query(this.criteria ?? {});
    }
  }
}

/**
 * Several paginators read as one. Each iteration reads them afresh, so loops
 * over it never share state, and each paginator still reads one page at a time.
 */
class ConcatenatedPaginator extends Paginator<Dataset> {
  constructor(private readonly paginators: readonly Paginator<Dataset>[]) {
    super(
      async () => [],
      paginators.reduce((total, paginator) => total + paginator.total, 0),
    );
  }

  override async *[Symbol.asyncIterator](): AsyncIterator<Dataset> {
    for (const paginator of this.paginators) {
      yield* paginator;
    }
  }
}
