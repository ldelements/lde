# The task agent as a single executable for glibc Linux, in an image an init
# container copies it from: `cp /task-agent <shared emptyDir>`, after which a
# sidecar runs it as its command in an image that has no Node of its own, such
# as the upstream QLever image. See docs/reference/task-runner-http.md.
#
# `nx run @lde/task-runner-http:docker:build` bundles the agent and its
# dependencies into dist-agent/agent.cjs first (bundle-agent), so this build
# needs no npm install. Each architecture is built on its own runner
# (.github/workflows/docker.yml), because the executable is that platform’s
# Node binary with the bundle injected.
#
# Node 24, not 26: from Node 26 on, the Linux binaries link libatomic, which
# the upstream QLever image (Ubuntu 24.04) does not have. Node 24 has no
# --build-sea yet, so postject injects the blob into a copy of its binary.
FROM node:24-bookworm-slim AS sea

WORKDIR /build
COPY dist-agent/agent.cjs agent/sea-config.json ./
RUN node --experimental-sea-config sea-config.json \
  && cp "$(command -v node)" task-agent \
  && npx --yes postject@1.0.0-alpha.6 task-agent NODE_SEA_BLOB sea-prep.blob \
       --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Debian, not distroless or scratch: the init container needs `cp`, and the
# smoke test runs the executable here, which needs glibc.
FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/ldelements/lde"

COPY --from=sea /build/task-agent /task-agent

USER 65532:65532
ENTRYPOINT ["/task-agent"]
