# Reference

Reference material is **information-oriented**: technical descriptions of LDE’s machinery, for looking things up.

- [Packages](./packages) – all `@lde/*` packages, grouped by lifecycle phase.
- **Decisions** (in the sidebar) – the architecture decision records, documenting each significant design choice and its rationale.

Each package has its own reference page documenting its API and options in detail; the [packages](./packages) page links to all of them. All exported APIs additionally carry JSDoc, so your editor shows inline documentation as you use them.

## Standards

LDE builds on open standards throughout:

| Standard                                                              | Usage                                                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [DCAT-AP 3.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/) (EU) | Dataset discovery and registry queries                                                                                                        |
| [SPARQL 1.1](https://www.w3.org/TR/sparql11-query/)                   | Data transformations, dataset queries and endpoint management                                                                                 |
| [SHACL](https://www.w3.org/TR/shacl/)                                 | Per-class sampling (`@lde/pipeline-shacl-sampler`), validation (`@lde/pipeline-shacl-validator`) and documentation generation (`@lde/docgen`) |
| [VoID](https://www.w3.org/TR/void/)                                   | Statistical analysis of RDF datasets (`@lde/pipeline-void`)                                                                                   |
| [RDF/JS](https://rdf.js.org/)                                         | Internal data model (N3)                                                                                                                      |
| [LDES](https://semiceu.github.io/LinkedDataEventStreams/) (EU)        | Event stream consumption and publication (planned)                                                                                            |
