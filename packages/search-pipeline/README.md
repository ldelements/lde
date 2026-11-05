# @lde/search-pipeline

Search indexing as an [`@lde/pipeline`](../pipeline) Configurable Pipeline
instance: this package supplies the glue between the pipeline’s quad world
and a search engine’s document world, so indexing reuses the existing spine –
Discovery → Selection → Iteration → change-gate (skip-unchanged) – instead of
rebuilding it per consumer.

## Installation

```sh
npm install @lde/search-pipeline
```

## Documentation

See the [full documentation](https://ldelements.org/reference/search-pipeline).
