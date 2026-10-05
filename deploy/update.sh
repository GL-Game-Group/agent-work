#!/bin/sh
# Build and start what is in /opt/agent-work now (push.sh sends it), on the server.
# Backs the database up first, tags the image with the content's hash, and goes back
# to the previous image when the new one does not become healthy.
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy/.env is missing (copy .env.example)"; exit 1; }
previous="$(cat .image-tag 2>/dev/null || echo latest)"
tag="${1:?usage: update.sh <tag>}"

if docker compose ps --status running agent-work -q | grep -q .; then ./backup.sh "before-${tag}"; fi
IMAGE_TAG="${tag}" docker compose build agent-work
IMAGE_TAG="${tag}" docker compose up -d --remove-orphans

health() { docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q agent-work)"; }
for _ in $(seq 1 30); do
  [ "$(health)" = healthy ] && break
  sleep 2
done
if [ "$(health)" != healthy ]; then
  echo "agent-work: ${tag} is not healthy; going back to ${previous}"
  docker compose logs --tail 50 agent-work
  IMAGE_TAG="${previous}" docker compose up -d agent-work
  exit 1
fi
echo "${tag}" > .image-tag
docker image prune -f >/dev/null
echo "agent-work: running ${tag}"
