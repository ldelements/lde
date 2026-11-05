# @lde/sparql-importer

Import RDF data dumps to a local SPARQL endpoint. This package is **interface-only**: it defines the `Importer` contract and its
`ImportResult` union (`ImportSuccessful`, `ImportFailed`, `NotSupported`, told
apart by their `type`) that pipeline components program against. It ships no
importer of its own.

## Installation

```sh
npm install @lde/sparql-importer
```

## Documentation

See the [full documentation](https://ldelements.org/reference/sparql-importer).
