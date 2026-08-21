# @lde/search-indexer

The [@lde/search-pipeline](./search-pipeline) indexer as a bootable process
and prebuilt Docker image: mount a schema-declaration module, point it at a
dataset registry and Typesense, and one run selects the datasets, extracts and
projects each root type per the schema, and rebuilds the engine collections –
then exits. Run it as a cron job; the rebuild writers’ cross-pod lock makes an
overlapping run fail fast instead of corrupting a collection.

This is the write-path counterpart of
[`@lde/search-api-server`](./search-api-server)
([#652](https://github.com/ldelements/lde/issues/652)): the composition layer
that binds the engine-agnostic `searchIndexerPipeline` to the
[`@lde/search-typesense`](./search-typesense) rebuild writers. Mount the
**same schema module** into both images and point both at the same
`TYPESENSE_*` coordinates, and the write and the read side cannot disagree
about the schema. A deployment that needs domain behaviour on top passes a
[transform](#add-a-transform); one that needs a bespoke root selector, per-stage
tuning or another engine [composes it yourself](#compose-it-yourself).

## Installation

```sh
npm install @lde/search-indexer
```

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
README](./search-api-server#the-schema-module) for the format and
authoring guidance; both images load the module with the same
`@lde/search/module` loader. The indexer reads only the default export: the
declarations drive one pipeline stage and one engine collection per root type,
and each field’s `path` drives the extraction CONSTRUCT. The read-side extras
(`schemaOptions`, `engineOptions`) are ignored here, so one file serves both
images.

## Configuration

| Variable              | Default                     | Meaning                                                                                                                                               |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEMA_MODULE`       | `/config/search-schema.mjs` | Path of the mounted schema-declaration module                                                                                                         |
| `REGISTRY_ENDPOINT`   | **required**                | SPARQL endpoint of the DCAT dataset registry                                                                                                          |
| `REGISTRY_ROOT_TYPES` | none                        | Root types extracted from the registry instead of the dataset’s distribution (see below), by schema type name                                         |
| `DATASETS`            | all registry datasets       | Dataset IRIs to index (whitespace- or comma-separated)                                                                                                |
| `DATASET_CRITERIA`    | all registry datasets       | Search criteria as a JSON object, in [`@lde/dataset-registry-client`](./dataset-registry-client)’s criteria format (mutually exclusive w/ `DATASETS`) |
| `TYPESENSE_HOST`      | **required**                | Typesense host                                                                                                                                        |
| `TYPESENSE_PORT`      | `8108`                      | Typesense port                                                                                                                                        |
| `TYPESENSE_PROTOCOL`  | `http`                      | `http` or `https`                                                                                                                                     |
| `TYPESENSE_API_KEY`   | **required**                | An admin key: the indexer creates, writes and swaps collections                                                                                       |
| `REBUILD_MODE`        | `in-place`                  | `in-place` (update the live collection) or `blue-green` (swap on commit)                                                                              |
| `COLLECTION_PREFIX`   | none                        | Prefix for every derived collection name (configure the read side to match)                                                                           |
| `DEFAULT_LOCALE`      | none                        | Stemming language for untagged text, e.g. `nl`. Unset, untagged text is folded but **unstemmed** – `fietsen` will not match `fiets`                   |
| `PROVENANCE_FILE`     | none                        | JSON file remembering per-dataset processing, to skip unchanged datasets                                                                              |
| `PIPELINE_VERSION`    | none                        | Version keying the skip decisions; required with `PROVENANCE_FILE`                                                                                    |
| `QLEVER_IMAGE`        | none                        | Enables the QLever import path (see below), e.g. `adfreiburg/qlever:latest`                                                                           |
| `IMPORT_STRATEGY`     | `sparql`                    | `sparql`, `sparqlWithImportFallback` or `import`; requires `QLEVER_IMAGE`                                                                             |
| `DATA_DIR`            | `/data`                     | Directory for downloaded dumps and QLever index caches                                                                                                |
| `QLEVER_NETWORK`      | none                        | Docker network the spawned QLever joins; set when the indexer itself runs containerized (see below)                                                   |

A misconfigured boot reports **all** problems in one error, not one per crash
loop. `PROVENANCE_FILE` must sit on a durable volume, and cannot be combined
with `REBUILD_MODE=blue-green`: a skipped dataset would be missing from the
fresh collection the swap makes live. Its directory must be writable by the
image’s runtime user (uid 1000) – the image pre-creates `/provenance` with
that ownership, so a named volume mounted there just works, while a bind
mount must be `chown`ed on the host. A run fails at start when the file is
not writable, instead of silently never skipping.

## Registry-sourced root types

Every root type is extracted from the dataset’s **distribution** by default –
its live SPARQL endpoint, or a dump imported into QLever. That holds while a
type is described by the data the dataset publishes, and it breaks for the
dataset itself: a dataset’s description is governed by a different application
profile from the objects it contains, and it lives in the register. Nothing
obliges a publisher to describe its own dataset inside its dump, so a `Dataset`
type extracted from the distribution yields documents for the few publishers
that self-describe and nothing for the rest.

`REGISTRY_ROOT_TYPES` names the root types to extract from `REGISTRY_ENDPOINT`
instead:

```sh
--env REGISTRY_ROOT_TYPES="Dataset Publisher"
```

Same CONSTRUCT generator, same framing, same projection, same writers – only
the source differs. Each such stage is **scoped to the graph the dataset in
hand names**: a register holds every registration, so an unscoped stage would
re-index the whole catalogue once per dataset processed. Scoped, one pass sees
exactly one registration, and a `selectByClass` finds that dataset’s own roots
inside it – its `dcat:Dataset` node, and the `foaf:Organization` its
`dcterms:publisher` points at. This presumes the register names each
registration’s graph after the dataset IRI, which is how a DCAT register that
crawls per registration stores it.

Routing is deployment topology, so it is configuration and not part of the
schema: a `SearchType` is defined by its `class`, never by where its triples
come from, and the same declaration serves a deployment that sources it
differently. A name that the mounted schema does not declare fails the boot,
rather than shipping an empty collection.

## The QLever import path

By default the indexer serves only datasets that publish a live SPARQL
endpoint (the pipeline’s endpoint-only default). Setting `QLEVER_IMAGE`
enables the import path: data dumps are downloaded to `DATA_DIR` and imported
into a QLever instance the **pipeline itself creates and controls** – one
sibling container per dataset, spawned over the Docker socket
([ADR 16](../decisions/0016-ship-the-search-indexer-as-a-config-driven-image)
explains why a statically-declared QLever service cannot work). That requires:

- the Docker socket mounted into the indexer container
  (`--volume /var/run/docker.sock:/var/run/docker.sock`), plus a group grant
  to reach it as the image’s non-root user
  (`--group-add $(stat -c %g /var/run/docker.sock)`);
- `DATA_DIR` on a volume whose **host path is identical** for the indexer and
  the spawned QLever containers – the pipeline passes `DATA_DIR` as a bind
  mount to a sibling container, where it resolves against the host.

How the indexer reaches the QLever it spawned depends on where the indexer
itself runs:

- **On the host** (`npx @lde/search-indexer` with Docker available): leave
  `QLEVER_NETWORK` unset. QLever’s port is published on the host and
  addressed as `localhost`.
- **In a container on a bridge network** (the `docker compose` default): set
  `QLEVER_NETWORK` to a network the indexer is attached to. QLever joins that
  network and is addressed by container name (`qlever-<network>`) instead – a
  containerized indexer’s `localhost` is its own network namespace, so it
  cannot reach a host-published port. Alternatively, run the indexer with
  `network_mode: host` and leave `QLEVER_NETWORK` unset.

`QLEVER_NETWORK` must name a network the indexer container is actually
attached to – for compose, the prefixed name Docker creates (e.g.
`myproject_default`), not the short service-file name. A wrong or unattached
network is not caught at boot: each dataset imports fully, then fails when
the endpoint never becomes reachable. And run at most one indexer per
network – the QLever container name is derived from the network, so two
indexers sharing one would remove each other’s QLever.

This mode does not work on container runtimes without a Docker socket
(containerd-based Kubernetes); there, run endpoint-only for now.

## Building the image

The image is built from the workspace’s own outputs – the compiled package,
the same-commit builds of its `@lde/*` dependencies and a pruned lockfile –
never from npm, so it exists for any commit
([ADR 15](../decisions/0015-ship-the-served-search-api-as-a-docker-image-built-from-the-workspace)):

```sh
npx nx run @lde/search-indexer:docker:build   # → packages-search-indexer
npx nx run @lde/search-indexer:docker:smoke   # boots it with --check
```

CI runs `docker:smoke` for affected PRs; each release rebuilds and pushes
`ghcr.io/ldelements/search-indexer:<version>` (`.github/workflows/docker.yml`).

The runtime stage is `gcr.io/distroless/nodejs24-debian12` – the Node binary
and the libraries it links, with no shell, no npm and no package manager – and
the install stage drops npm’s cache and every `*.map` and `*.d.ts` under
`node_modules`, none of which Node reads. Together they take about a third
off the compressed image. The missing shell is the
trade: `docker exec <container> sh` no longer works, so inspect a running
container with `docker cp`, or mount its volumes into a shell-bearing image.
The entrypoint is the CLI itself, so `docker run … --check` reaches it.

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

The configuration types are exported too: `IndexerConfig` (what
`configFromEnvironment` produces) and its parts `TypesenseConnection`,
`ProvenanceConfig` (`PROVENANCE_FILE` + `PIPELINE_VERSION`) and `QleverConfig`
(the QLever import path).

## Add a transform

The one thing configuration cannot express is domain behaviour: correcting the
data a publisher ships, minting a quad it does not, dropping one it should not.
Pass it as a `QuadTransform` per root type, keyed by the type’s `name`:

```ts
import {
  configFromEnvironment,
  createSearchIndexer,
} from '@lde/search-indexer';

const pipeline = await createSearchIndexer(configFromEnvironment(process.env), {
  transforms: { Object: [dropSelfReferences] },
});
await pipeline.run();
```

That is the whole cost of adding behaviour. Dataset selection, the QLever
import path, registry-sourced root types, collection naming, provenance and the
console reporter stay wired, and the transform is attached to the type’s
generated reader – so the reader’s subject variable and the stage’s root
variable cannot fall out of step. A key the mounted schema does not declare
throws at boot rather than attaching nothing and shipping an unenriched
collection.

One rule the type system cannot state: **a field a transform fills must still
declare a `path`.** Projection skips a field with neither a `path` nor a
`derive`, so a transform-minted IR Alias is otherwise never read and the field
ships empty.

The same rule bites once more where a root type declares a
[document key](./search#document-key): **a transform that replaces a root’s
quads must re-emit the key field.** The key is read off the projected frame like
any other field, so a replaced root that drops it is keyed on its node IRI
instead – and every reference to it, which is keyed independently, then points
at a document that was never written. A transform that only adds quads (the
documented use) never meets this.

## Compose it yourself

Reach for this only when the deployment needs something `createSearchIndexer`
has no answer for – a non-SPARQL reader, a root selector that is not by class,
another engine – and compose `searchStages`, `searchIndexWriter` and `Pipeline`
directly. Adding a transform is **not** such a case; that is `transforms` above.

The three pieces `createSearchIndexer` composes are exported, so this route
costs the bespoke part rather than a copy of the wiring:

- `datasetSelectorFrom(config)` – the registry-backed dataset selection;
- `distributionResolverFrom(config)` – the QLever import path when
  `QLEVER_IMAGE` is set, `undefined` otherwise (the pipeline’s endpoint-only
  default);
- `writerFactoryFrom(client, config)` – the rebuild writer per root type, its
  collection named and prefixed as configured and its untagged text stemmed in
  `DEFAULT_LOCALE`.

```ts
import { Pipeline, SparqlConstructReader } from '@lde/pipeline';
import { ConsoleReporter } from '@lde/pipeline-console-reporter';
import { loadSchemaModule } from '@lde/search/module';
import { searchIndexWriter, searchStages } from '@lde/search-pipeline';
import {
  configFromEnvironment,
  datasetSelectorFrom,
  distributionResolverFrom,
  writerFactoryFrom,
} from '@lde/search-indexer';
import { Client } from 'typesense';

const config = configFromEnvironment(process.env);
const { schema } = await loadSchemaModule(config.schemaModulePath);
const client = new Client({
  nodes: [
    {
      host: config.typesense.host,
      port: config.typesense.port,
      protocol: config.typesense.protocol,
    },
  ],
  apiKey: config.typesense.apiKey,
});
const objectType = schema.get('https://example.org/Object')!;

const pipeline = new Pipeline({
  datasetSelector: datasetSelectorFrom(config),
  distributionResolver: distributionResolverFrom(config),
  stages: searchStages({
    schema,
    types: [
      {
        searchType: objectType,
        rootVariable: 'root',
        itemSelector: myBespokeSelector,
        // Own reader: attach transforms to it as data, `{ reader, transform }`.
        readers: { reader: myNonSparqlReader, transform: [myTransform] },
      },
    ],
  }),
  writers: searchIndexWriter({
    schema,
    writerFor: writerFactoryFrom(client, config),
  }),
  // Composing by hand means restating these: they are wired by
  // `searchIndexerPipeline`, which this route bypasses, and silently absent if
  // forgotten.
  reporter: new ConsoleReporter(),
});
await pipeline.run();
```

Note what the last argument buys back. `createSearchIndexer` also passes
`registryTypes` (from `REGISTRY_ROOT_TYPES`), `provenanceStore` and
`pipelineVersion` (from `PROVENANCE_FILE` + `PIPELINE_VERSION`) into
`searchIndexerPipeline`. This route bypasses that function, so each is absent
until restated – with no error, just a run that reports nothing, skips nothing
and reads registry types from the wrong place. That is the cost of leaving the
convenience, and the reason `transforms` exists rather than sending every
deployment here.
