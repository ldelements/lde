# The prebuilt served search API (https://github.com/ldelements/lde/issues/600,
# layer 3), built from this workspace’s own outputs: `nx run
# @lde/search-api-server:docker:build` stages the compiled package, the
# same-commit builds of its @lde/* workspace dependencies
# (copy-workspace-modules) and a pruned lockfile (prune-lockfile) into
# dist-docker/, so the image never waits on – or drifts from – an npm publish.
# CI smoke-tests the running image (docker:smoke); releases push it to
# ghcr.io/ldelements/search-api-server (.github/workflows/docker.yml).
FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/ldelements/lde"

WORKDIR /app
ENV NODE_ENV=production

COPY dist-docker/package.json dist-docker/package-lock.json ./
# --legacy-peer-deps: @lde/search-typesense’s peers (@lde/pipeline,
# @lde/dataset) type the WRITE side only – every runtime import is
# `import type`, erased at compile time – so the read-only server image
# deliberately leaves them (and their SPARQL dependency tree) out. The
# docker:smoke boot test guards this: a future value import would crash
# startup with ERR_MODULE_NOT_FOUND.
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
# Lays the same-commit workspace modules over the registry-installed tree.
COPY dist-docker/ ./

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --quiet --output-document=- http://127.0.0.1:${PORT:-4000}/health || exit 1
CMD ["node", "dist/cli.js"]
