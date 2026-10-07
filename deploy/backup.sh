#!/bin/sh
# A consistent copy of the company data (PGlite's directory on the data volume), kept 14 days.
# PGlite belongs to the running service alone, so the service stops for the few seconds the copy
# takes and starts again. With DATABASE_URL (a PostgreSQL server), back up that server instead.
# Runs on the server from deploy/: ./backup.sh [label]   (cron: daily; update.sh: before each update)
set -eu
cd "$(dirname "$0")"
label="${1:-daily}"
if grep -q '^DATABASE_URL=.' .env 2>/dev/null; then
  echo "agent-work: the data is in PostgreSQL (DATABASE_URL); back up that server, nothing to do here"
  exit 0
fi
name="gateway-$(date +%Y%m%d-%H%M%S)-${label}.tar.gz"
running="$(docker compose ps --status running -q agent-work)"
[ -z "${running}" ] || docker compose stop agent-work
docker compose run --rm --no-deps -T agent-work tar -czf "/backups/${name}" -C /data pglite || status=$?
[ -z "${running}" ] || docker compose start agent-work
[ "${status:-0}" -eq 0 ] || exit "${status}"
dir="${BACKUP_DIR:-/opt/agent-work-backups}"
chmod 600 "${dir}/${name}"
find "${dir}" -name 'gateway-*' -mtime +14 -delete
echo "agent-work: backed up to ${dir}/${name}"
