# The prebuilt search indexer (https://github.com/ldelements/lde/issues/652,
# the write-path counterpart of the search-api-server image), built from this
# workspace’s own outputs: `nx run @lde/search-indexer:docker:build` stages the
# compiled package, the same-commit builds of its @lde/* workspace dependencies
# (copy-workspace-modules) and a pruned lockfile (prune-lockfile) into
# dist-docker/, so the image never waits on – or drifts from – an npm publish.
# CI smoke-tests the running image (docker:smoke); releases push it to
# ghcr.io/ldelements/search-indexer (.github/workflows/docker.yml).
FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/ldelements/lde"

WORKDIR /app
ENV NODE_ENV=production

COPY dist-docker/package.json dist-docker/package-lock.json ./
# --legacy-peer-deps: must match the flag the docker:lockfile repair step
# installs with, or `npm ci` rejects the lockfile over peers that step left
# out (typesense declares a `@babel/runtime` peer no runtime import needs).
# The docker:smoke boot test guards that nothing genuinely needed is missing.
RUN npm ci --omit=dev --legacy-peer-deps
# Lays the same-commit workspace modules over the registry-installed tree.
COPY dist-docker/ ./

# Default DATA_DIR for the QLever import path; a real deployment mounts a
# volume here (and the same host path into the sibling QLever container).
RUN mkdir -p /data && chown node:node /data

USER node
CMD ["node", "dist/cli.js"]
