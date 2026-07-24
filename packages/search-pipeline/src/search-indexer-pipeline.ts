import type { Dataset } from '@lde/dataset';
import {
  ManualDatasetSelection,
  Pipeline,
  type DatasetSelector,
  type DistributionResolver,
  type ProgressReporter,
  type ProvenanceStore,
  type Writer,
} from '@lde/pipeline';
import type { RootType, SearchDocument, SearchSchema } from '@lde/search';
import { searchIndexWriter } from './search-index-writer.js';
import { searchStages, selectByClass } from './search-stages.js';
import type { TypedSearchDocument } from './typed-search-document.js';

/** Options for {@link searchIndexerPipeline}. */
export interface SearchIndexerPipelineOptions {
  /**
   * The declarative schema driving the indexer: one stage and one engine
   * collection per {@link RootType} in it. Reference Types are absent from
   * `schema.values()`, so none ever earns a stage or a collection.
   */
  schema: SearchSchema;
  /**
   * Which datasets to index – the deployment’s domain fact. Pass the
   * {@link Dataset}s directly, or a {@link DatasetSelector} (e.g. a
   * `RegistrySelector`) when selection is dynamic.
   */
  datasets: Dataset[] | DatasetSelector;
  /**
   * How each dataset’s data becomes queryable – the deployment’s engine
   * choice. Typically an `ImportResolver` wrapping a
   * `SparqlDistributionResolver` with a `@lde/sparql-qlever` `createQlever`
   * import path, so data-dump distributions are imported into a local
   * endpoint. Defaults to the {@link Pipeline} default (a bare
   * `SparqlDistributionResolver`), which serves only datasets that publish a
   * live SPARQL endpoint.
   */
  distributionResolver?: DistributionResolver;
  /**
   * The engine writer that owns a given root type’s collection – e.g. a
   * `@lde/search-typesense` `InPlaceRebuild` or `BlueGreenRebuild` bound to
   * that type. Called once per {@link RootType} in the schema.
   */
  writerFor: (searchType: RootType) => Writer<SearchDocument>;
  /**
   * Optional per-dataset processing memory: skip a dataset whose source
   * fingerprint and {@link pipelineVersion} both match the stored record.
   * Requires {@link pipelineVersion}.
   */
  provenanceStore?: ProvenanceStore;
  /**
   * Opaque, consumer-declared version of the indexer’s output-affecting logic
   * (schema, projection). Required when {@link provenanceStore} is set – a
   * skip-enabled pipeline with no version would silently freeze.
   */
  pipelineVersion?: string;
  /**
   * Observer(s) of pipeline lifecycle events, e.g. a
   * `@lde/pipeline-console-reporter` `ConsoleReporter`.
   */
  reporter?: ProgressReporter | readonly ProgressReporter[];
}

/**
 * Wire the common **object-grain** search indexer and return the ready-to-run
 * {@link Pipeline}: one projecting stage per {@link RootType} in the schema,
 * each selecting the type’s roots by its source class with blank-node subjects
 * excluded ({@link selectByClass} – a blank node has no stable document key),
 * extracting with the schema-generated CONSTRUCT, and projecting inside the
 * batch; plus the single {@link searchIndexWriter} terminal routing each
 * document to the engine writer for its type’s collection.
 *
 * The consumer supplies only the domain and the deployment shell: the schema,
 * which datasets, the engine writer per type, and (optionally) the
 * SPARQL/import adapter, provenance and reporting.
 *
 * ```ts
 * const pipeline = searchIndexerPipeline({
 *   schema,
 *   datasets,
 *   distributionResolver: new ImportResolver(new SparqlDistributionResolver(), {
 *     ...createQlever({ mode: 'docker', image: 'adfreiburg/qlever:latest' }),
 *     strategy: 'import',
 *   }),
 *   writerFor: (searchType) => new InPlaceRebuild(typesenseClient, searchType),
 * });
 * await pipeline.run();
 * ```
 *
 * A deployment that needs more – a bespoke root selector (the entry point is a
 * domain fact, not a class), per-stage tuning (`batchSize`, `maxConcurrency`),
 * non-SPARQL readers, or quad-level plugins – composes {@link searchStages},
 * {@link searchIndexWriter} and {@link Pipeline} directly; this convenience
 * owns no capability of its own.
 */
export function searchIndexerPipeline(
  options: SearchIndexerPipelineOptions,
): Pipeline<TypedSearchDocument> {
  const { schema, datasets } = options;
  return new Pipeline<TypedSearchDocument>({
    datasetSelector: Array.isArray(datasets)
      ? new ManualDatasetSelection(datasets)
      : datasets,
    distributionResolver: options.distributionResolver,
    stages: searchStages({
      schema,
      types: [...schema.values()].map((searchType) => ({
        searchType,
        rootVariable: 'root',
        itemSelector: selectByClass(searchType),
      })),
    }),
    writers: searchIndexWriter({ schema, writerFor: options.writerFor }),
    provenanceStore: options.provenanceStore,
    pipelineVersion: options.pipelineVersion,
    reporter: options.reporter,
  });
}
