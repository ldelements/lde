# When to use LDE

LDE fits when your transformation problems are SPARQL-shaped and you want to avoid lock-in: transformations are plain SPARQL query files that run against any SPARQL 1.1 endpoint, with TypeScript only for the parts SPARQL cannot express. If your needs centre on one-off RML mappings or LDES ingestion, one of the alternatives below may serve you better.

## Comparison

|                       | **LD Elements**           | **[TriplyETL](https://docs.triply.cc/triply-etl/)** | **[rdf-connect](https://rdf-connect.github.io)** | **[OpenLDES / LDI](https://informatievlaanderen.github.io/VSDS-Linked-Data-Interactions/)** |
| --------------------- | ------------------------- | --------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **Focus**             | SPARQL-native pipelines   | RDF ETL platform                                    | RDF stream processing                            | LDES ingestion & publication                                                                |
| **Pipeline language** | SPARQL + TypeScript       | TypeScript DSL                                      | Declarative (RML)                                | YAML (Spring Boot)                                                                          |
| **Lock-in**           | None – plain SPARQL files | Proprietary platform                                | Framework-specific                               | Framework-specific                                                                          |
| **License**           | MIT                       | Proprietary                                         | MIT                                              | EUPL-1.2                                                                                    |
