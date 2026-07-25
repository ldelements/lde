# @lde/sparql-importer

Import RDF data dumps to a local SPARQL endpoint. This is useful when:

- the dataset does not offer a SPARQL endpoint itself
- or when it does but the endpoint is too slow or unreliable, particularly for more complex SPARQL queries.

## Installation

```sh
npm install @lde/sparql-importer
```

This package is **interface-only**: it defines the `Importer` contract and its
result types (`ImportSuccessful`, `ImportFailed`, `NotSupported`) that pipeline
components program against. It ships no importer of its own.

## The `Importer` contract

`import(distributions)` picks the **first** distribution whose format the importer
supports, downloads it, and indexes it. It resolves to one of three results:

- `ImportSuccessful` – with the imported `distribution`, an optional `identifier`
  (e.g. the index name), an optional `tripleCount`, and any `warnings` collected
  along the way;
- `ImportFailed` – with the `distribution` that failed and the `error` message;
- `NotSupported` – when none of the distributions use a supported format
  (`distribution` is then optional).

## `ImporterOptions`

Store-agnostic options shared by all `Importer` implementations:

- `taskRunner` (required) – the [`@lde/task-runner`](./task-runner) that executes
  the import work;
- `downloader` (optional) – an [`@lde/distribution-downloader`](./distribution-downloader)
  `Downloader` for fetching the distribution; plug in a custom one for different
  caching or authentication;
- `cacheIndex` (optional, default `true`) – cache indices and skip re-indexing
  when source data is unchanged.

The concrete adapter is [`@lde/sparql-qlever`](./sparql-qlever), whose
`Importer` downloads a distribution and builds a
[QLever](https://github.com/ad-freiburg/qlever) index from it, and whose
`createQlever` pairs it with a matching
[`@lde/sparql-server`](./sparql-server) `Server` for use in an
[`@lde/pipeline`](./pipeline) `ImportResolver`.
