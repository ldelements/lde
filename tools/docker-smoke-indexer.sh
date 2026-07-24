#!/usr/bin/env bash
#
# Smoke-test the built search-indexer image by actually running it: boot with
# a fixture schema module and `--check`, which loads the full module graph and
# validates configuration, then exits. `nx … docker:build` only *builds* the
# image, so a runtime-only failure – e.g. a runtime dependency missing from
# the pruned image, surfacing as `ERR_MODULE_NOT_FOUND` at boot – passes the
# build yet crashes in production. This is the gate that catches that class
# before it ships. The indexer is a batch process, so unlike docker-smoke.sh
# (the HTTP-server variant) there is no port to probe: a clean `--check` exit
# is the startup signal.
#
# Usage: docker-smoke-indexer.sh <image-tag>
set -euo pipefail

image="$1"

# Dummy values: we test module resolution and startup, not behaviour. Nothing
# connects during --check. The schema module ships into the container only for
# this smoke via the test fixture bind mount.
if output="$(docker run --rm \
  -e REGISTRY_ENDPOINT=https://registry.invalid/sparql \
  -e TYPESENSE_HOST=localhost \
  -e TYPESENSE_API_KEY=dummy \
  -v "$(pwd)/packages/search-indexer/test/fixtures/search-schema.mjs:/config/search-schema.mjs:ro" \
  "$image" node dist/cli.js --check 2>&1)"; then
  if echo "$output" | grep -q "configuration and schema module .* are valid"; then
    echo "PASS: $image booted, loaded the schema module and validated configuration"
    exit 0
  fi
  echo "FAIL: $image exited 0 but did not report a valid configuration:"
  echo "$output"
  exit 1
fi

echo "FAIL: $image failed --check:"
echo "$output"
if echo "$output" | grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find (package|module)"; then
  echo "(module-resolution error: a runtime dependency is missing from the pruned image)"
fi
exit 1
