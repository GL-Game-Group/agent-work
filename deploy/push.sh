#!/bin/sh
# From a development machine: send the files the server builds from, then run update.sh there.
#   AGENT_WORK_SERVER=root@47.236.206.86 deploy/push.sh
# Only what the image and compose need is sent; deploy/.env stays on the server.
set -eu
cd "$(dirname "$0")/.."
server="${AGENT_WORK_SERVER:?set AGENT_WORK_SERVER, e.g. root@47.236.206.86}"
ssh_opts="${AGENT_WORK_SSH_OPTS:-}"
files="package.json pnpm-lock.yaml pnpm-workspace.yaml gateway/package.json gateway/src gateway/tsconfig.json
admin plugins/team-bundle/package.json plugins/tunnel/package.json
deploy/Dockerfile deploy/Dockerfile.dockerignore deploy/compose.yml deploy/dynamic.yml deploy/frps.toml deploy/frpc-ingress.toml
deploy/.env.example deploy/backup.sh deploy/update.sh"
tag="$(tar -cf - --exclude node_modules --exclude .svelte-kit --exclude 'admin/build' --exclude .DS_Store ${files} | shasum -a 256 | cut -c1-12)"
echo "agent-work: sending ${tag} to ${server}"
# shellcheck disable=SC2086
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf - --exclude node_modules --exclude .svelte-kit --exclude 'admin/build' --exclude .DS_Store ${files} \
  | ssh ${ssh_opts} "${server}" "mkdir -p /opt/agent-work && rm -rf /opt/agent-work/admin /opt/agent-work/gateway/src && tar -xzf - -C /opt/agent-work --no-same-owner && /opt/agent-work/deploy/update.sh ${tag}"
