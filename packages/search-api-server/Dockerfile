# The prebuilt served search API (https://github.com/ldelements/lde/issues/600,
# layer 3), built from this workspace’s own outputs: `nx run
# @lde/search-api-server:docker:build` stages the compiled package, the
# same-commit builds of its @lde/* workspace dependencies
# (copy-workspace-modules) and a pruned lockfile (prune-lockfile) into
# dist-docker/, so the image never waits on – or drifts from – an npm publish.
# CI smoke-tests the running image (docker:smoke); releases push it to
# ghcr.io/ldelements/search-api-server (.github/workflows/docker.yml).
#
# The install runs on Debian, not Alpine, because the runtime stage is a glibc
# distroless image: a musl-linked prebuilt binary picked up by an Alpine
# install would not load there.
FROM node:24-bookworm-slim AS install

WORKDIR /app
ENV NODE_ENV=production

COPY dist-docker/package.json dist-docker/package-lock.json ./
# --legacy-peer-deps: @lde/search-typesense’s peers (@lde/pipeline,
# @lde/dataset) type the WRITE side only – every runtime import is
# `import type`, erased at compile time – so the read-only server image
# deliberately leaves them (and their SPARQL dependency tree) out. The
# docker:smoke boot test guards this: a future value import would crash
# startup with ERR_MODULE_NOT_FOUND.
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

# Only the Node binary and the libraries it links: no npm, no yarn, no shell,
# no package manager, and so nothing to patch or exploit outside Node itself.
FROM gcr.io/distroless/nodejs24-debian12
LABEL org.opencontainers.image.source="https://github.com/ldelements/lde"

WORKDIR /app
ENV NODE_ENV=production
# The base image leaves its Node outside PATH, so a Kubernetes manifest that
# overrides `command` with the usual `node …` would not find it.
ENV PATH="/nodejs/bin:${PATH}"

# uid 1000 by number: distroless ships no `node` account.
COPY --from=install --chown=1000:1000 /app /app

USER 1000:1000
EXPOSE 4000
# There is no shell and no wget to call out to, so the probe is Node itself.
# It costs a Node start per probe, hence the timeout well above wget's 3s and
# a start period that keeps a slow boot on a throttled host from counting.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
# The base image’s entrypoint is the Node binary; naming the script here fixes
# the image’s command, which the server – it takes no arguments – wants anyway.
ENTRYPOINT ["/nodejs/bin/node", "dist/cli.js"]
