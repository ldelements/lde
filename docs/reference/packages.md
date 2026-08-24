# Packages

All packages are published to npm under the `@lde` scope. Each package name links to its reference page.

## Discovery

Find and retrieve dataset descriptions from registries.

| Package                                                   | Description                                               |
| --------------------------------------------------------- | --------------------------------------------------------- |
| [@lde/dataset](./dataset)                                 | Core dataset and distribution objects                     |
| [@lde/dataset-registry-client](./dataset-registry-client) | Retrieve dataset descriptions from DCAT-AP 3.0 registries |

## Processing

Transform, enrich and analyse datasets with SPARQL pipelines.

| Package                                                     | Description                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| [@lde/pipeline](./pipeline)                                 | Build pipelines that query, transform and enrich Linked Data       |
| [@lde/pipeline-shacl-sampler](./pipeline-shacl-sampler)     | Per-class sampling stages derived from SHACL shapes                |
| [@lde/pipeline-shacl-validator](./pipeline-shacl-validator) | SHACL validation for pipeline stages                               |
| [@lde/pipeline-void](./pipeline-void)                       | VoID statistical analysis for RDF datasets                         |
| [@lde/distribution-downloader](./distribution-downloader)   | Download distributions for local processing                        |
| [@lde/distribution-health](./distribution-health)           | Derive distribution usability from reachability and RDF validity   |
| [@lde/distribution-probe](./distribution-probe)             | Probe distributions for availability and metadata                  |
| [@lde/iiif-validator](./iiif-validator)                     | Validate that a URL resolves to a valid IIIF Presentation Manifest |
| [@lde/resolver](./resolver)                                 | Resolve external references with a durable store, bounds and retry |
| [@lde/sparql-importer](./sparql-importer)                   | Import data dumps to a local SPARQL endpoint for querying          |

## Publication

Serve and document your data.

| Package                                         | Description                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [@lde/fastify-rdf](./fastify-rdf)               | Fastify plugin for RDF content negotiation and request body parsing                                                                                                            |
| [@lde/docgen](./docgen)                         | Generate documentation from RDF such as SHACL shapes                                                                                                                           |
| [@lde/search](./search)                         | The search core: projects RDF into engine-agnostic search documents (framing + a declarative field spec)                                                                       |
| [@lde/search-api-graphql](./search-api-graphql) | Engine- and domain-agnostic GraphQL surface for search: builds an executable GraphQL schema from a SearchSchema at runtime and serves it as a framework-agnostic fetch handler |
| [@lde/search-api-server](./search-api-server)   | The served search API as a bootable process and prebuilt Docker image                                                                                                          |
| [@lde/search-indexer](./search-indexer)         | The search indexer as a bootable process and prebuilt Docker image                                                                                                             |
| [@lde/search-pipeline](./search-pipeline)       | Applies the @lde/search projection inside an @lde/pipeline run                                                                                                                 |
| [@lde/search-typesense](./search-typesense)     | Typesense engine adapter: transactional Blue/green and In-place rebuild writers                                                                                                |
| [@lde/text-normalization](./text-normalization) | Text folding (diacritic stripping and transliteration) for search index and query normalization                                                                                |

## Monitoring

Observe pipeline runs and endpoint health.

| Package                                                       | Description                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [@lde/distribution-monitor](./distribution-monitor)           | Monitor DCAT distributions (SPARQL endpoints and data dumps) with periodic probes |
| [@lde/pipeline-console-reporter](./pipeline-console-reporter) | Console progress reporter for pipelines                                           |

## Infrastructure

Manage SPARQL servers and run tasks.

| Package                                               | Description                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| [@lde/host-limiter](./host-limiter)                   | Concurrent map bounded by a global and a per-host cap             |
| [@lde/local-sparql-endpoint](./local-sparql-endpoint) | Quickly start a local SPARQL endpoint for testing and development |
| [@lde/sparql-server](./sparql-server)                 | Start, stop and control SPARQL servers                            |
| [@lde/sparql-qlever](./sparql-qlever)                 | QLever SPARQL adapter for importing and serving data              |
| [@lde/wait-for-sparql](./wait-for-sparql)             | Wait for a SPARQL endpoint to become available                    |
| [@lde/task-runner](./task-runner)                     | Task runner core classes and interfaces                           |
| [@lde/task-runner-docker](./task-runner-docker)       | Run tasks in Docker containers                                    |
| [@lde/task-runner-native](./task-runner-native)       | Run tasks natively on the host system                             |
