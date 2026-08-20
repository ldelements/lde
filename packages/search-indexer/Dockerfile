# The prebuilt search indexer (https://github.com/ldelements/lde/issues/652,
# the write-path counterpart of the search-api-server image), built from this
# workspace’s own outputs: `nx run @lde/search-indexer:docker:build` stages the
# compiled package, the same-commit builds of its @lde/* workspace dependencies
# (copy-workspace-modules) and a pruned lockfile (prune-lockfile) into
# dist-docker/, so the image never waits on – or drifts from – an npm publish.
# CI smoke-tests the running image (docker:smoke); releases push it to
# ghcr.io/ldelements/search-indexer (.github/workflows/docker.yml).
#
# The install runs on Debian, not Alpine, because the runtime stage is a glibc
# distroless image: a musl-linked prebuilt binary picked up by an Alpine
# install would not load there.
FROM node:24-bookworm-slim AS install

WORKDIR /app
ENV NODE_ENV=production

COPY dist-docker/package.json dist-docker/package-lock.json ./
# --legacy-peer-deps: must match the flag the docker:lockfile repair step
# installs with, or `npm ci` rejects the lockfile over peers that step left
# out (typesense declares a `@babel/runtime` peer no runtime import needs).
# The docker:smoke boot test guards that nothing genuinely needed is missing.
#
# The npm cache and every file Node never opens go in the same RUN as the
# install: a later step can only add a layer on top of the one that already
# carries them, never shrink it. That is source maps, type declarations and
# documentation – including the dependencies' licence files, which is a
# deliberate call, since the image redistributes their code.
RUN npm ci --omit=dev --legacy-peer-deps \
  && npm cache clean --force \
  && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.md' \
       -o -iname 'licen[sc]e*' -o -iname 'notice*' -o -iname 'copying*' \
       -o -iname 'readme*' -o -iname 'changelog*' -o -iname 'authors*' \) -delete
# Lays the same-commit workspace modules over the registry-installed tree.
COPY dist-docker/ ./

# Default DATA_DIR for the QLever import path; a real deployment mounts a
# volume here (and the same host path into the sibling QLever container).
# /provenance is the conventional home of PROVENANCE_FILE. Both are created
# here and copied into the runtime stage, which has no shell to create them.
RUN mkdir -p /data /provenance

# Only the Node binary and the libraries it links: no npm, no yarn, no shell,
# no package manager, and so nothing to patch or exploit outside Node itself.
FROM gcr.io/distroless/nodejs24-debian12
LABEL org.opencontainers.image.source="https://github.com/ldelements/lde"

WORKDIR /app
ENV NODE_ENV=production
# The base image leaves its Node outside PATH, so a Kubernetes manifest that
# overrides `command` with the usual `node …` would not find it.
ENV PATH="/nodejs/bin:${PATH}"

# uid 1000 by number: distroless ships no `node` account, and the number is
# what a mount sees. Owning /data and /provenance keeps a fresh named volume
# mounted there – which inherits the image directory’s ownership – writable
# by the runtime user (issue #661).
COPY --from=install --chown=1000:1000 /app /app
COPY --from=install --chown=1000:1000 /data /data
COPY --from=install --chown=1000:1000 /provenance /provenance

USER 1000:1000
# The base image’s entrypoint is the Node binary; naming the script here too
# means `docker run <image> --check` reaches the CLI, instead of replacing it.
ENTRYPOINT ["/nodejs/bin/node", "dist/cli.js"]
