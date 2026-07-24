// Internal composition pieces of createSearchIndexer, split out so each can
// be tested without running a pipeline (Pipeline keeps its wiring private).
import { Client as RegistryClient } from '@lde/dataset-registry-client';
import {
  ImportResolver,
  RegistrySelector,
  SparqlDistributionResolver,
  type DatasetSelector,
  type DistributionResolver,
  type Writer,
} from '@lde/pipeline';
import type { RootType, SearchDocument } from '@lde/search';
import {
  BlueGreenRebuild,
  deriveCollectionName,
  InPlaceRebuild,
} from '@lde/search-typesense';
import { createQlever } from '@lde/sparql-qlever';
import type { Client } from 'typesense';
import type { IndexerConfig } from './config.js';

/** The registry-backed dataset selection the configuration describes. */
export function datasetSelectorFrom(config: IndexerConfig): DatasetSelector {
  return new RegistrySelector({
    registry: new RegistryClient(config.registryEndpoint),
    criteria: config.datasetCriteria,
  });
}

/**
 * The engine-writer factory the configuration describes: an
 * {@link InPlaceRebuild} or {@link BlueGreenRebuild} per root type, its
 * collection name derived from the type – prefixed when the deployment says
 * so, so the read side must be configured with the same prefix.
 */
export function writerFactoryFrom(
  client: Client,
  config: IndexerConfig,
): (searchType: RootType) => Writer<SearchDocument> {
  return (searchType) => {
    const options = config.collectionPrefix
      ? {
          name: `${config.collectionPrefix}${deriveCollectionName(searchType)}`,
        }
      : {};
    return config.rebuildMode === 'blue-green'
      ? new BlueGreenRebuild(client, searchType, options)
      : new InPlaceRebuild(client, searchType, options);
  };
}

/**
 * The distribution resolver the configuration describes: with `QLEVER_IMAGE`
 * set, an {@link ImportResolver} that imports data dumps into a
 * pipeline-controlled QLever sibling container over the mounted Docker
 * socket; without it, `undefined`, leaving the pipeline its endpoint-only
 * default (a bare {@link SparqlDistributionResolver}).
 */
export function distributionResolverFrom(
  config: IndexerConfig,
): DistributionResolver | undefined {
  if (!config.qlever) {
    return undefined;
  }
  const { importer, server } = createQlever({
    mode: 'docker',
    image: config.qlever.image,
    dataDir: config.qlever.dataDir,
  });
  return new ImportResolver(new SparqlDistributionResolver(), {
    importer,
    server,
    strategy: config.qlever.strategy,
  });
}
