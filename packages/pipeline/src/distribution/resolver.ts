import { Dataset, Distribution } from '@lde/dataset';
import type { ImportFailed } from '@lde/sparql-importer';
import { probe, SparqlProbeResult, type ProbeResultType } from './probe.js';

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

/** Callbacks fired during distribution resolution. */
export interface ResolveCallbacks {
  /** Called each time a single distribution probe completes. */
  onProbe?: (distribution: Distribution, result: ProbeResultType) => void;
  /** Called when importing a distribution fails. */
  onImportFailed?: (distribution: Distribution, error: string) => void;
}

export interface DistributionResolver {
  resolve(
    dataset: Dataset,
    callbacks?: ResolveCallbacks,
  ): Promise<ResolvedDistribution | NoDistributionAvailable>;
  cleanup?(): Promise<void>;
}

export interface SparqlDistributionResolverOptions {
  timeout?: number;
}

/**
 * Resolves a dataset to a usable SPARQL distribution by probing its distributions.
 *
 * 1. Probes all distributions in parallel.
 * 2. Returns the first valid SPARQL endpoint as a `ResolvedDistribution`.
 * 3. If none: returns `NoDistributionAvailable`.
 *
 * Does not mutate `dataset.distributions`.
 */
export class SparqlDistributionResolver implements DistributionResolver {
  private readonly timeout: number;

  constructor(options?: SparqlDistributionResolverOptions) {
    this.timeout = options?.timeout ?? 5000;
  }

  async resolve(
    dataset: Dataset,
    callbacks?: ResolveCallbacks,
  ): Promise<ResolvedDistribution | NoDistributionAvailable> {
    const results = await Promise.all(
      dataset.distributions.map(async (distribution) => {
        const result = await probe(distribution, this.timeout);
        callbacks?.onProbe?.(distribution, result);
        return result;
      }),
    );

    // Find first valid SPARQL endpoint.
    for (let i = 0; i < dataset.distributions.length; i++) {
      const distribution = dataset.distributions[i];
      const result = results[i];

      if (
        distribution.isSparql() &&
        result instanceof SparqlProbeResult &&
        result.isSuccess()
      ) {
        return new ResolvedDistribution(distribution, results);
      }
    }

    return new NoDistributionAvailable(
      dataset,
      'No SPARQL endpoint available',
      results,
    );
  }
}
