import { type Dataset, Distribution } from '@lde/dataset';
import type { Importer } from '@lde/sparql-importer';
import {
  ImportFailed,
  ImportSuccessful,
  NotSupported,
} from '@lde/sparql-importer';
import type { SparqlServer } from '@lde/sparql-server';
import {
  type DistributionResolver,
  type ResolveCallbacks,
  NoDistributionAvailable,
  ResolvedDistribution,
} from './resolver.js';
import { NetworkError } from '@lde/distribution-probe';

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
    const successfulUrls = new Set(
      probeResults
        .filter((r) => !(r instanceof NetworkError) && r.isSuccess())
        .map((r) => r.url),
    );

    const candidates = dataset
      .getDownloadDistributions()
      .filter((d) => d.accessUrl && successfulUrls.has(d.accessUrl.toString()));

    // Establish a trustworthy change signal for the downloader so it can skip
    // redundant downloads (and preserve the QLever index cache). For a data
    // dump the authoritative date is the most recent of the register’s declared
    // `dct:modified` and the artifact’s real HTTP `Last-Modified`: a stale
    // register date must never mask a newer upload (openarchieven publishes
    // dumps with a months-old `dct:modified`, see #436). Taking the maximum errs
    // toward reprocessing rather than serving stale output.
    for (const candidate of candidates) {
      const probeResult = probeResults.find(
        (r) => r.url === candidate.accessUrl.toString(),
      );
      if (
        probeResult &&
        !(probeResult instanceof NetworkError) &&
        probeResult.lastModified &&
        (candidate.lastModified === undefined ||
          probeResult.lastModified > candidate.lastModified)
      ) {
        candidate.lastModified = probeResult.lastModified;
      }
    }

    if (candidates.length === 0) {
      return new NoDistributionAvailable(
        dataset,
        'No importable distributions passed probing',
        probeResults,
      );
    }

    const importStart = Date.now();
    callbacks?.onImportStart?.();
    const importResult = await this.options.importer.import(candidates);

    if (importResult instanceof ImportSuccessful) {
      try {
        await this.options.server.start();
      } catch (error) {
        callbacks?.onImportFailed?.(
          importResult.distribution,
          error instanceof Error ? error.message : String(error),
        );
        return new NoDistributionAvailable(
          dataset,
          'SPARQL server failed to start after import',
          probeResults,
        );
      }

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

    if (importResult instanceof NotSupported) {
      const failedDistribution = importResult.distribution ?? candidates[0];
      callbacks?.onImportFailed?.(
        failedDistribution,
        'No supported import format',
      );
      return new NoDistributionAvailable(
        dataset,
        'No supported import format available',
        probeResults,
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
