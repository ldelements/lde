# 15. Ship the served search API as a Docker image built from the workspace

Date: 2026-07-23

## Status

Accepted

Extends [ADR 14 (Serve the search GraphQL API with graphql-yoga)](./0014-serve-the-search-graphql-api-with-graphql-yoga.md).
Implements the image layer (layer 3) of
[#600](https://github.com/ldelements/lde/issues/600).

## Context

The `createSearchGraphQLHandler()` fetch handler (ADR 14) still requires a JS
host to mount it. Turnkey, non-JS and ops-driven deployments – and the
dedicated search-API pod topology #600 recommends – need a prebuilt image that
boots from configuration alone.

Three constraints shaped the design:

1. `@lde/search-api-graphql` deliberately names neither the domain nor the
   engine, so a bootable server that binds Typesense cannot live there.
2. A mounted ES module cannot use bare imports (`import '@lde/search'` does not
   resolve from a mounted path), so the schema mount cannot be authored against
   the library. The SHACL + `search:` source #600 assumed does not exist yet –
   schema generation is [#495](https://github.com/ldelements/lde/issues/495)’s
   still-open scope.
3. An image built from the published npm package (the first design of this
   ADR) couples the Docker build to the npm publish: the build must wait for
   the registry, the first image is blocked on the new package’s manual
   Trusted-Publishing bootstrap, and no image can be built – let alone
   smoke-tested – for unpublished code in a PR.

The Dataset Register went through the same evolution for its app images and
settled on building from the workspace, unbundled, after an esbuild-bundled
image hid a workspace lib’s transitive dependencies until the container
crashed at startup (dataset-register#2128/#2130). We adopt its end state.

## Decision

- **A separate composition package, `@lde/search-api-server`**: environment
  config, schema-module loading, and a `node:http` server around the ADR 14
  handler bound to `createTypesenseSearchEngine`. The engine-agnostic handler
  package stays engine-agnostic. It is npm-published like every other package.
- **The schema mounts as a plain-data declaration module**: a `.mjs` file
  default-exporting `SearchType` declarations, validated at boot by
  `searchSchema()` – the exact “declarations built outside TypeScript” path
  the runtime validation exists for. Optional functions (`derive`,
  `transform`) remain expressible; a serving process never calls them. When
  #495 delivers the SHACL + `search:` generator, mounted SHACL becomes a
  second source for the same schema.
- **The image is built from the workspace’s own outputs, not from npm.**
  `docker:build` (inferred by `@nx/docker`) depends on a staging chain –
  `docker:stage` (compiled package), `@nx/js:copy-workspace-modules`
  (same-commit builds of the `@lde/*` dependencies), `@nx/js:prune-lockfile`
  plus a `npm install --package-lock-only` repair step (`docker:lockfile`,
  needed because Nx’s lockfile pruning cannot map this workspace’s graph and
  falls back to the root lockfile) – and the Dockerfile is a plain
  `npm ci --omit=dev` + `COPY`. No bundling: the image keeps real modules, so
  a missing dependency fails loudly instead of being silently inlined away.
- **`docker:smoke` gates CI**: the built image is booted with a fixture
  schema and probed over HTTP (`/health`, `/graphql?sdl`) in `nx affected`,
  so both build-time and runtime-only failures (the
  `ERR_MODULE_NOT_FOUND` class) fail the PR, not production.
- **Publishing is tag-triggered but registry-independent**: the release run’s
  `@lde/search-api-server@<version>` tag triggers the Docker workflow, which
  checks out that commit, rebuilds and smoke-tests the image, and pushes
  `ghcr.io/ldelements/search-api-server:<version>` and `:latest`. Image tags
  stay aligned with the package’s semver; `nx release`’s own Docker support
  (experimental, calendar-versioned, and unable to both npm- and
  Docker-publish one project) is deliberately not used.
- The read-only image **omits `@lde/search-typesense`’s peers**
  (`@lde/pipeline`, `@lde/dataset`; `npm ci --legacy-peer-deps`): they type
  the write side only and every runtime import is `import type`. The smoke
  test guards this assumption.

## Consequences

- Ops deploys get a turnkey `/graphql` + playground from a schema mount and
  environment variables; JS hosts keep mounting the handler directly.
- The image cannot serve custom-code GraphQL fields – by design (#600): such
  consumers use the handler, or build `FROM` this image.
- The Docker build no longer waits on – or can be broken by – the npm
  publish; the npm package’s one-time manual bootstrap only affects npm
  consumers, not the image.
- Every affected PR pays for an image build + boot in CI (~15 s), in exchange
  for catching pruned-image runtime failures before merge.
- The `docker:lockfile` repair step is a workaround for the Nx pruning
  fallback; when Nx learns to prune this workspace’s lockfile it can be
  dropped.
