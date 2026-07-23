#!/usr/bin/env bash
#
# Smoke-test a built application image by actually running it and asserting it
# reaches startup and serves HTTP. `nx … docker:build` only *builds* the image,
# so a runtime-only failure – e.g. a runtime dependency missing from the pruned
# image, surfacing as `ERR_MODULE_NOT_FOUND` at boot – passes the build yet
# crashes in production. This is the gate that catches that class before it
# ships.
#
# Usage: docker-smoke.sh <image-tag>
set -euo pipefail

image="$1"
container="smoke-${image}-$$"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Dummy values: we test module resolution and startup, not behaviour. The
# Typesense client connects lazily, so an unreachable host does not block boot.
# The schema module ships in the image only for this smoke via the test
# fixture bind mount.
docker run -d --name "$container" -p 4000 \
  -e SCHEMA_MODULE=/config/search-schema.mjs \
  -e TYPESENSE_HOST=localhost \
  -e TYPESENSE_API_KEY=dummy \
  -v "$(pwd)/packages/search-api-server/test/fixtures/search-schema.mjs:/config/search-schema.mjs:ro" \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  logs="$(docker logs "$container" 2>&1)"
  # Check failure conditions before success: a container that logged the
  # startup line and then crashed must be reported FAIL, not PASS.
  if echo "$logs" | grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find (package|module)"; then
    echo "FAIL: $image hit a module-resolution error at startup:"
    echo "$logs"
    exit 1
  fi
  if [ "$(docker inspect -f '{{.State.Status}}' "$container")" = "exited" ]; then
    echo "FAIL: $image exited before reaching startup:"
    echo "$logs"
    exit 1
  fi
  if echo "$logs" | grep -qE "serving /graphql"; then
    host_port="$(docker port "$container" 4000/tcp | head -1 | sed 's/.*://')"
    health_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${host_port}/health" || true)"
    if [ "$health_code" != "200" ]; then
      echo "FAIL: $image reached startup but served /health with HTTP ${health_code:-000} (expected 200)"
      exit 1
    fi
    sdl="$(curl -s "http://localhost:${host_port}/graphql?sdl" || true)"
    if ! echo "$sdl" | grep -q "type Query"; then
      echo "FAIL: $image served /health but /graphql?sdl returned no schema:"
      echo "$sdl" | head -5
      exit 1
    fi
    echo "PASS: $image reached startup and serves /health and /graphql?sdl"
    exit 0
  fi
  sleep 1
done

echo "FAIL: $image did not reach startup within 30s:"
docker logs "$container" 2>&1
exit 1
