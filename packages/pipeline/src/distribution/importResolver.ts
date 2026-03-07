import { type Dataset, Distribution } from '@lde/dataset';
import type { Importer } from '@lde/sparql-importer';
import { ImportFailed, ImportSuccessful } from '@lde/sparql-importer';
import type { SparqlServer } from '@lde/sparql-server';
import {
  type DistributionResolver,
  type ResolveCallbacks,
  NoDistributionAvailable,
  ResolvedDistribution,
} from './resolver.js';

export interface ImportResolverOptions {
  importer: Importer;
  server: SparqlServer;
  /**
   * Controls how a dataset's distribution is selected.
   *
   * - `'sparql'` (default) — use a dataset's own SPARQL endpoint when one is
   *   available; fall back to importing a data dump only when no endpoint
   *   responds.
   * - `'import'` — always import a data dump into a local SPARQL server,
   *   even when the dataset advertises a working SPARQL endpoint. Useful when
   *   the remote endpoint is too slow or unreliable.
   *
   * In both modes the inner resolver still runs so that probe results are
   * collected for reporting and the dataset knowledge graph.
   */
  strategy?: 'sparql' | 'import';
}

/**
 * A {@link DistributionResolver} decorator that adds data-dump import logic.
 *
 * Wraps an inner resolver (typically {@link SparqlDistributionResolver}) and
 * adds the ability to import a data dump into a local SPARQL server. The
 * {@link ImportResolverOptions.strategy | strategy} option controls whether the
 * inner resolver's SPARQL endpoint is preferred or bypassed.
 */
export class ImportResolver implements DistributionResolver {
  constructor(
    private readonly inner: DistributionResolver,
    private readonly options: ImportResolverOptions,
  ) {}

  async resolve(
    ...args: Parameters<DistributionResolver['resolve']>
  ): Promise<ResolvedDistribution | NoDistributionAvailable> {
    const [dataset, callbacks] = args;
    const result = await this.inner.resolve(...args);

    // 'sparql' strategy (default): use SPARQL endpoint if inner found one.
    if (
      this.options.strategy !== 'import' &&
      result instanceof ResolvedDistribution
    ) {
      return result;
    }

    // Either 'import' strategy or inner found nothing: import a data dump.
    return this.importDataset(dataset, result.probeResults, callbacks);
  }

  private async importDataset(
    dataset: Dataset,
    probeResults: NoDistributionAvailable['probeResults'],
    callbacks?: ResolveCallbacks,
  ): Promise<ResolvedDistribution | NoDistributionAvailable> {
    const importStart = Date.now();
    const importResult = await this.options.importer.import(dataset);

    if (importResult instanceof ImportSuccessful) {
      await this.options.server.start();

      const distribution = Distribution.sparql(
        this.options.server.queryEndpoint,
        importResult.identifier,
      );
      distribution.subjectFilter = importResult.distribution.subjectFilter;

      return new ResolvedDistribution(
        distribution,
        probeResults,
        importResult.distribution,
        Date.now() - importStart,
        importResult.tripleCount,
      );
    }

    if (importResult instanceof ImportFailed) {
      callbacks?.onImportFailed?.(
        importResult.distribution,
        importResult.error,
      );
    }

    return new NoDistributionAvailable(
      dataset,
      'No SPARQL endpoint or importable data dump available',
      probeResults,
      importResult instanceof ImportFailed ? importResult : undefined,
    );
  }

  async cleanup(): Promise<void> {
    await this.options.server.stop();
  }
}
