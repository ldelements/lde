# @lde/distribution-health

Derives a distribution’s **usability** from two separately-produced signals: **reachability** – can the distribution be fetched? – and **validity** – does the fetched content actually parse as RDF? This is a pure leaf: it _interprets_ the raw results of `@lde/distribution-probe` and `@lde/sparql-importer` rather than producing them.

## Installation

```sh
npm install @lde/distribution-health
```

## Documentation

See the [full documentation](https://ldelements.org/reference/distribution-health).
