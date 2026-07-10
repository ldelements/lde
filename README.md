# LDE – Linked Data Elements

**Shared building blocks for the full Linked Data lifecycle.**

[![CI](https://github.com/ldelements/lde/actions/workflows/ci.yml/badge.svg)](https://github.com/ldelements/lde/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Every organization working with Linked Data ends up building the same infrastructure from scratch:
endpoint management, data import, transformation pipelines, dataset discovery.

**LDE** covers the **full Linked Data lifecycle** – from discovery and ingestion through transformation to publication –
as an **open-source toolkit of composable building blocks** for Node.js.

Data transformations are expressed as plain SPARQL queries: portable, transparent and free of vendor lock-in.

## Key capabilities

- **Discover** datasets from DCAT-AP 3.0 registries.
- **Download** and import data dumps to a local SPARQL endpoint for querying.
- **Transform** datasets with pure SPARQL CONSTRUCT queries: composable stages with fan-out item selection.
- **Analyze** datasets with VoID statistics and SPARQL monitoring.
- **Publish** results to SPARQL endpoints or local files.
- **Serve** RDF data over HTTP with content negotiation (Fastify plugin).

## Standards

| Standard                                                              | Usage                                                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [DCAT-AP 3.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/) (EU) | Dataset discovery and registry queries                                                                                                        |
| [SPARQL 1.1](https://www.w3.org/TR/sparql11-query/)                   | Data transformations, dataset queries and endpoint management                                                                                 |
| [SHACL](https://www.w3.org/TR/shacl/)                                 | Per-class sampling (`@lde/pipeline-shacl-sampler`), validation (`@lde/pipeline-shacl-validator`) and documentation generation (`@lde/docgen`) |
| [VoID](https://www.w3.org/TR/void/)                                   | Statistical analysis of RDF datasets (`@lde/pipeline-void`)                                                                                   |
| [RDF/JS](https://rdf.js.org/)                                         | Internal data model (N3)                                                                                                                      |
| [LDES](https://semiceu.github.io/LinkedDataEventStreams/) (EU)        | Event stream consumption and publication (planned)                                                                                            |

## Quick example

```typescript
import {
  Pipeline,
  Stage,
  SparqlConstructReader,
  SparqlItemSelector,
  SparqlUpdateWriter,
  ManualDatasetSelection,
} from '@lde/pipeline';

const pipeline = new Pipeline({
  datasetSelector: new ManualDatasetSelection([dataset]),
  stages: [
    new Stage({
      name: 'per-class',
      itemSelector: new SparqlItemSelector({
        query: 'SELECT DISTINCT ?class WHERE { ?s a ?class }',
      }),
      readers: new SparqlConstructReader({
        query:
          'CONSTRUCT { ?class a <http://example.org/Class> } WHERE { ?s a ?class }',
      }),
    }),
  ],
  writers: new SparqlUpdateWriter({
    endpoint: new URL('http://localhost:7200/repositories/lde/statements'),
  }),
});

await pipeline.run();
```

## Packages

<table>
<tr><th colspan="3" align="left">Discovery – Find and retrieve dataset descriptions from registries</th></tr>
<tr>
  <td><a href="packages/dataset">@lde/dataset</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/dataset"><img src="https://img.shields.io/npm/v/@lde/dataset" alt="npm"></a></td>
  <td>Core dataset and distribution objects</td>
</tr>
<tr>
  <td><a href="packages/dataset-registry-client">@lde/dataset-registry-client</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/dataset-registry-client"><img src="https://img.shields.io/npm/v/@lde/dataset-registry-client" alt="npm"></a></td>
  <td>Retrieve dataset descriptions from DCAT-AP 3.0 registries</td>
</tr>
<tr><th colspan="3" align="left">Processing – Transform, enrich and analyse datasets with SPARQL pipelines</th></tr>
<tr>
  <td><a href="packages/pipeline">@lde/pipeline</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/pipeline"><img src="https://img.shields.io/npm/v/@lde/pipeline" alt="npm"></a></td>
  <td>Build pipelines that query, transform and enrich Linked Data</td>
</tr>
<tr>
  <td><a href="packages/pipeline-shacl-sampler">@lde/pipeline-shacl-sampler</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/pipeline-shacl-sampler"><img src="https://img.shields.io/npm/v/@lde/pipeline-shacl-sampler" alt="npm"></a></td>
  <td>Per-class sampling stages derived from SHACL shapes</td>
</tr>
<tr>
  <td><a href="packages/pipeline-shacl-validator">@lde/pipeline-shacl-validator</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/pipeline-shacl-validator"><img src="https://img.shields.io/npm/v/@lde/pipeline-shacl-validator" alt="npm"></a></td>
  <td>SHACL validation for pipeline stages</td>
</tr>
<tr>
  <td><a href="packages/pipeline-void">@lde/pipeline-void</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/pipeline-void"><img src="https://img.shields.io/npm/v/@lde/pipeline-void" alt="npm"></a></td>
  <td>VoID statistical analysis for RDF datasets</td>
</tr>
<tr>
  <td><a href="packages/distribution-downloader">@lde/distribution-downloader</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/distribution-downloader"><img src="https://img.shields.io/npm/v/@lde/distribution-downloader" alt="npm"></a></td>
  <td>Download distributions for local processing</td>
</tr>
<tr>
  <td><a href="packages/distribution-health">@lde/distribution-health</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/distribution-health"><img src="https://img.shields.io/npm/v/@lde/distribution-health" alt="npm"></a></td>
  <td>Derive distribution usability from reachability and RDF validity</td>
</tr>
<tr>
  <td><a href="packages/distribution-probe">@lde/distribution-probe</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/distribution-probe"><img src="https://img.shields.io/npm/v/@lde/distribution-probe" alt="npm"></a></td>
  <td>Probe distributions for availability and metadata</td>
</tr>
<tr>
  <td><a href="packages/iiif-validator">@lde/iiif-validator</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/iiif-validator"><img src="https://img.shields.io/npm/v/@lde/iiif-validator" alt="npm"></a></td>
  <td>Validate that a URL resolves to a valid IIIF Presentation Manifest</td>
</tr>
<tr>
  <td><a href="packages/sparql-importer">@lde/sparql-importer</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/sparql-importer"><img src="https://img.shields.io/npm/v/@lde/sparql-importer" alt="npm"></a></td>
  <td>Import data dumps to a local SPARQL endpoint for querying</td>
</tr>
<tr><th colspan="3" align="left">Publication – Serve and document your data</th></tr>
<tr>
  <td><a href="packages/fastify-rdf">@lde/fastify-rdf</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/fastify-rdf"><img src="https://img.shields.io/npm/v/@lde/fastify-rdf" alt="npm"></a></td>
  <td>Fastify plugin for RDF content negotiation and request body parsing</td>
</tr>
<tr>
  <td><a href="packages/docgen">@lde/docgen</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/docgen"><img src="https://img.shields.io/npm/v/@lde/docgen" alt="npm"></a></td>
  <td>Generate documentation from RDF such as SHACL shapes</td>
</tr>
<tr>
  <td><a href="packages/search">@lde/search</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/search"><img src="https://img.shields.io/npm/v/@lde/search" alt="npm"></a></td>
  <td>The search core: projects RDF into engine-agnostic search documents (framing + a declarative field spec)</td>
</tr>
<tr>
  <td><a href="packages/search-api-graphql">@lde/search-api-graphql</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/search-api-graphql"><img src="https://img.shields.io/npm/v/@lde/search-api-graphql" alt="npm"></a></td>
  <td>Engine- and domain-agnostic GraphQL surface for search: builds an executable GraphQL schema from a SearchSchema at runtime, one root query field per type</td>
</tr>
<tr>
  <td><a href="packages/search-pipeline">@lde/search-pipeline</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/search-pipeline"><img src="https://img.shields.io/npm/v/@lde/search-pipeline" alt="npm"></a></td>
  <td>Applies the @lde/search projection inside an @lde/pipeline run, fanning each document out to the transactional engine writer for its type’s collection (owns no projection itself)</td>
</tr>
<tr>
  <td><a href="packages/search-typesense">@lde/search-typesense</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/search-typesense"><img src="https://img.shields.io/npm/v/@lde/search-typesense" alt="npm"></a></td>
  <td>Typesense engine adapter: transactional Blue/green (build fresh, swap atomically) and In-place (update the live index) rebuild writers</td>
</tr>
<tr>
  <td><a href="packages/text-normalization">@lde/text-normalization</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/text-normalization"><img src="https://img.shields.io/npm/v/@lde/text-normalization" alt="npm"></a></td>
  <td>Text folding (diacritic stripping and transliteration) for search index and query normalization</td>
</tr>
<tr><th colspan="3" align="left">Monitoring – Observe pipeline runs and endpoint health</th></tr>
<tr>
  <td><a href="packages/distribution-monitor">@lde/distribution-monitor</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/distribution-monitor"><img src="https://img.shields.io/npm/v/@lde/distribution-monitor" alt="npm"></a></td>
  <td>Monitor DCAT distributions (SPARQL endpoints and data dumps) with periodic probes</td>
</tr>
<tr>
  <td><a href="packages/pipeline-console-reporter">@lde/pipeline-console-reporter</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/pipeline-console-reporter"><img src="https://img.shields.io/npm/v/@lde/pipeline-console-reporter" alt="npm"></a></td>
  <td>Console progress reporter for pipelines</td>
</tr>
<tr><th colspan="3" align="left">Infrastructure – Manage SPARQL servers and run tasks</th></tr>
<tr>
  <td><a href="packages/local-sparql-endpoint">@lde/local-sparql-endpoint</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/local-sparql-endpoint"><img src="https://img.shields.io/npm/v/@lde/local-sparql-endpoint" alt="npm"></a></td>
  <td>Quickly start a local SPARQL endpoint for testing and development</td>
</tr>
<tr>
  <td><a href="packages/sparql-server">@lde/sparql-server</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/sparql-server"><img src="https://img.shields.io/npm/v/@lde/sparql-server" alt="npm"></a></td>
  <td>Start, stop and control SPARQL servers</td>
</tr>
<tr>
  <td><a href="packages/sparql-qlever">@lde/sparql-qlever</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/sparql-qlever"><img src="https://img.shields.io/npm/v/@lde/sparql-qlever" alt="npm"></a></td>
  <td>QLever SPARQL adapter for importing and serving data</td>
</tr>
<tr>
  <td><a href="packages/wait-for-sparql">@lde/wait-for-sparql</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/wait-for-sparql"><img src="https://img.shields.io/npm/v/@lde/wait-for-sparql" alt="npm"></a></td>
  <td>Wait for a SPARQL endpoint to become available</td>
</tr>
<tr>
  <td><a href="packages/task-runner">@lde/task-runner</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/task-runner"><img src="https://img.shields.io/npm/v/@lde/task-runner" alt="npm"></a></td>
  <td>Task runner core classes and interfaces</td>
</tr>
<tr>
  <td><a href="packages/task-runner-docker">@lde/task-runner-docker</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/task-runner-docker"><img src="https://img.shields.io/npm/v/@lde/task-runner-docker" alt="npm"></a></td>
  <td>Run tasks in Docker containers</td>
</tr>
<tr>
  <td><a href="packages/task-runner-native">@lde/task-runner-native</a></td>
  <td><a href="https://www.npmjs.com/package/@lde/task-runner-native"><img src="https://img.shields.io/npm/v/@lde/task-runner-native" alt="npm"></a></td>
  <td>Run tasks natively on the host system</td>
</tr>
</table>

## Architecture

```mermaid
graph TD
  subgraph Discovery
    dataset
    dataset-registry-client --> dataset
  end

  subgraph Processing
    pipeline --> dataset-registry-client
    pipeline --> sparql-server
    pipeline --> sparql-importer
    pipeline-shacl-sampler --> pipeline
    pipeline-shacl-validator --> pipeline
    pipeline-void --> pipeline
    distribution-downloader --> dataset
    distribution-probe --> dataset
    pipeline --> distribution-probe
    sparql-importer --> dataset
    distribution-health --> distribution-probe
    distribution-health --> sparql-importer
  end

  subgraph Publication
    fastify-rdf
    docgen
    search --> text-normalization
    search-api-graphql --> search
    search-typesense --> search
    search-typesense --> text-normalization
    search-typesense --> pipeline
    search-pipeline --> search
    search-pipeline --> pipeline
  end

  subgraph Monitoring
    pipeline-console-reporter --> pipeline
    distribution-monitor --> distribution-probe
  end

  subgraph Infrastructure
    sparql-qlever --> sparql-importer
    sparql-qlever --> sparql-server
    sparql-qlever --> task-runner-docker
    task-runner-docker --> task-runner
    task-runner-native --> task-runner
    sparql-server
    local-sparql-endpoint
    wait-for-sparql
  end
```

## Who uses LD Elements

<a href="https://netwerkdigitaalerfgoed.nl/en/"><img src="https://github.com/netwerk-digitaal-erfgoed.png?size=40" width="20" valign="middle"></a>&ensp;<a href="https://netwerkdigitaalerfgoed.nl/en/">Netwerk Digitaal Erfgoed</a> — Dutch national digital heritage infrastructure, commissioned by the Ministry of Education, Culture and Science

<a href="https://dc4eu.nl"><img src="https://dc4eu.nl/wp-content/uploads/2022/01/logo.png" width="20" valign="middle"></a>&ensp;<a href="https://dc4eu.nl">DC4EU</a> — Dutch Collections for Europe, the accredited national aggregator connecting Dutch heritage institutions with Europeana

<a href="https://hklimburg.nl/nieuws/linked-open-limburg">Linked Open Limburg</a> — Coöperatie Erfgoed Limburg’s regional heritage programme, built on LDE’s pipeline components

## Comparison

|                       | **LD Elements**           | **[TriplyETL](https://docs.triply.cc/triply-etl/)** | **[rdf-connect](https://rdf-connect.github.io)** | **[OpenLDES / LDI](https://informatievlaanderen.github.io/VSDS-Linked-Data-Interactions/)** |
| --------------------- | ------------------------- | --------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **Focus**             | SPARQL-native pipelines   | RDF ETL platform                                    | RDF stream processing                            | LDES ingestion & publication                                                                |
| **Pipeline language** | SPARQL + TypeScript       | TypeScript DSL                                      | Declarative (RML)                                | YAML (Spring Boot)                                                                          |
| **Lock-in**           | None – plain SPARQL files | Proprietary platform                                | Framework-specific                               | Framework-specific                                                                          |
| **License**           | MIT                       | Proprietary                                         | MIT                                              | EUPL-1.2                                                                                    |

## Development

Prerequisites: Node.js (LTS) and npm.

```sh
npm install
npx nx run-many -t build
npx nx run-many -t test
npx nx affected -t lint test typecheck build  # only changed packages
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow.

## License

MIT – see [LICENSE](LICENSE).

## Acknowledgements

LD Elements originated at the [Dutch national infrastructure for digital heritage](https://netwerkdigitaalerfgoed.nl/en/) (NDE).
