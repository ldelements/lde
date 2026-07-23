# SPARQL Server

Start, stop and control SPARQL servers with a simple API.

This package is **interface-only**: it defines the `SparqlServer` contract
(`start()`, `stop()`, `queryEndpoint`) that pipeline components program
against. It ships no server of its own.

The concrete adapter is [`@lde/sparql-qlever`](../sparql-qlever), whose
`Server` runs a [QLever](https://github.com/ad-freiburg/qlever) instance
(Docker or native) and whose `createQlever` pairs it with a matching
[`@lde/sparql-importer`](../sparql-importer) `Importer` for use in an
[`@lde/pipeline`](../pipeline) `ImportResolver`.
