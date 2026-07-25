# @lde/search-indexer

The [@lde/search-pipeline](../search-pipeline) indexer as a bootable process
and prebuilt Docker image: mount a schema-declaration module, point it at a
dataset registry and Typesense, and one run selects the datasets, extracts and
projects each root type per the schema, and rebuilds the engine collections –
then exits. Run it as a cron job; the rebuild writers’ cross-pod lock makes an
overlapping run fail fast instead of corrupting a collection.

## Installation

```sh
npm install @lde/search-indexer
```

```sh
docker run --rm \
  --volume ./search-schema.mjs:/config/search-schema.mjs:ro \
  --env REGISTRY_ENDPOINT=https://registry.example.org/sparql \
  --env TYPESENSE_HOST=typesense.internal \
  --env TYPESENSE_API_KEY=admin-key \
  ghcr.io/ldelements/search-indexer
```

## Documentation

See the [full documentation](https://ldelements.org/reference/search-indexer).
