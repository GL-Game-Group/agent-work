#!/usr/bin/env bash
# agent-deploy: deploy one HTTP service to the office test cluster through the Rancher
# Kubernetes API proxy. All parameters come from .env (see .env.example).
#
#   ./deploy.sh plan      render manifests and show the diff against the cluster
#   ./deploy.sh apply     deploy, wait until ready, check the public URL (default)
#   ./deploy.sh status    show the deployment, pods and ingress
#   ./deploy.sh logs      tail the application logs
#   ./deploy.sh delete    remove the application
#
# ENV_FILE=/path/.env ./deploy.sh ...   to use another parameter file.
set -euo pipefail

action=${1:-apply}
here=$(cd "$(dirname "$0")" && pwd)
env_file=${ENV_FILE:-$here/.env}
[ -f "$env_file" ] || { echo "error: $env_file not found (copy .env.example to .env)" >&2; exit 2; }
env_dir=$(cd "$(dirname "$env_file")" && pwd)

# Load KEY=VALUE lines only; a trailing " # comment" is ignored.
while IFS= read -r line; do
  line=$(printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//')
  export "$line"
done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file")

fail() { echo "error: $*" >&2; exit 2; }
need() { [ -n "${!1:-}" ] || fail "$1 is not set in $env_file"; }

# --- targets known to this tool (cluster name -> Rancher cluster id) ---
case "${DEPLOY_TARGET:-}" in
  office-test) cluster_id=c-k8qft ;;
  aliyun-prod|aws-prod) fail "$DEPLOY_TARGET is production: deploy through GitOps (PR to GL-Game-Group/infra), not this tool" ;;
  *) fail "unknown DEPLOY_TARGET '${DEPLOY_TARGET:-}' (allowed: office-test)" ;;
esac

for v in KUBECONFIG_FILE DEPLOY_NAMESPACE DEPLOYED_BY APP_NAME APP_IMAGE APP_PORT; do need "$v"; done

kubeconfig=$KUBECONFIG_FILE; [[ $kubeconfig = /* ]] || kubeconfig="$env_dir/$kubeconfig"
[ -f "$kubeconfig" ] || fail "kubeconfig $kubeconfig not found"
k() { kubectl --kubeconfig "$kubeconfig" -n "$DEPLOY_NAMESPACE" "$@"; }

server=$(kubectl --kubeconfig "$kubeconfig" config view --minify -o jsonpath='{.clusters[0].cluster.server}')
[[ $server == */k8s/clusters/$cluster_id ]] || fail "kubeconfig points to $server, not to $DEPLOY_TARGET ($cluster_id)"

[[ $APP_NAME =~ ^[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?$ ]] || fail "APP_NAME must be lowercase letters, digits and '-', at most 40 characters"
[[ $APP_IMAGE =~ :[A-Za-z0-9_.-]+$ || $APP_IMAGE == *@sha256:* ]] || fail "APP_IMAGE needs an explicit tag (e.g. the commit SHA)"
[[ $APP_IMAGE != *:latest ]] || fail "APP_IMAGE must not use :latest"
[[ $APP_PORT =~ ^[0-9]+$ ]] || fail "APP_PORT must be a number"

public=${APP_PUBLIC:-true}
host=${APP_HOST:-$APP_NAME.glwork.dev}
if [ "$public" = true ]; then
  [[ $host =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?\.(int\.)?glwork\.dev$ ]] \
    || fail "APP_HOST '$host' is not allowed: test services use <name>.glwork.dev or <name>.int.glwork.dev"
fi

health=${APP_HEALTH_PATH:-/}; replicas=${APP_REPLICAS:-1}
cpu_req=${APP_CPU_REQUEST:-50m}; mem_req=${APP_MEMORY_REQUEST:-64Mi}; mem_lim=${APP_MEMORY_LIMIT:-256Mi}
frps=${FRPS_IP:-8.217.141.116}; commit=${APP_COMMIT:-}
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

render() {
  cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $APP_NAME
  labels: {app.kubernetes.io/name: $APP_NAME, app.kubernetes.io/managed-by: agent-deploy}
  annotations:
    glwork.net/deployed-by: "$DEPLOYED_BY"
    glwork.net/deployed-at: "$now"
    glwork.net/commit: "$commit"
    glwork.net/via: agent-deploy
    kubernetes.io/change-cause: "$APP_IMAGE by $DEPLOYED_BY"
spec:
  replicas: $replicas
  revisionHistoryLimit: 10
  selector:
    matchLabels: {app.kubernetes.io/name: $APP_NAME}
  template:
    metadata:
      labels: {app.kubernetes.io/name: $APP_NAME}
    spec:
$( [ -n "${IMAGE_PULL_SECRET:-}" ] && printf '      imagePullSecrets: [{name: %s}]\n' "$IMAGE_PULL_SECRET" )
      containers:
        - name: app
          image: $APP_IMAGE
          ports: [{name: http, containerPort: $APP_PORT}]
$( [ -n "${APP_ENV_SECRET:-}" ] && printf '          envFrom: [{secretRef: {name: %s}}]\n' "$APP_ENV_SECRET" )
          readinessProbe:
            httpGet: {path: "$health", port: http}
            periodSeconds: 10
          resources:
            requests: {cpu: $cpu_req, memory: $mem_req}
            limits: {memory: $mem_lim}
---
apiVersion: v1
kind: Service
metadata:
  name: $APP_NAME
  labels: {app.kubernetes.io/name: $APP_NAME, app.kubernetes.io/managed-by: agent-deploy}
spec:
  selector: {app.kubernetes.io/name: $APP_NAME}
  ports: [{name: http, port: 80, targetPort: http}]
YAML
  if [ "$public" = true ]; then
    cat <<YAML
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: $APP_NAME
  labels: {app.kubernetes.io/name: $APP_NAME, app.kubernetes.io/managed-by: agent-deploy}
  annotations:
    external-dns.kubernetes.io/target: "$frps"
    external-dns.kubernetes.io/cloudflare-proxied: "false"
spec:
  ingressClassName: traefik
  tls: [{hosts: [$host]}]
  rules:
    - host: $host
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: {service: {name: $APP_NAME, port: {name: http}}}
YAML
  fi
}

record() {  # local usage record next to .env
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$DEPLOYED_BY" "$action" "$DEPLOY_TARGET/$DEPLOY_NAMESPACE/$APP_NAME" "$APP_IMAGE" "${commit:--}" "$1" >> "$env_dir/deploy-history.log"
}

case "$action" in
  plan)
    render | k diff -f - || true ;;
  apply)
    trap 'record failed' ERR
    render | k apply -f -
    k rollout status "deploy/$APP_NAME" --timeout=300s
    if [ "$public" = true ] && [[ $host != *.int.glwork.dev ]]; then
      echo "waiting for https://$host (DNS is created within ~1 minute) ..."
      ok=
      for _ in $(seq 1 24); do
        # Normal DNS first (works behind local proxies/VPNs); pinned to the relay IP
        # second (works before the DNS record has propagated).
        code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$host$health" || true)
        [[ $code =~ ^[23] ]] && { ok=1; break; }
        code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' --resolve "$host:443:$frps" "https://$host$health" || true)
        [[ $code =~ ^[23] ]] && { ok=1; break; }
        sleep 5
      done
      [ -n "$ok" ] && echo "ok: https://$host" || echo "warning: https://$host not answering yet (last HTTP $code); check: ./deploy.sh status"
    fi
    trap - ERR
    record ok ;;
  status)
    k get deploy,pods,svc,ingress -l app.kubernetes.io/name="$APP_NAME" -o wide ;;
  logs)
    k logs "deploy/$APP_NAME" --tail="${TAIL:-200}" -f ;;
  delete)
    k delete ingress,service,deployment -l app.kubernetes.io/name="$APP_NAME" --ignore-not-found
    record ok
    echo "note: the DNS record for $host is not removed automatically; ask the platform team to delete it." ;;
  *)
    fail "unknown action '$action' (plan | apply | status | logs | delete)" ;;
esac
