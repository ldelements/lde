import { FileProvenanceStore, type Pipeline } from '@lde/pipeline';
import { ConsoleReporter } from '@lde/pipeline-console-reporter';
import { loadSchemaModule } from '@lde/search/module';
import {
  searchIndexerPipeline,
  type TypedSearchDocument,
} from '@lde/search-pipeline';
import { Client } from 'typesense';
import {
  datasetSelectorFrom,
  distributionResolverFrom,
  writerFactoryFrom,
} from './composition.js';
import type { IndexerConfig } from './config.js';

/**
 * Compose the ready-to-run search indexer from an {@link IndexerConfig}: load
 * and validate the mounted schema module (the same file the served-API image
 * mounts), select datasets from the registry, bind the Typesense rebuild
 * writers, and wire the optional QLever import path and provenance store into
 * `searchIndexerPipeline`. Every misconfiguration – an invalid schema, an
 * underivable collection name – throws here, at boot, never mid-run.
 */
export async function createSearchIndexer(
  config: IndexerConfig,
): Promise<Pipeline<TypedSearchDocument>> {
  const { schema } = await loadSchemaModule(config.schemaModulePath);
  const client = new Client({
    nodes: [
      {
        host: config.typesense.host,
        port: config.typesense.port,
        protocol: config.typesense.protocol,
      },
    ],
    apiKey: config.typesense.apiKey,
  });
  return searchIndexerPipeline({
    schema,
    datasets: datasetSelectorFrom(config),
    distributionResolver: distributionResolverFrom(config),
    writerFor: writerFactoryFrom(client, config),
    provenanceStore: config.provenance
      ? new FileProvenanceStore({ path: config.provenance.path })
      : undefined,
    pipelineVersion: config.provenance?.pipelineVersion,
    reporter: new ConsoleReporter(),
  });
}
