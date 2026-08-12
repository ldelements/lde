// The composition pieces of createSearchIndexer, each usable on its own so a
// deployment that needs one bespoke stage keeps the rest of the wiring
// (Pipeline keeps its own wiring private).
import { Client as RegistryClient } from '@lde/dataset-registry-client';
import {
  ImportResolver,
  RegistrySelector,
  SparqlDistributionResolver,
  type DatasetSelector,
  type DistributionResolver,
  type Writer,
} from '@lde/pipeline';
import type { RootType, SearchDocument, SearchSchema } from '@lde/search';
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
 * so, so the read side must be configured with the same prefix – and its
 * untagged text stemmed in the configured {@link IndexerConfig.defaultLocale}.
 *
 * The mounted schema the pipeline hands each call travels into the writer: a
 * type that surfaces an inline reference builds its collection from the
 * Reference Type the schema resolves, so the nested fields are declared rather
 * than silently dropped.
 */
export function writerFactoryFrom(
  client: Client,
  config: IndexerConfig,
): (searchType: RootType, schema: SearchSchema) => Writer<SearchDocument> {
  return (searchType, schema) => {
    const writerOptions = {
      defaultLocale: config.defaultLocale,
      schema,
      ...(config.collectionPrefix
        ? {
            name: `${config.collectionPrefix}${deriveCollectionName(searchType)}`,
          }
        : {}),
    };
    return config.rebuildMode === 'blue-green'
      ? new BlueGreenRebuild(client, searchType, writerOptions)
      : new InPlaceRebuild(client, searchType, writerOptions);
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
  const { importer, server } = config.qlever.network
    ? createQlever({
        mode: 'docker',
        image: config.qlever.image,
        dataDir: config.qlever.dataDir,
        network: config.qlever.network,
        // The network-scoped name doubles as the endpoint hostname. It keeps
        // stacks on different networks from removing each other’s QLever;
        // indexers sharing one network would still collide, so run at most
        // one indexer per network.
        containerName: `qlever-${config.qlever.network}`,
      })
    : createQlever({
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
