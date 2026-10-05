# AGENT_DEPLOY：把服务部署到公司内网测试集群（AI agent 用）

> 本文件自包含，可直接放进任何项目供 AI agent 阅读。来源：`GL-Game-Group/infra` 仓库 `agent-deploy/`（2026-10-05 版，已实测）。
> 平台域名约定：`*.glwork.net` 公司自己的服务（如 `rancher.glwork.net`），`<应用>.glwork.dev` 测试服务，`<隧道>.glwork.app` 隧道。
> 发布通知：每次发布成功或失败都会推送到公司 Telegram 群。
> 镜像仓库：阿里云 ACR `glwork-registry.cn-hongkong.cr.aliyuncs.com/glwork/<应用名>`，由组织流水线 `GL-Game-Group/.github` 的 `build-image.yml` 构建推送。

## 0. 在本项目中安装（首次）

如果项目里还没有 `deploy/agent-deploy/` 目录，按下面步骤创建（文件内容见文末「附录」，必须原样写入）：

```bash
mkdir -p deploy/agent-deploy && cd deploy/agent-deploy
# 1. 写入附录 A 的 deploy.sh，并执行：chmod +x deploy.sh
# 2. 写入附录 B 的 .env.example
# 3. 写入附录 C 的 .gitignore
cp .env.example .env          # 然后按「参数」一节填写 .env
# 4. 把平台方发来的 kubeconfig 放到本目录（文件名与 .env 中 KUBECONFIG_FILE 一致）
```

安装后，下文所有命令都在 `deploy/agent-deploy/` 目录下执行。kubeconfig 只能由平台方签发，不要自己生成，也不要提交到 Git。

用于把一个 HTTP 服务部署到**公司内网测试集群 `office-test`**。
所有参数写在 `.env`，执行 `./deploy.sh` 即可完成部署、等待就绪、验证访问并留下记录。

用于把一个 HTTP 服务部署到**公司内网测试集群 `office-test`**。
所有参数写在 `.env`，执行 `./deploy.sh` 即可完成部署、等待就绪、验证访问并留下记录。

## 你必须遵守的规则

1. 只能部署到 `DEPLOY_TARGET=office-test`。正式集群（`aliyun-prod`、`aws-prod`）只能通过向 `GL-Game-Group/infra` 提 PR 发布，`deploy.sh` 会拒绝。
2. 只能使用分配给你的命名空间（`DEPLOY_NAMESPACE`）。不要创建命名空间，不要操作其他命名空间。
3. 域名只能是 `<名称>.glwork.dev`（公网可访问）或 `<名称>.int.glwork.dev`（仅公司内网）。只用一级子域名。
   - `*.glwork.net` 是公司自己的服务（如 `rancher.glwork.net`），`*.glwork.app` 是隧道域名，**都不能**用于测试服务。
4. 镜像必须带明确标签（推荐 commit SHA），禁止 `:latest`。
5. `.env` 里注释写在单独的行，值后面不要加注释。密码、token 不写进 `.env` 以外的任何文件，不提交到 Git，不打印到日志。应用需要的密钥放在命名空间的 Secret 里（见下文）。
6. 对外服务默认完全开放，平台不加登录保护。部署前确认服务自带鉴权，没有未授权的管理接口。
7. 不要绕过 `deploy.sh` 用 `kubectl` 手工修改资源（查看和排错除外），否则部署记录会不完整。

## 准备

需要：`bash`、`kubectl`（1.30 以上）、`curl`，以及平台方发给你的 kubeconfig 文件。

```bash
cp .env.example .env
# 把 kubeconfig 放到本目录，或在 .env 的 KUBECONFIG_FILE 写绝对路径
kubectl --kubeconfig ./agent-work.kubeconfig get pods      # 连接测试，应正常返回（可能为空）
```

`.env` 和 `*.kubeconfig` 已在 `.gitignore` 中，不会被提交。

## 参数（.env）

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEPLOY_TARGET` | 是 | `office-test` | 目标集群，目前只允许 `office-test` |
| `KUBECONFIG_FILE` | 是 | `./agent-work.kubeconfig` | 平台签发的 kubeconfig；相对路径以 `.env` 所在目录为准 |
| `DEPLOY_NAMESPACE` | 是 | `agent-work` | 分配给你的命名空间 |
| `DEPLOYED_BY` | 是 | — | 部署人：agent 名称或你的名字，写入部署记录与资源注解 |
| `APP_NAME` | 是 | — | 应用名，小写字母/数字/连字符，最长 40；也是资源名 |
| `APP_IMAGE` | 是 | — | 镜像，必须带标签；推荐 `glwork-registry.cn-hongkong.cr.aliyuncs.com/glwork/<应用名>:<commit SHA>` |
| `APP_PORT` | 是 | `8080` | 容器端口 |
| `APP_HEALTH_PATH` | 否 | `/` | 就绪检查路径，返回 2xx/3xx 视为就绪 |
| `APP_REPLICAS` | 否 | `1` | 副本数 |
| `APP_CPU_REQUEST` / `APP_MEMORY_REQUEST` / `APP_MEMORY_LIMIT` | 否 | `50m` / `64Mi` / `256Mi` | 资源 |
| `APP_ENV_SECRET` | 否 | — | 已存在的 Secret 名，其键值注入为环境变量 |
| `IMAGE_PULL_SECRET` | 否 | — | ACR 以外的私有镜像仓库的拉取凭据 Secret 名；ACR 镜像不需要 |
| `APP_COMMIT` | 否 | — | 对应的代码提交，写入记录 |
| `APP_PUBLIC` | 否 | `true` | `false` 时不建 Ingress，只能集群内访问 |
| `APP_HOST` | 否 | `<APP_NAME>.glwork.dev` | 访问域名 |
| `FRPS_IP` | 否 | `8.217.141.116` | 香港中转 IP，一般不改 |

一个应用一份 `.env`。部署多个应用时，为每个应用准备一个文件，用 `ENV_FILE=path/to/app.env ./deploy.sh apply` 指定。

## 命令

```bash
./deploy.sh plan     # 预览：渲染清单并与集群现状对比，不做修改
./deploy.sh apply    # 部署：应用清单 → 等待就绪（最多 5 分钟）→ 验证 https://<APP_HOST>
./deploy.sh status   # 查看 Deployment / Pod / Service / Ingress
./deploy.sh logs     # 跟踪日志（TAIL=500 ./deploy.sh logs 调整行数）
./deploy.sh delete   # 下线
```

推荐流程：`plan` 确认变更 → `apply` → 看到 `ok: https://...` 即完成。实测从 `apply` 到可访问约 10-60 秒（首次部署需等 DNS 生成）。

`apply` 的成功输出最后一行是：

```text
ok: https://<APP_HOST>
```

如果是 `warning: ... not answering yet`，部署已完成但访问检查未通过，执行 `./deploy.sh status` 和 `./deploy.sh logs` 排查。

## 应用需要的密钥

```bash
kubectl --kubeconfig ./agent-work.kubeconfig -n agent-work create secret generic my-app-env \
  --from-literal=DATABASE_URL='...' --from-literal=API_KEY='...'
# 然后在 .env 中：APP_ENV_SECRET=my-app-env
```

更新密钥后需重新 `./deploy.sh apply`（或 `kubectl rollout restart deploy/<APP_NAME>`）让 Pod 读到新值。

## 使用记录

每次 `apply` / `delete` 都会留下三处记录：

| 位置 | 内容 |
| --- | --- |
| `.env` 同目录下的 `deploy-history.log` | 时间、部署人、动作、目标/命名空间/应用、镜像、提交、结果（每行一条，制表符分隔） |
| Deployment 注解 `glwork.net/deployed-by`、`glwork.net/deployed-at`、`glwork.net/commit`、`glwork.net/via` | 当前线上版本由谁、何时、从哪个提交部署 |
| Rancher 审计日志 | 平台侧记录每次 API 操作对应的账号（由平台方查看） |
| Telegram 发布通知群 | 发布成功 / 失败的实时消息，包含应用、镜像、部署人（`DEPLOYED_BY`）、提交（`APP_COMMIT`）和访问地址 |

`DEPLOYED_BY` 和 `APP_COMMIT` 会显示在群消息里，请如实填写。

查看历史版本与回滚：

```bash
kubectl --kubeconfig ./agent-work.kubeconfig -n agent-work rollout history deploy/<APP_NAME>
# 回滚推荐：把 .env 的 APP_IMAGE 改回旧标签后重新 ./deploy.sh apply，这样记录完整
```

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `error: ... is production` | 目标是正式集群，改走 infra 仓库 PR |
| `error: APP_HOST ... is not allowed` | 域名不合规，改成 `<名称>.glwork.dev` |
| `error: kubeconfig points to ...` | kubeconfig 不是测试集群的，向平台方确认 |
| `Forbidden` / `401` | kubeconfig 过期（有效期 90 天）或命名空间不对，联系平台方重新签发 |
| `rollout status` 超时 | `./deploy.sh status` 看 Pod：`ImagePullBackOff`（镜像名错、缺拉取凭据或镜像过大拉取慢）、`CrashLoopBackOff`（看日志）、未就绪（检查 `APP_HEALTH_PATH` 和 `APP_PORT`） |
| 访问 404 | `APP_HOST` 与访问域名不一致，或就绪检查路径不存在 |
| 访问 502/503 | Pod 未就绪 |

镜像建议：

- 用公司镜像仓库阿里云 ACR（`glwork-registry.cn-hongkong.cr.aliyuncs.com/glwork/<应用名>`）。在应用仓库加一个调用组织流水线的 workflow 即可自动构建推送：

```yaml
jobs:
  image:
    uses: GL-Game-Group/.github/.github/workflows/build-image.yml@main
    secrets: inherit
```

- 集群节点已配置 ACR 凭据，`APP_IMAGE` 直接写 ACR 地址，不需要 `IMAGE_PULL_SECRET`。
- 内网拉 ACR：多层的小镜像很快（约 45 MB 用时 20 秒）；但每一层是单连接下载，**单层几百 MB 的镜像会很慢**。Dockerfile 里把大文件（模型、依赖包）拆到多个层，或联系平台方预置。
- 不要用 ghcr.io / docker.io 的镜像作为测试环境的运行镜像：内网拉取 ghcr 约 20 KB/s，docker.io 不可达。

## 下线

```bash
./deploy.sh delete
```

DNS 记录不会自动删除（平台的 external-dns 为只增不删），下线后请通知平台方清理 `<APP_HOST>` 的解析。

## 平台方参考

- 新增租户 / 命名空间：`tofu/stacks/mgmt/tenants.tf` 的 `tenants` 变量，`tofu apply`。
- 签发 / 续期 kubeconfig：`scripts/tenant-kubeconfig.sh <租户> 90 <输出文件>`；作废：`kubectl --kubeconfig ~/.kube/infra-mgmt.yaml delete tokens.management.cattle.io <token 名>`。
- 新增可部署的目标集群：在 `deploy.sh` 的 `DEPLOY_TARGET` 分支里登记集群名和 Rancher 集群 ID。


## 附录 A：deploy.sh

```bash
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
```

## 附录 B：.env.example

```bash
# ===== agent-deploy 参数（复制为 .env 后填写；.env 不要提交到 Git）=====
# 注释写在单独的行；值后面不要加注释。

# --- 部署目标 ---
# 集群名。当前只允许 office-test（公司内网测试集群）；
# aliyun-prod / aws-prod 只能走 GitOps（向 infra 仓库提 PR），本脚本会拒绝。
DEPLOY_TARGET=office-test
# 平台方签发的 kubeconfig 文件路径（相对 .env 所在目录或绝对路径）
KUBECONFIG_FILE=./agent-work.kubeconfig
# 你的团队命名空间（由平台方分配，不能自己创建）
DEPLOY_NAMESPACE=agent-work
# 部署人：agent 名称或你的名字，会写进部署记录和资源注解
DEPLOYED_BY=

# --- 应用 ---
# 应用名：小写字母、数字、连字符，最长 40 个字符；同时作为资源名
APP_NAME=
# 镜像，必须带明确标签（推荐 commit SHA），不允许 :latest。
# 推荐用公司镜像仓库（阿里云 ACR，组织流水线 build-image.yml 自动推送），集群节点已配置凭据：
#   glwork-registry.cn-hongkong.cr.aliyuncs.com/glwork/<应用名>:<commit SHA>
APP_IMAGE=
# 容器监听端口
APP_PORT=8080
# 就绪检查路径（HTTP GET 返回 2xx/3xx 视为就绪）
APP_HEALTH_PATH=/
APP_REPLICAS=1
APP_CPU_REQUEST=50m
APP_MEMORY_REQUEST=64Mi
APP_MEMORY_LIMIT=256Mi
# 可选：命名空间里已存在的 Secret 名，其中的键会作为环境变量注入（数据库密码等放这里）
APP_ENV_SECRET=
# 可选：ACR 以外的私有镜像仓库的拉取凭据 Secret 名（ACR 镜像不需要）
IMAGE_PULL_SECRET=
# 可选：本次部署对应的代码提交，写进部署记录
APP_COMMIT=

# --- 访问 ---
# true：公网可访问（经香港 frp 中转）；false：只在集群内部访问，不建 Ingress
APP_PUBLIC=true
# 访问域名。留空则用 <APP_NAME>.glwork.dev。
# 测试服务只能用 <名称>.glwork.dev（公网）或 <名称>.int.glwork.dev（仅内网）。
APP_HOST=

# --- 平台参数（一般不用改）---
# 香港 frps 公网 IP：测试域名的 DNS 记录指向这里
FRPS_IP=8.217.141.116
```

## 附录 C：.gitignore

```text
.env
*.kubeconfig
deploy-history.log
```
