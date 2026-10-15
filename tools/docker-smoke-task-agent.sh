#!/usr/bin/env bash
#
# Smoke-test the built task-agent image the way a Kubernetes pod uses it: copy
# the executable into a shared volume, as the init container does, then run it
# as the command of the upstream QLever image, as the sidecar does, and probe
# it from there, as the startup probe does. A broken single executable – a
# bundle that misses a module, or a Node binary that links a library the QLever
# image lacks – passes `docker build` yet fails here.
#
# Usage: docker-smoke-task-agent.sh <image-tag> [<sidecar-image>]
set -euo pipefail

image="$1"
sidecar_image="${2:-adfreiburg/qlever:commit-a14e0a0}"
volume="task-agent-smoke-$$"
container="task-agent-smoke-$$"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null
# Root, so the copy can write to a fresh volume, which root owns.
docker run --rm --user 0 --entrypoint cp -v "$volume:/agent" "$image" \
  /task-agent /agent/task-agent
docker run --detach --name "$container" -v "$volume:/agent" \
  --entrypoint /agent/task-agent "$sidecar_image" >/dev/null

for _ in $(seq 1 20); do
  if docker exec "$container" /agent/task-agent --probe; then
    echo "PASS: the agent from $image started in $sidecar_image and answered its probe"
    exit 0
  fi
  sleep 0.5
done

echo "FAIL: the agent from $image did not answer its probe in $sidecar_image:"
docker logs "$container"
exit 1
