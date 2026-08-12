import {
  FileProvenanceStore,
  type Pipeline,
  type QuadTransform,
  type ReaderContext,
} from '@lde/pipeline';
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

/** What a deployment adds to the standard indexer – the domain behaviour no
 *  configuration can express. */
export interface SearchIndexerExtensions {
  /**
   * {@link QuadTransform}(s) per root type, keyed by `SearchType.name`: correct
   * the data, mint a quad the source does not ship, drop one it should not.
   * Attached to the type’s reader, so a transform sees each root’s quads before
   * projection.
   *
   * This is the whole cost of adding behaviour – dataset selection, the QLever
   * import path, registry-sourced types, collection naming, provenance and
   * reporting stay wired. A name the schema does not declare throws at boot.
   *
   * A field a transform fills must still declare a `path`: projection skips a
   * field with neither a `path` nor a `derive`.
   */
  readonly transforms?: Readonly<
    Record<
      string,
      QuadTransform<ReaderContext> | QuadTransform<ReaderContext>[]
    >
  >;
}

/**
 * Compose the ready-to-run search indexer from an {@link IndexerConfig}: load
 * and validate the mounted schema module (the same file the served-API image
 * mounts), select datasets from the registry, bind the Typesense rebuild
 * writers, and wire the optional QLever import path and provenance store into
 * `searchIndexerPipeline`. Every misconfiguration – an invalid schema, an
 * underivable collection name, a transform naming an undeclared type – throws
 * here, at boot, never mid-run.
 *
 * `extensions` carries the domain behaviour a deployment adds on top
 * ({@link SearchIndexerExtensions}); everything else about a deployment is
 * configuration, so the bin and the Docker image need only the config.
 */
export async function createSearchIndexer(
  config: IndexerConfig,
  extensions: SearchIndexerExtensions = {},
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
    registryTypes:
      config.registryRootTypes.length > 0
        ? {
            endpoint: config.registryEndpoint,
            names: config.registryRootTypes,
          }
        : undefined,
    provenanceStore: config.provenance
      ? new FileProvenanceStore({ path: config.provenance.path })
      : undefined,
    pipelineVersion: config.provenance?.pipelineVersion,
    reporter: new ConsoleReporter(),
    transforms: extensions.transforms,
  });
}
