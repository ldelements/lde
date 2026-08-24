# @lde/sparql-qlever

An adapter for the [QLever](https://github.com/ad-freiburg/qlever) SPARQL server.

## Installation

```sh
npm install @lde/sparql-qlever
```

## `createQlever()`

`createQlever()` returns a paired `{ importer, server }` that share a single task runner – and therefore the same Docker container or working directory – so the server can serve the index the importer built.

| Option          | Default                               | Description                                                                                                                   |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mode`          | –                                     | `'docker'` or `'native'`; see below.                                                                                          |
| `image`         | –                                     | (docker mode, required) Docker image to run QLever from, e.g. `adfreiburg/qlever:latest`.                                     |
| `containerName` | –                                     | (docker mode) Name for the container; a previous container with the same name is removed on `run()`.                          |
| `network`       | –                                     | (docker mode, requires `containerName`) Docker network the QLever containers join; see [Networking](#networking-docker-mode). |
| `dataDir`       | –                                     | Directory where downloaded data files and the index are stored. **Must be absolute in docker mode.**                          |
| `indexName`     | `'data'`                              | Base name of the QLever index files.                                                                                          |
| `port`          | `7001`                                | Port the SPARQL server listens on. In docker mode, bound to the same port number on the host.                                 |
| `downloader`    | `new LastModifiedDownloader(dataDir)` | [`Downloader`](https://github.com/ldelements/lde/tree/main/packages/distribution-downloader) used to fetch distributions.     |
| `cacheIndex`    | `true`                                | Cache QLever indices and skip re-indexing when source data is unchanged. See [Index caching](#index-caching).                 |
| `indexOptions`  | –                                     | Options for `qlever-index`. See [Index options](#index-options-indexoptions).                                                 |
| `serverOptions` | –                                     | Options for `qlever-server`. See [Server options](#server-options-serveroptions).                                             |

### Docker mode

Docker mode runs `qlever-index` and `qlever-server` in containers created from `image`, with `dataDir` bind-mounted at `/mount`.

> [!WARNING]
> In docker mode, `dataDir` **must be an absolute path**. The path is passed verbatim to the Docker bind mount (`<dataDir>:/mount`), and Docker interprets a relative bind source as a named _volume_ rather than a host directory. The downloader, by contrast, resolves relative paths against the process working directory – so the download succeeds on the host while the container sees an empty `/mount`, and the import fails cryptically (missing file, 0 triples indexed) instead of erroring on the path ([ldelements/lde#638](https://github.com/ldelements/lde/issues/638)).

### Networking (docker mode)

By default docker mode publishes QLever’s port on the host and addresses the query endpoint as `localhost` – correct when the consumer runs on the host, or shares the QLever container’s network namespace. A consumer that itself runs in a container on a bridge network cannot reach a host-published port; pass `network` (a Docker network the consumer is attached to) together with `containerName`, and QLever joins that network with the endpoint addressed by container name instead – no host port is claimed:

```ts
const { importer, server } = createQlever({
  mode: 'docker',
  image: 'adfreiburg/qlever:latest',
  network: 'app_default',
  containerName: 'qlever',
  dataDir: '/data',
});
// Query endpoint: http://qlever:7001/sparql
```

Passing `network` without `containerName` is a compile error – the endpoint hostname is the container name.

### Native mode

Native mode runs the same commands directly on the host, with `dataDir` as the working directory (defaulting to the current working directory). It requires:

- the `qlever-index` and `qlever-server` binaries on `PATH`;
- a POSIX shell with `cat` and `gunzip` (commands run with `shell: true`), plus `unzip` for zip-compressed distributions.

## Supported formats

The importer accepts distributions with these media types, in preference order – candidates are tried in this order and the first successful import wins:

1. `application/n-quads`
2. `application/n-triples`
3. `text/turtle`
4. `application/ld+json`
5. `application/rdf+xml`
6. `application/trig`

N-Quads, N-Triples and Turtle are QLever’s native index formats and are fed to `qlever-index` directly. JSON-LD, RDF/XML and TriG are preprocessed Node-side into N-Quads first (streamed, so memory stays bounded), which is why the native formats are preferred; TriG comes last so a streaming native dump wins whenever a dataset offers both.

Compression:

- **gzip** is handled transparently, detected from the file’s magic bytes rather than from declared metadata. Publishers routinely omit `compressFormat`, and a dump served behind a query string leaves the downloaded file without a `.gz` suffix – so the bytes are the only signal that always holds.
- **zip** requires the inner RDF format to be declared as the distribution’s `mediaType`, with `application/zip` appearing only as its `compressFormat`. A distribution whose `mediaType` is `application/zip` alone is rejected as `NotSupported` – the importer cannot know what is inside. Every parseable zip entry is folded into the output; entries that fail to parse (sidecars, OS metadata) are skipped with a warning.

For native formats, the actual `qlever-index` format flag is resolved by priority: the server’s `Content-Type` response header first, then the file extension, then the declared media type as a last resort. A mismatch between these produces a warning on `ImportSuccessful.warnings`.

An import that indexes **0 triples** – fresh or from cache – is treated as `ImportFailed`, not success.

## Direct construction

`createQlever()` is a convenience; construct `Importer` and `Server` directly to supply your own task runner:

- `new Importer(options: QleverImporterOptions)` – `taskRunner` (required), `indexName` (default `'data'`), `downloader` (default `new LastModifiedDownloader()`), `cacheIndex` (default `true`), and `qleverOptions` (the [index options](#index-options-indexoptions)).
- `new Server({ taskRunner, indexName, port, qleverOptions })` – `taskRunner` and `indexName` required, `port` default `7001`, `qleverOptions` the [server options](#server-options-serveroptions).

`Server.queryEndpoint` is `http://localhost:<port>/sparql`. `Server.start()` launches `qlever-server` and blocks until the endpoint answers a probe query (via [`@lde/wait-for-sparql`](./wait-for-sparql)).

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
