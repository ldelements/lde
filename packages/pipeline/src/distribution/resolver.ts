import { Dataset, Distribution } from '@lde/dataset';
import type { ImportFailed } from '@lde/sparql-importer';
import {
  probe,
  SparqlProbeResult,
  type ProbeResultType,
} from '@lde/distribution-probe';

export class ResolvedDistribution {
  constructor(
    readonly distribution: Distribution,
    readonly probeResults: ProbeResultType[],
    readonly importedFrom?: Distribution,
    readonly importDuration?: number,
    readonly tripleCount?: number,
  ) {}
}

export class NoDistributionAvailable {
  constructor(
    readonly dataset: Dataset,
    readonly message: string,
    readonly probeResults: ProbeResultType[],
    readonly importFailed?: ImportFailed,
  ) {}
}

/**
 * The distribution a dataset will be processed from, paired with its probe
 * result. Drives the source-change fingerprint: a live SPARQL endpoint yields
 * `null` (always reprocess), a data dump yields its change fingerprint.
 */
export interface ProbedSource {
  distribution: Distribution;
  probeResult: ProbeResultType;
}

/**
 * The outcome of the probe phase: every distribution’s probe result, plus the
 * {@link ProbedSource} that will be used to process the dataset (or `null` if
 * none is available). Determined without importing, so the pipeline can decide
 * to skip a dataset before paying the import cost.
 */
export class ProbedDistributions {
  constructor(
    readonly dataset: Dataset,
    readonly probeResults: ProbeResultType[],
    readonly source: ProbedSource | null,
  ) {}
}

/** Callbacks fired during distribution probing and resolution. */
export interface ResolveCallbacks {
  /** Called each time a single distribution probe completes (probe phase). */
  onProbe?: (distribution: Distribution, result: ProbeResultType) => void;
  /** Called when a data-dump import begins (resolve phase). */
  onImportStart?: () => void;
  /** Called when importing a distribution fails (resolve phase). */
  onImportFailed?: (distribution: Distribution, error: string) => void;
}

/**
 * Resolves a dataset to a usable distribution in two phases so the pipeline can
 * gate on a dataset’s source-change fingerprint before paying any import cost:
 *
 * 1. {@link probe} probes every distribution and selects the source-to-be,
 *    without importing.
 * 2. {@link resolve} turns that probed source into a usable SPARQL endpoint,
 *    importing a data dump only when the source is one.
 */
export interface DistributionResolver {
  probe(
    dataset: Dataset,
    callbacks?: ResolveCallbacks,
  ): Promise<ProbedDistributions>;
  resolve(
    probed: ProbedDistributions,
    callbacks?: ResolveCallbacks,
  ): Promise<ResolvedDistribution | NoDistributionAvailable>;
  /**
   * Re-resolve a dataset to an alternative source after the primary source
   * (a live SPARQL endpoint) failed to serve the analysis stages. Returns an
   * imported data dump as a {@link ResolvedDistribution}, or
   * {@link NoDistributionAvailable} when no fallback exists or reactive
   * fallback is not enabled.
   *
   * Resolvers without a dump to fall back to (e.g.
   * {@link SparqlDistributionResolver}) omit this method; the pipeline then
   * keeps the endpoint-sourced partial results.
   */
  resolveFallback?(
    probed: ProbedDistributions,
    callbacks?: ResolveCallbacks,
  ): Promise<ResolvedDistribution | NoDistributionAvailable>;
  cleanup?(): Promise<void>;
}

export interface SparqlDistributionResolverOptions {
  timeout?: number;
}

/**
 * Resolves a dataset to its own SPARQL endpoint by probing its distributions.
 *
 * {@link probe} returns the first valid SPARQL endpoint as the
 * {@link ProbedSource}; {@link resolve} returns it as a
 * {@link ResolvedDistribution}, or {@link NoDistributionAvailable} when none
 * responded. Never imports a data dump – wrap with {@link ImportResolver} for
 * that.
 *
 * Does not mutate `dataset.distributions`.
 */
export class SparqlDistributionResolver implements DistributionResolver {
  private readonly timeout: number;

  constructor(options?: SparqlDistributionResolverOptions) {
    this.timeout = options?.timeout ?? 5000;
  }

  async probe(
    dataset: Dataset,
    callbacks?: ResolveCallbacks,
  ): Promise<ProbedDistributions> {
    const results = await Promise.all(
      dataset.distributions.map(async (distribution) => {
        const result = await probe(distribution, { timeoutMs: this.timeout });
        callbacks?.onProbe?.(distribution, result);
        return result;
      }),
    );

    // Find first valid SPARQL endpoint.
    let source: ProbedSource | null = null;
    for (let i = 0; i < dataset.distributions.length; i++) {
      const distribution = dataset.distributions[i];
      const result = results[i];

      if (
        distribution.isSparql() &&
        result instanceof SparqlProbeResult &&
        result.isSuccess()
      ) {
        source = { distribution, probeResult: result };
        break;
      }
    }

    return new ProbedDistributions(dataset, results, source);
  }

  async resolve(
    probed: ProbedDistributions,
  ): Promise<ResolvedDistribution | NoDistributionAvailable> {
    if (probed.source && probed.source.distribution.isSparql()) {
      return new ResolvedDistribution(
        probed.source.distribution,
        probed.probeResults,
      );
    }

    return new NoDistributionAvailable(
      probed.dataset,
      'No SPARQL endpoint available',
      probed.probeResults,
    );
  }
}
