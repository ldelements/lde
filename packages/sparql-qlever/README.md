# SPARQL QLever

An adapter for the [QLever](https://github.com/ad-freiburg/qlever) SPARQL server.

## Index caching

Building a QLever index is slow. To avoid rebuilding it on every pipeline run, the importer caches a single index and reuses it when the source data hasn't changed. On subsequent runs, indexing is skipped when the source file matches and hasn't been re-downloaded.

Only **one** index is cached at a time. In a multi-dataset pipeline, each dataset overwrites the previous index. On re-run, the last-indexed dataset gets a cache hit while the others rebuild.

Caching is enabled by default. Disable it by passing `cacheIndex: false` to `createQlever()` or the `Importer` constructor (e.g. driven by a `QLEVER_CACHE_INDEX=false` environment variable).

## Configuration

`createQlever()` accepts `indexOptions` and `serverOptions` to tune QLever's index builder and server respectively.

### Server options (`serverOptions`)

Passed to `qlever-server` at startup.

| Option                  | Description                                      | Default |
| ----------------------- | ------------------------------------------------ | ------- |
| `memory-max-size`       | Maximum memory for query processing and caching. | `'4G'`  |
| `default-query-timeout` | Default query timeout.                           | `'30s'` |
| `cache-max-size`        | Maximum cache size for query results.            | –       |

Example:

```ts
const { importer, server } = createQlever({
  mode: 'docker',
  image: 'adfreiburg/qlever:latest',
  serverOptions: {
    'memory-max-size': '12G',
    'default-query-timeout': '120s',
  },
});
```

### Index options (`indexOptions`)

Passed to `qlever-index` during import.

| Option                          | Description                                                                                   | Default     |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| `ascii-prefixes-only`           | Enable faster parsing for well-behaved TTL files.                                             | `true`      |
| `num-triples-per-batch`         | Triples per batch; lower values reduce memory usage.                                          | `3_000_000` |
| `stxxl-memory`                  | Memory budget for sorting during the index build.                                             | `'10G'`     |
| `parallel-parsing`              | Parse input in parallel.                                                                      | `true`      |
| `only-pso-and-pos-permutations` | Build only PSO and POS permutations. Faster, but queries with predicate variables won't work. | `false`     |
