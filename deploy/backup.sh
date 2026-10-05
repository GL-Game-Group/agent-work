#!/bin/sh
# A consistent copy of the company database (VACUUM INTO), kept 14 days.
# Runs on the server from deploy/: ./backup.sh [label]   (cron: daily; update.sh: before each update)
set -eu
cd "$(dirname "$0")"
label="${1:-daily}"
name="gateway-$(date +%Y%m%d-%H%M%S)-${label}.db"
docker compose exec -T agent-work node -e "
const { DatabaseSync } = require('node:sqlite')
new DatabaseSync('/data/gateway.db').exec(\"VACUUM INTO '/backups/${name}'\")
"
dir="${BACKUP_DIR:-/opt/agent-work-backups}"
chmod 600 "${dir}/${name}"
find "${dir}" -name 'gateway-*.db' -mtime +14 -delete
echo "agent-work: backed up to ${dir}/${name}"
