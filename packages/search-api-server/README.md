# @lde/search-api-server

The served [@lde/search](../search) API as a bootable process and prebuilt
Docker image: mount a schema-declaration module, point it at Typesense, and it
serves `/graphql` – POST execution, the self-contained playground, the SDL –
plus `/health`, with CORS and depth/cost limits on by default.

This is the composition layer
([#600](https://github.com/ldelements/lde/issues/600), layer 3) that binds the
engine-agnostic [`@lde/search-api-graphql`](../search-api-graphql) handler
(layer 2) to the [`@lde/search-typesense`](../search-typesense) engine. Use it
for turnkey, non-JS and ops-driven deployments; a JS host that wants custom
GraphQL fields mounts the handler itself instead (or builds `FROM` this image).

## Run

```sh
docker run --publish 4000:4000 \
  --volume "$(pwd)/search-schema.mjs:/config/search-schema.mjs:ro" \
  --env TYPESENSE_HOST=typesense.internal \
  --env TYPESENSE_API_KEY=search-only-key \
  ghcr.io/ldelements/search-api-server
```

Or without Docker (the same environment variables apply):

```sh
npx @lde/search-api-server
```

## The schema module

The mounted module default-exports the deployment’s search type declarations as
**plain data** – it must not import `@lde/search` (bare specifiers do not
resolve from a mounted file), and does not need to: the server validates the
declarations at boot, exactly as it would a SHACL generator’s output. Optional
functions (`derive`, `transform`) are allowed – it is a real JS module, only
without imports; they are projection-time declarations a serving process never
calls, carried so one module can drive both the indexer and this API.

Authoring in TypeScript works fine: compile the module to `.mjs` first
(`tsc` or esbuild) and mount the output – with `satisfies SearchType[]` you
get the full compile-time checking, and functions survive compilation. If the
module must import, bundle it (e.g. esbuild) before mounting.

```js
// search-schema.mjs
export default [
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'title',
        kind: 'text',
        locales: ['nl', 'en'],
        output: true,
        searchable: { weight: 5 },
      },
      {
        name: 'keyword',
        kind: 'keyword',
        array: true,
        facetable: true,
        output: true,
      },
    ],
  },
];

// Optional: forwarded to buildGraphQLSchema (per-type options, maxPerPage, …).
export const schemaOptions = { maxPerPage: 50 };

// Optional: forwarded to createTypesenseSearchEngine (collection overrides, …).
export const engineOptions = {};
```

Once the SHACL + `search:` generator lands
([#495](https://github.com/ldelements/lde/issues/495)), mounted SHACL becomes
an additional source for the same schema.

## Configuration

| Variable             | Default                     | Meaning                                            |
| -------------------- | --------------------------- | -------------------------------------------------- |
| `SCHEMA_MODULE`      | `/config/search-schema.mjs` | Path of the mounted schema-declaration module      |
| `PORT`               | `4000`                      | TCP port the server binds                          |
| `GRAPHQL_ENDPOINT`   | `/graphql`                  | Path serving GraphQL, the playground and the SDL   |
| `PLAYGROUND`         | `true`                      | Serve the playground on GET (`false`/`0` disables) |
| `MAX_DEPTH`          | handler default (15)        | Query depth cap                                    |
| `MAX_COST`           | handler default (5000)      | Query cost cap                                     |
| `TYPESENSE_HOST`     | **required**                | Typesense host                                     |
| `TYPESENSE_PORT`     | `8108`                      | Typesense port                                     |
| `TYPESENSE_PROTOCOL` | `http`                      | `http` or `https`                                  |
| `TYPESENSE_API_KEY`  | **required**                | Use a search-only key: the server only ever reads  |

A misconfigured boot reports **all** problems in one error, not one per crash
loop.

## Endpoints

- `POST /graphql` – GraphQL execution.
- `GET /graphql` – the self-contained playground (no external CDN, no framing
  headers, so a docs site can `<iframe>` it as a live client).
- `GET /graphql?sdl` – the printed SDL: the contract without a running
  introspection query.
- `GET /health` – liveness; the Docker image’s `HEALTHCHECK` uses it.
- `GET /` – redirects to the endpoint.

## Building the image

The image is built from the workspace’s own outputs – the compiled package,
the same-commit builds of its `@lde/*` dependencies and a pruned lockfile –
never from npm, so it exists for any commit
([ADR 15](../../docs/decisions/0015-ship-the-served-search-api-as-a-docker-image-built-from-the-workspace.md)):

```sh
npx nx run @lde/search-api-server:docker:build   # → packages-search-api-server
npx nx run @lde/search-api-server:docker:smoke   # boots it and probes /health + ?sdl
```

CI runs `docker:smoke` for affected PRs; each release tag rebuilds and pushes
`ghcr.io/ldelements/search-api-server:<version>` (`.github/workflows/docker.yml`).

## Programmatic use

The bin is a thin wrapper over the exported API, usable in tests or a custom
boot:

```ts
import {
  configFromEnvironment,
  createSearchApiServer,
} from '@lde/search-api-server';

const server = await createSearchApiServer(configFromEnvironment(process.env));
const port = await server.start();
```
