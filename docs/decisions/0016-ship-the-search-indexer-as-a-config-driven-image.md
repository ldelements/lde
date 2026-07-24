# 16. Ship the search indexer as a config-driven image

Date: 2026-07-24

## Status

Accepted

Extends [ADR 15 (Ship the served search API as a Docker image built from the
workspace)](./0015-ship-the-served-search-api-as-a-docker-image-built-from-the-workspace.md).
Implements [#652](https://github.com/ldelements/lde/issues/652), the
write-path counterpart of #600/#646.

## Context

`searchIndexerPipeline()` (#647) composes the object-grain search indexer,
but still requires a Node program around it. The read path already ends in a
bootable image (ADR 15); the write path needs the same final layer, and the
symmetry is the point: mount the **same schema-declaration module** into both
images, point both at the same `TYPESENSE_*` coordinates, and the write and
read sides cannot disagree about the schema.

The one open design problem is the import path (`ImportResolver` +
`@lde/sparql-qlever`). Importing is not ‘have a QLever running’ but a
per-dataset control loop: download the dump, build the index offline,
(re)start the server on the new index. A statically-declared QLever service
(Docker Compose service, Kubernetes sidecar) therefore **cannot work**: it
only exposes a SPARQL port, and the pipeline has no control plane to rebuild
its index per dataset. Feeding a running server is not viable either – SPARQL
UPDATE’s update-triples overlay performs badly and deleted triples can
reappear after restart, and Graph Store HTTP `POST` is unusable for large
datasets (ad-freiburg/qlever#2014). A QLever the pipeline uses must be a
QLever the pipeline controls.

## Decision

- **A separate composition package, `@lde/search-indexer`**: environment
  config, the shared schema-module loader, dataset selection against a
  registry, and Typesense rebuild writers around `searchIndexerPipeline`.
  Engine-bound to Typesense deliberately – that binding cannot live in
  `@lde/search-pipeline` without breaking its engine-agnosticism. Published
  to npm and shipped as `ghcr.io/ldelements/search-indexer`, reusing ADR 15’s
  entire delivery pattern (workspace-built image, `docker:smoke` CI gate,
  release-tag-triggered publish).
- **The schema-module loader moves to `@lde/search/module`** and both images
  use it, implementing the shared-mount symmetry in code: one loader, one
  validation, one error vocabulary. Consumer-specific optional exports
  (`schemaOptions`, `engineOptions`) stay validated in the consumers.
- **Configuration is env-only and boot-or-fail**, every problem reported in
  one error (ADR 15’s pattern): registry endpoint plus dataset IRIs or
  criteria, `TYPESENSE_*`, rebuild mode, optional collection prefix, optional
  file provenance + pipeline version. Two combinations are rejected at boot:
  provenance with only one of its two halves, and provenance with blue-green
  rebuilds – a skipped dataset would be missing from the fresh collection the
  swap makes live.
- **v1 ships endpoint-only by default, plus the Docker-socket import path
  behind a flag.** `QLEVER_IMAGE` turns on `ImportResolver` with
  `DockerTaskRunner`: the indexer container spawns and fully controls sibling
  QLever containers over the mounted socket. It is free (the runner exists
  and talks to the socket via dockerode), Compose-friendly, and keeps QLever
  out of the indexer’s cgroup. Its limits are documented, not worked around:
  no socket, no import path – on containerd-based Kubernetes, run
  endpoint-only.
- **Native mode in-image is the Kubernetes follow-up, not part of v1**:
  shipping the QLever engine inside the indexer image (`NativeTaskRunner`)
  works anywhere a container runs, but costs image size, engine-version
  coupling and a shared cgroup (a QLever OOM kills the indexer). A
  controllable QLever sidecar (own control agent and protocol) is only worth
  designing if both other options prove unacceptable.

## Consequences

- Ops deploys configure the indexer (a cron job in Compose or Kubernetes)
  instead of writing a Node program; deployments with bespoke root selectors
  or per-stage tuning stay on the first-class library path
  (`searchStages` + `searchIndexWriter` + `Pipeline`).
- One mounted module drives both images; schema drift between the write and
  read side is no longer expressible in deployment config.
- The image runs batch-style: no ports, no `HEALTHCHECK`; overlapping runs
  are serialized by the rebuild writers’ cross-pod lock.
- The import path requires Docker-socket access and an identical host path
  for `DATA_DIR` in the indexer and its sibling QLever containers – both
  documented in the package README, both moot in endpoint-only mode.
- When the Kubernetes need materializes, native mode lands as a second image
  variant (or a base-image switch) without touching the configuration
  surface: `QLEVER_IMAGE` is the only Docker-specific knob.
