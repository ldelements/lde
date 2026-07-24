# @lde/search-indexer

The [@lde/search-pipeline](../search-pipeline) indexer as a bootable process
and prebuilt Docker image: mount a schema-declaration module, point it at a
dataset registry and Typesense, and one run selects the datasets, extracts and
projects each root type per the schema, and rebuilds the engine collections –
then exits. Run it as a cron job; the rebuild writers’ cross-pod lock makes an
overlapping run fail fast instead of corrupting a collection.

This is the write-path counterpart of
[`@lde/search-api-server`](../search-api-server)
([#652](https://github.com/ldelements/lde/issues/652)): the composition layer
that binds the engine-agnostic `searchIndexerPipeline` to the
[`@lde/search-typesense`](../search-typesense) rebuild writers. Mount the
**same schema module** into both images and point both at the same
`TYPESENSE_*` coordinates, and the write and the read side cannot disagree
about the schema. A deployment that needs more – a bespoke root selector,
per-stage tuning, another engine – composes `searchStages`,
`searchIndexWriter` and `Pipeline` directly instead.

## Run

```sh
docker run --rm \
  --volume ./search-schema.mjs:/config/search-schema.mjs:ro \
  --env REGISTRY_ENDPOINT=https://registry.example.org/sparql \
  --env TYPESENSE_HOST=typesense.internal \
  --env TYPESENSE_API_KEY=admin-key \
  ghcr.io/ldelements/search-indexer
```

Or without Docker (the same environment variables apply):

```sh
npx @lde/search-indexer
```

Dataset IRIs can also be passed as arguments, which override `DATASETS`:

```sh
npx @lde/search-indexer https://example.org/id/dataset/1
```

`--check` validates the configuration and schema module, then exits without
indexing – for CI and init containers.

## The schema module

The mounted module default-exports the deployment’s search type declarations
as **plain data** – see [the API server’s
README](../search-api-server/README.md#the-schema-module) for the format and
authoring guidance; both images load the module with the same
`@lde/search/module` loader. The indexer reads only the default export: the
declarations drive one pipeline stage and one engine collection per root type,
and each field’s `path` drives the extraction CONSTRUCT. The read-side extras
(`schemaOptions`, `engineOptions`) are ignored here, so one file serves both
images.

## Configuration

| Variable             | Default                     | Meaning                                                                      |
| -------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `SCHEMA_MODULE`      | `/config/search-schema.mjs` | Path of the mounted schema-declaration module                                |
| `REGISTRY_ENDPOINT`  | **required**                | SPARQL endpoint of the DCAT dataset registry                                 |
| `DATASETS`           | all registry datasets       | Dataset IRIs to index (whitespace- or comma-separated)                       |
| `DATASET_CRITERIA`   | all registry datasets       | Registry search criteria as a JSON object (mutually exclusive w/ `DATASETS`) |
| `TYPESENSE_HOST`     | **required**                | Typesense host                                                               |
| `TYPESENSE_PORT`     | `8108`                      | Typesense port                                                               |
| `TYPESENSE_PROTOCOL` | `http`                      | `http` or `https`                                                            |
| `TYPESENSE_API_KEY`  | **required**                | An admin key: the indexer creates, writes and swaps collections              |
| `REBUILD_MODE`       | `in-place`                  | `in-place` (update the live collection) or `blue-green` (swap on commit)     |
| `COLLECTION_PREFIX`  | none                        | Prefix for every derived collection name (configure the read side to match)  |
| `PROVENANCE_FILE`    | none                        | JSON file remembering per-dataset processing, to skip unchanged datasets     |
| `PIPELINE_VERSION`   | none                        | Version keying the skip decisions; required with `PROVENANCE_FILE`           |
| `QLEVER_IMAGE`       | none                        | Enables the QLever import path (see below), e.g. `adfreiburg/qlever:latest`  |
| `IMPORT_STRATEGY`    | `sparql`                    | `sparql`, `sparqlWithImportFallback` or `import`; requires `QLEVER_IMAGE`    |
| `DATA_DIR`           | `/data`                     | Directory for downloaded dumps and QLever index caches                       |

A misconfigured boot reports **all** problems in one error, not one per crash
loop. `PROVENANCE_FILE` must sit on a durable volume, and cannot be combined
with `REBUILD_MODE=blue-green`: a skipped dataset would be missing from the
fresh collection the swap makes live.

## The QLever import path

By default the indexer serves only datasets that publish a live SPARQL
endpoint (the pipeline’s endpoint-only default). Setting `QLEVER_IMAGE`
enables the import path: data dumps are downloaded to `DATA_DIR` and imported
into a QLever instance the **pipeline itself creates and controls** – one
sibling container per dataset, spawned over the Docker socket
([ADR 16](../../docs/decisions/0016-ship-the-search-indexer-as-a-config-driven-image.md)
explains why a statically-declared QLever service cannot work). That requires:

- the Docker socket mounted into the indexer container
  (`--volume /var/run/docker.sock:/var/run/docker.sock`), plus a group grant
  to reach it as the image’s non-root user
  (`--group-add $(stat -c %g /var/run/docker.sock)`);
- `DATA_DIR` on a volume whose **host path is identical** for the indexer and
  the spawned QLever containers – the pipeline passes `DATA_DIR` as a bind
  mount to a sibling container, where it resolves against the host.

This mode does not work on container runtimes without a Docker socket
(containerd-based Kubernetes); there, run endpoint-only for now.

## Building the image

The image is built from the workspace’s own outputs – the compiled package,
the same-commit builds of its `@lde/*` dependencies and a pruned lockfile –
never from npm, so it exists for any commit
([ADR 15](../../docs/decisions/0015-ship-the-served-search-api-as-a-docker-image-built-from-the-workspace.md)):

```sh
npx nx run @lde/search-indexer:docker:build   # → packages-search-indexer
npx nx run @lde/search-indexer:docker:smoke   # boots it with --check
```

CI runs `docker:smoke` for affected PRs; each release rebuilds and pushes
`ghcr.io/ldelements/search-indexer:<version>` (`.github/workflows/docker.yml`).

## Programmatic use

The bin is a thin wrapper over the exported API, usable in tests or a custom
boot:

```ts
import {
  configFromEnvironment,
  createSearchIndexer,
} from '@lde/search-indexer';

const pipeline = await createSearchIndexer(configFromEnvironment(process.env));
await pipeline.run();
```
