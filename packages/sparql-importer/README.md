# SPARQL Importer

Import RDF data dumps to a local SPARQL endpoint. This is useful when:

- the dataset does not offer a SPARQL endpoint itself
- or when it does but the endpoint is too slow or unreliable, particularly for more complex SPARQL queries.

This package is **interface-only**: it defines the `Importer` contract and its
result types (`ImportSuccessful`, `ImportFailed`, `NotSupported`) that pipeline
components program against. It ships no importer of its own.

The concrete adapter is [`@lde/sparql-qlever`](../sparql-qlever), whose
`Importer` downloads a distribution and builds a
[QLever](https://github.com/ad-freiburg/qlever) index from it, and whose
`createQlever` pairs it with a matching
[`@lde/sparql-server`](../sparql-server) `Server` for use in an
[`@lde/pipeline`](../pipeline) `ImportResolver`.
