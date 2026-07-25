# @lde/search-api-server

The served [@lde/search](../search) API as a bootable process and prebuilt
Docker image: mount a schema-declaration module, point it at Typesense, and it
serves `/graphql` – POST execution, the self-contained playground, the SDL –
plus `/health`, with CORS and depth/cost limits on by default.

## Installation

```sh
npm install @lde/search-api-server
```

```sh
docker run --publish 4000:4000 \
  --volume "$(pwd)/search-schema.mjs:/config/search-schema.mjs:ro" \
  --env TYPESENSE_HOST=typesense.internal \
  --env TYPESENSE_API_KEY=search-only-key \
  ghcr.io/ldelements/search-api-server
```

## Documentation

See the [full documentation](https://ldelements.org/reference/search-api-server).
