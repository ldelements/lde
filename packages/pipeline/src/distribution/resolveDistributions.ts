import { type Distribution, type Dataset } from '@lde/dataset';
import type { Quad } from 'n3';
import type { ProbeResultType } from '@lde/distribution-probe';
import { probeResultsToQuads } from './report.js';
import {
  type DistributionResolver,
  NoDistributionAvailable,
} from './resolver.js';

export interface DistributionStageResult {
  distribution: Distribution | null;
  probeResults: ProbeResultType[];
  quads: AsyncIterable<Quad>;
}

export async function resolveDistributions(
  dataset: Dataset,
  resolver: DistributionResolver,
): Promise<DistributionStageResult> {
  const probed = await resolver.probe(dataset);
  const result = await resolver.resolve(probed);

  if (result instanceof NoDistributionAvailable) {
    return {
      distribution: null,
      probeResults: result.probeResults,
      quads: probeResultsToQuads(
        result.probeResults,
        dataset.iri.toString(),
        result.importFailed,
      ),
    };
  }

  return {
    distribution: result.distribution,
    probeResults: result.probeResults,
    quads: probeResultsToQuads(result.probeResults, dataset.iri.toString()),
  };
}
