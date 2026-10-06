# agent-work

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的团队内部 AI 工作台：每个成员使用品牌化的官方桌面端（Host 运行在本机），用 GitHub 账号登录公司服务；登录后，公司服务下发模型配置、模型网关 Key 和团队插件。官方代码以 git submodule 只读引入；对上游的改动分为补丁、覆盖文件、插件三层，构建时组合到一份独立副本中。

| 目录 | 内容 | 规则 |
|---|---|---|
| `upstream/` | 官方仓库 submodule，固定在 `upstream.json` 记录的 tag 与提交 | 只读。`pnpm check:upstream` 拒绝任何本地改动 |
| `patches/` | 必须改动上游源码的地方，`git format-patch` 格式 | 只用于写死的值；每个补丁只做一件事，能提给上游的就提 |
| `overlay/` | 按相同路径覆盖到副本上的文件：图标、安装器素材、打包配置模板 | 不改源码，只替换文件 |
| `plugins/` | 团队插件，独立的 pnpm workspace | 功能代码只写在这里 |
| `build/upstream/` | 构建副本：submodule 的 git worktree + 补丁 + 覆盖文件 | 生成物，Git 忽略 |
| `gateway/` | 公司服务的核心：GitHub 登录、桌面端设备令牌、模型网关、配置下发（`/agent-work/*` 的协议），以及后台用到的数据和业务规则（`services.ts`）、管理员命令行。Node 24 直接运行 TypeScript，没有运行时依赖 | 安全边界：改动必须带测试 |
| `admin/` | 管理后台和成员工作台（SvelteKit + shadcn-svelte）。和 `gateway/` 跑在同一个进程里，`server.js` 是公司服务在生产环境的入口 | 页面只调用 `gateway/src/services.ts`，业务规则不写在页面里 |

## 公司服务

```
成员电脑：品牌化官方桌面端（Host 运行在本机）
  公司账号插件（替换 deepseek-account）── GitHub 登录 ──▶ 公司服务 https://agent.glwork.net（公司内网集群，经香港 frps 对外）
  模型请求 ── 每人一个网关 Key ──▶ 统一模型网关 ──▶ DeepSeek / 其他厂商
```

- **账号**：成员用 GitHub 登录，公司服务按 GitHub 数字 ID 查找成员，还要求是 `GL-Game-Group` 组织的成员。只有管理员添加过的人才能登录。
- **凭据**：
  - 桌面端用设备令牌（`Authorization: Bearer awd_…`，有效期 90 天）；
  - 浏览器会话用于管理后台和成员工作台（Cookie，有效期 14 天）；
  - 成员的内部 Key（`Bearer awk_…`，在工作台自助生成或由管理员签发），给 Claude Code、脚本等工具用：能调用自己开通的模型、读取系统配置，不能打开后台，也不能代替桌面端拿配置。
- **厂商、Key 和账号**：厂商在管理后台维护，分两种登录方式。
  - **API Key 类**（内置千问、DeepSeek）：Key 用 `AGENT_WORK_SECRET_KEY` 以 AES-256-GCM 加密保存在服务端，后台只显示末尾 4 位，永远不下发到成员电脑。录入一个 Key 之后可以从厂商刷新模型列表，再勾选给成员开放哪些模型。
  - **账号类**（内置 Codex、Claude、Qoder）：只记录账号，不保存密码；一个账号同时只分给一个成员，成员用厂商的官方流程自己登录。
  - 给成员开通厂商时，自动分配使用人数最少的可用 Key，或一个空闲账号；还没有可分配的，等录入之后自动补上。Key 停用或删除后，使用它的成员改用同厂商的其他 Key。
- **模型网关**：`/agent-work/llm/<厂商标识>/*` 原样转发到厂商接口（Anthropic Messages 或 OpenAI 兼容），只把认证换成分配给这个成员的 Key，并拒绝没有开放的模型。成员的 Host 用自己的设备令牌访问，吊销设备或停用成员后立即失效。token 用量按成员、厂商和 Key 记录。
- **配置下发**：`/agent-work/config` 按成员返回：DeepSeek 写入 Host 自带的 DeepSeek 适配器，其他 API 厂商写成 pi-ai 的 `providers.company-<厂商标识>`；地址都指向模型网关，Key 都是设备令牌。另外附带分给他的 CLI 账号（`accounts`）和公共配置（`public`），客户端插件读取它们的接口还没做。team-bundle 里的 `config-sync.js` 在登录、启动和每 30 分钟时同步，只写白名单里的命名空间，成员自己改过的配置项不会被覆盖，退出登录时清除模型 Key。
- **系统配置**：给工具和客户端插件用的键值（例如 OSS），可以分组、加密保存。工具用内部 Key 读取 `/agent-work/config/system[/<键>]`；所有值（包括加密项）都会发给已登录的成员，只放最小权限的凭据。
- **插件目录**：管理员在后台登记公司插件（DeepSeek Harness 插件包，`npm pack` 打出的 .tgz 放在 OSS）：粘贴下载地址后服务端下载核对，确认是插件、没有安装脚本，记下包名、版本、sha512 和大小，再填名称和权限说明、上架。GL Work 用设备令牌拉取 `GET /agent-work/plugins`（只含已上架的），显示在插件管理页的“公司插件”卡片里（`plugins/team-bundle/company/`）。成员点“安装”并确认权限后，Host 下载插件包、核对 sha512（和登记的不一致就停止），存到 `$DSH_HOME/agent-work/plugins/`，再交给插件管理安装并启用；要执行安装脚本的包会被拒绝。预装的插件随 GL Work 更新，不在这里安装；`POST /agent-work/plugins/installed` 上报本机装了哪些、什么版本，后台显示各台的安装情况和待更新。内网穿透插件随 GL Work 预装，也登记在目录里以便更新。
- **订阅**：公司买的 Claude、Codex、Qoder 订阅（套餐、席位、价格、续费日期、付款人），账号挂在订阅下；续费前 7 天在概览提醒。
- **内网穿透（frp）**：frps 部署在公司服务器，GL Work 里的内网穿透插件运行 frpc，用设备令牌登录（`metas.token`，frp 用户名必须是令牌对应的成员）。frps 通过 server plugin 在登录、开隧道、心跳、关闭隧道时回调 `/agent-work/frp/<AGENT_WORK_FRP_PLUGIN_SECRET>`，只放行在公司服务登记过、且属于这台设备的隧道：网页隧道的地址固定为 `名字-成员.域名`（域名由管理员添加，DNS 和证书检测通过才可用），要求密码的必须带 Basic Auth；SSH 隧道用 STCP，密钥由服务端生成，可连接的成员必须和登记的一致；公网 TCP 端口默认关闭，开了也只能用服务端分配的端口。管理员关闭隧道、收回权限或吊销设备后，下一次心跳被拒绝，frps 断开这台 GL Work，重连时被关闭的隧道不再放行。桌面端接口：`GET/POST /agent-work/tunnels`、`PATCH/DELETE /agent-work/tunnels/<id>`（只接受设备令牌）。`gateway/test/frp.test.ts` 用真实的 frps/frpc 跑一遍（`AGENT_WORK_FRP_DIR=<解压的 frp 发行包目录> node --test gateway/test/frp.test.ts`，不设时跳过）。
- **手机远程（中转）**：GL Work for iOS 用 GitHub 登录公司服务（`GET /agent-work/auth/phone/start?code_challenge&state` → GitHub → 回到 `glwork://auth?code&state` → `POST /agent-work/auth/phone/token`，PKCE），拿到手机令牌 `awp_…`。手机令牌只能做三件事：`GET /agent-work/remote/hosts` 列出自己开了手机远程的电脑、经 `/agent-work/remote/<隧道 id>/api/<方法>`（POST）和 `/api/events.mux`（WebSocket）使用其中一台、退出登录；不能拉配置、不是模型 Key。Mac 端打开手机远程后，公司服务为这台设备登记一条 `remote` 隧道，地址是随机的 `r<24 位十六进制>.remote.internal`，只有公司服务经 frps 的 vhost 端口（`AGENT_WORK_FRPS_VHOST`，容器网络内）能访问，Traefik 不转发这个域名；frps 校验这条代理和设备、地址一致且不带 Basic Auth。中转只转发方法名和请求体，不转发手机令牌和其他请求头；每次请求核对“手机所属成员 = 隧道所属成员、电脑在线、没被管理员关闭、手机远程开着”，打开的 WebSocket 每分钟复查一次，手机被吊销或手机远程被关闭后断开。连接、发送消息、回答提问写审计日志。后台“内网穿透”页可以关闭某台电脑的手机远程，设置里可以整体关闭；“设备”页列出手机，可以吊销。
- **工作区管理插件**（`plugins/workspace`，`@agent-work/dsh-workspace`，随 GL Work 预装）：
  - 侧栏“＋”和空白页的“新建工作区”换成插件的对话框：选本地文件夹（不是 Git 仓库时可以勾选初始化，用户目录和磁盘根目录拒绝初始化），或从公司 GitHub 组织（`GL-Game-Group`）的仓库克隆到 `~/GLWork/<组织>/<仓库>`。选好仓库时先在本机查找已有的克隆（按 origin 判断）：GL Work 的工作区、`~/GLWork`，以及常用代码目录（`~/Documents`、`~/Desktop`、`~/code`、`~/src`、`~/work`、`~/projects` 等，最多 4 层，跳过隐藏目录、`node_modules` 和构建输出；只读 `.git/config`，配置项 `searchRoots` 可改）。找到时可选“基于已有仓库新建工作树（推荐）”“直接打开已有仓库”“重新克隆（不推荐）”，本机有多份时选用哪一份；仓库列表里的“本地已有”也按这个结果。
  - 工作区的“…”菜单（补丁 0011 给它开了 `sidebar.workspaces.workspace.menu.item`）里有“复制为工作区”：从当前分支新建分支 `<GitHub 登录名>/<名字>`，工作树放在仓库旁边的 `<仓库>.worktrees/<名字>`，并注册为新工作区；是工作树的工作区还有“删除工作树”，有未提交改动时要再确认，分支保留。
  - 插件页的“GitHub CLI”：检测 Git 和 gh；没有 gh 时一键安装（`plugins/workspace/gh-release.json` 固定的官方版本，核对 sha256，装在 `$DSH_HOME/agent-work/tools/`，不需要管理员权限）；`gh auth login --web` 登录（页面显示一次性代码，成员在浏览器里授权）；可选“让 git 使用 GitHub 登录”（`gh auth setup-git`，会改 git 全局配置，成员点了才执行）。
  - 所有 git、gh 命令都在成员本机用成员自己的 GitHub 登录执行，公司服务不接触 GitHub 令牌。
- **命令行 Agent 和直连模式**（`plugins/agents`，`@agent-work/dsh-agents`，随 GL Work 预装）：
  - 设置 > 模型底部的“命令行 Agent”（`settings.models.footer`）：检测 Claude Code、Codex、Qoder CLI（PATH 和各官方安装位置），显示版本和登录状态（`claude auth status`、`codex login status`），以及公司分配的订阅账号名。没装的点“安装”：确认后运行 Claude / Qoder 的官方安装脚本（Qoder 带 `--skip-path`，不改终端配置），或下载 `cli-release.json` 固定版本的 Codex 官方程序并核对 sha256，都装到 `~/.local/bin`。“登录”启动各工具自己的登录流程，GL Work 不读取、不保存订阅凭据。
  - 直连模式：三个命令行注册成模型“Claude Code（本机）”“Codex（本机）”“Qoder CLI（本机）”，模型列表里只出现本机检测到的（启动时、安装完成后、打开设置页时和每 5 分钟检测一次；没装的仍可在设置页安装）。选中后每轮只把成员的最新输入交给命令行（GL Work 追加的提醒不交），命令行用自己的会话续接（会话 id 存在 `$DSH_HOME/agent-work/cli-sessions.json`），工作目录是当前工作区，**拥有全部权限**。Claude Code / Qoder 是常驻的 stream-json 进程（Claude 带 `--permission-prompt-tool stdio`），Codex 每轮一次 `codex exec --json`。Claude 的选择题（AskUserQuestion）转成 GL Work 原生的 `ask_user_question` 提问卡片，回答后交还给等待中的 Claude；命令行用到的工具以进度文字显示在思考区。停止按钮中断当前一轮，会话保留。斜杠命令：`/clear` 开新的命令行会话，`/compact` 让命令行压缩上下文，`/cli <内容>` 原样交给命令行。另有一个只挂提问工具、不发系统提示词的“直连模式”预设。
  - 调试：Host 设 `AW_AGENTS_DEBUG=<文件>` 时，把收到的请求和命令行事件逐行写入该文件。
- **服务器地址**：公司账号插件的 `serverOrigin` 默认 `https://agent.glwork.net`，是可以在运行中修改的配置项。登录窗口的“服务器设置”（补丁 0010：账号提供方有 `serverOrigin` 这个可修改的配置项时才显示）通过 `settings/mutate` 把成员选的地址存进他自己的 profile 补丁，“恢复默认”删除这一项。换服务器时，进行中的登录会被取消，旧服务器签发的登录凭据会被删除；只接受 https 地址，本机地址要 `allowLoopbackHttp` 才能用 http。地址不是默认值时，登录窗口会提示当前连接的服务器。
- **公司文档**：用户上拉菜单的“意见反馈”换成“公司文档”，在浏览器打开 `https://work.glwiki.com/`（补丁 0009 给 `ui-settings-account` 加了 `docsUrl`，地址写在 team-bundle 的 `cordis.patch.yml`）。
- **长输入**（`plugins/team-bundle/long-input/`，只有客户端）：给会话框写不下的长内容（比如产品需求）。不另做输入框，而是把会话框本身放大到占满会话区，`@` 引用、附件、模型选择、斜杠命令照常可用，草稿就是会话的草稿。两个入口：会话顶部“对话 / 轨迹”右边的“长输入”页（`conversation.view`，选中时放大，发出后切回“对话”）；会话框工具栏的“展开”按钮（`conversation.input.right`，新会话也有，再点一次或发出后收起）。放大时 Enter 换行、⌘/Ctrl+Enter 发送（按设置的投递方式），`@`/`/` 菜单有高亮项时 Enter 仍是选中；审批和提问卡片照常显示在会话框的位置。上游没有提供会话框尺寸和按键的设置，实现依赖它的几个 DOM 标记（见 CLAUDE.md 已知的坑）。
- **内网穿透插件**（`plugins/tunnel`，`@agent-work/dsh-tunnel`）：“插件”页里的“内网穿透”卡片（`plugins.item`）。Host 端从 `GET /agent-work/tunnels` 读取成员的隧道，只运行登记在这台设备上、成员打开了的隧道，启动 frpc（令牌经环境变量传给 frpc，配置文件里没有令牌）。网页隧道的访问密码只保存在本机 `$DSH_HOME/agent-work/tunnel/local.json`（权限 600），不发给公司服务；同事分享的 SSH 隧道点“连接”后在本机 62200 起的端口监听。frpc 退出会自动重启，GL Work 退出时一起退出。frpc 随插件附带在 `bin/<平台>-<架构>/`：版本和各平台官方发布包的 sha256 固定在 `plugins/tunnel/frpc-release.json`，`scripts/fetch-frpc.mjs` 下载并核对后放进去（不入库）。打包时 `scripts/package.mjs` 只放目标平台的那一个，并在构建副本的 `package.json` 里把它写进 `bin`（`pnpm pack` 只给 `bin` 里的文件保留可执行位）；补丁 0008 把预装插件的 `bin/` 放在 `app.asar.unpacked`，mac 打包时随其他原生程序一起签名。本地开发执行 `pnpm --filter @agent-work/dsh-tunnel fetch-frpc` 取本机平台的 frpc，或在 profile 补丁里用 `config: { frpcPath: <frpc 路径> }` 指定。升级 frpc 时，服务器上的 frps 要升到同一版本。
  同一个插件还有“手机远程”卡片：成员确认后打开，Host 端在 127.0.0.1 的随机端口提供远程协议（`plugins/tunnel/remote.js`，移植自 deepseek-harness-desktop 的 `remote-v1.js`，MIT，见 `THIRD_PARTY_NOTICES.md`；按 dsh 0.2 改了三处：排队消息读 `inbox` 投影，子代理列表读 `subagentCatalog`，`$events` 按新签名打开），frpc 把它发布到公司登记的内部地址，并给每个转发的请求加上 `x-agent-work-remote: <本机密钥>`（密钥只在本机 `local.json` 和 frpc 配置里，权限 600），本地服务没有这个头一律 403，所以本机其他账户也连不上。方法白名单：`host.describe`、`workspace.list`、`session.*`（list/create/history/attachment/models/selectModel/prompt/updateQueue/cancel）、`subagent.*`（list/history/prompt/interrupt），加上 `respond`（审批和提问）和 `events.mux`。手机上的操作等同于在电脑上操作（直连模式的全部权限同样有效），打开前的确认框会说明。
- **管理后台**：网站根路径 `/`，GitHub 登录，只有管理员能进入；普通成员登录后进入自己的工作台 `/me`（开通的 AI 资源和用法、内部 Key、设备、系统配置）。页面在服务端渲染，修改通过表单提交，只接受本站发起的请求；业务规则（不能停用自己、至少保留一个管理员、独立 Key 只给一个人……）都在 `gateway/src/services.ts`，每个操作写审计日志（不记录 Key、令牌和配置值）。内网穿透一页管理隧道、隧道域名和设置。
- GitHub OAuth App 建在 `GL-Game-Group` 组织下，回调地址是 `https://agent.glwork.net/agent-work/auth/github/callback`。
- 管理员命令行的用法见 [cli.ts](gateway/src/cli.ts) 文件开头的说明。

开发：

```sh
pnpm install
pnpm admin:dev           # 完整的公司服务 http://127.0.0.1:5173：模拟 GitHub（登录时选择要扮演的成员）和演示数据，数据在内存里
pnpm admin:dev:github    # 用 gateway/.env 的真实配置（真实 GitHub 登录），端口取 AGENT_WORK_PUBLIC_ORIGIN（默认 8787）
pnpm service:local       # 构建后按生产方式启动（node admin/server.js），读 gateway/.env
pnpm gateway:test        # 公司服务：类型检查 + 测试
pnpm admin:check         # 后台：类型检查 + 构建
pnpm --filter @agent-work/gateway dev   # 只有协议、没有后台的公司服务（调试桌面端登录用），同样带模拟 GitHub
AGENT_WORK_DSH=<装有 dsh 的目录> pnpm --filter @agent-work/dsh-team-bundle test:e2e   # 公司账号插件在真实 Host 里的端到端测试
pnpm --filter @agent-work/dsh-agents test   # 命令行 Agent：检测解析、直连适配器（替身 Claude Code / Codex）
AGENT_WORK_DSH=<装有 dsh 的目录> pnpm --filter @agent-work/dsh-agents test:e2e   # 真实 Host + 替身命令行
pnpm --filter @agent-work/dsh-workspace test   # 工作区管理插件：仓库地址统一格式、命名、git/gh 输出解析
AGENT_WORK_DSH=<装有 dsh 的目录> pnpm --filter @agent-work/dsh-workspace test:e2e   # 真实 Host + git，本地裸仓库扮演 GitHub、替身 gh
pnpm --filter @agent-work/dsh-tunnel test   # 内网穿透插件：frpc 配置和日志解析、手机远程的本地协议服务（设 AGENT_WORK_FRP_DIR 时再用真实 frpc 校验配置）
AGENT_WORK_DSH=<装有 dsh 的目录> AGENT_WORK_FRP_DIR=<frp 发行包目录> node --test plugins/tunnel/test/tunnel.e2e.mjs   # 真实 Host + frps + frpc 的端到端测试
```

数据库会自动迁移（现在是第 6 版，新增隧道相关的表）。迁移前先备份 `gateway.db`，并且要用同一个 `AGENT_WORK_SECRET_KEY`。

让本地的桌面端连到开发服务：在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 加上

```yaml
- id: company-account
  config: { serverOrigin: 'http://127.0.0.1:8787', allowLoopbackHttp: true }
```

## 手机端（iOS）

`mobile/ios`：GL Work for iOS，原生 SwiftUI，iOS 17 起，改编自 DSHRemote（MIT，见 `mobile/ios/LICENSE-DSHRemote`）。对话内容、子代理、审批和提问卡片与远程协议沿用原项目；会话页顶部是标题和“工作区 · 模式 · 模型”、状态（运行中时点它停止）、设置（模型、子代理、回复播报和音色），底部是键盘/语音切换、输入框或“按住说话”（iOS 中文语音识别，实时显示识别文字，松开发送、上滑取消）、“＋”（照片、拍照、文件、引用；文件只发图片和 200KB 以内的文本，文本内容附在消息里），键盘的回车键直接发送；列表页每个工作区一块，“默认工作空间”在最前，工作区标题右侧“＋”直接在该工作区新建会话；配对、扫码、局域网、Tailscale 去掉，换成公司 GitHub 登录（`ASWebAuthenticationSession`，PKCE，回调 `glwork://auth`）和“我的电脑”列表（`GET /agent-work/remote/hosts`；启动或登录后只有一台在线时直接进入它，每次只自动进入一次），所有请求经公司服务中转（见上面的“手机远程（中转）”）。手机令牌存在钥匙串（仅本机）。默认服务器 `https://agent.glgwork.com`，登录页的“服务器设置”可以改。Bundle ID `com.glgwork.work`，只用 TestFlight 内部测试分发，不上架 App Store（避开大陆区的 App 备案和生成式 AI 许可要求）。图标和登录页的标志由 `pnpm brand` 生成。

```bash
# 模拟器构建（不签名）
xcodebuild -project mobile/ios/GLWork.xcodeproj -scheme GLWork -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
# 装到数据线连着的 iPhone 上并打开（调试版，用 Xcode 登录的开发者账号签名；需要 Xcode 支持手机的 iOS 版本、手机已登记并打开开发者模式）
pnpm try:ios                       # 连着多台时加 --device <名称或 UDID>
# 上传 TestFlight：用 overlay/apps/desktop/.env.macos 里的 App Store Connect API Key，云端托管签名，构建号取 UTC 时间
mobile/ios/testflight.sh
```

语音（语音输入、播报）：手机直连厂商，内置两个语音厂商“千问语音”（`qwen-voice`，阿里云百炼）和“火山语音”（`volc-voice`，豆包语音）。管理员在“API Key”里给成员录入并分配 Key（火山填 `APP ID:Access Token`），在后台“AI 管理 → 语音”里分别打开识别和播报、选模型、从官方音色列表更新并勾选开放的音色。手机用手机令牌调 `GET /agent-work/phone/voice`（可用的厂商、模型、音色和官方试听地址）和 `POST /agent-work/phone/voice/token`（`{ vendor }`，公司服务用成员的 Key 换百炼的临时 API Key 或火山的 STS 令牌，有效期 60–1800 秒，按人每小时限次），拿临时令牌直连厂商；成员的 Key 不出公司服务。iOS 原生（本机识别、系统语音）始终可用。

调试版可以用环境变量跳过登录（`SIMCTL_CHILD_` 前缀传给 `xcrun simctl launch`）：`GLWORK_SERVER`（公司服务地址，如 `http://127.0.0.1:8790`）、`GLWORK_TOKEN`（手机令牌）、`GLWORK_MEMBER`、`GLWORK_OPEN_FIRST_HOST=1`（自动打开第一台在线的电脑）、`GLWORK_SCENARIO=live-session` 加 `GLWORK_SESSION=<会话 id>`（直接打开一个会话）、`GLWORK_SCENARIO=projects|conversation`（离线演示数据）。发布版里这些都不生效。TestFlight 构建 90 天后过期，要定期重新上传。



```sh
git clone --recurse-submodules <本仓库地址> agent-work
cd agent-work
pnpm run stage                    # 生成 build/upstream
```

需要 Node `^22.19 || >=24`、pnpm 11，以及已配置 `user.name` / `user.email` 的 git（`git am` 需要）。

## 打包桌面端

团队发布的就是这个桌面端：Host 运行在成员本机。替换登录、预装 team-bundle 的补丁完成后，会更新这一节。

```sh
cp overlay/apps/desktop/.env.macos.example overlay/apps/desktop/.env.macos   # 填写应用 ID、名称、更新源站、签名
pnpm run stage --reset            # 把 .env.macos 一并复制进副本
pnpm package package:desktop:mac:arm64:dir   # 未封装的 .app，用于本机验证
pnpm package package:desktop:mac:arm64       # 签名安装包
```

本机试用（mac）：`pnpm try:desktop` 一步完成“生成构建副本 → 构建目录版（不做安装包、不公证）→ 退出正在运行的 GL Work → 打开新构建”。登录状态、隧道等设置在用户目录里，新旧两份共用。`--skip-stage` 直接用 `build/upstream` 现有内容构建（在副本里改了文件时），`--open` 只重新打开上一次的构建。测通、PR 合并后再打正式安装包。

`.env.macos` / `.env.windows` 含签名凭据，已被 Git 忽略，只提交 `.example`。字段含义见上游 [apps/desktop/README.md](upstream/apps/desktop/README.md)；`DSH_DESKTOP_PRODUCT_NAME` 由 `patches/0001` 新增。

## 品牌

品牌的唯一来源是 [overlay/apps/desktop/branding/](overlay/apps/desktop/branding/)：

- `brand.json`：产品名、账号提供方、账号叫法（中英文）、欢迎页标语（中英文）、主窗口空白页的标题（中英文，`heroHeadline`）和是否显示"预览版"标签（`heroPreview`）；
- `logo.svg`：logo 图形（矢量）。

修改后执行 `pnpm brand`。它会生成 overlay 里的应用图标（macOS、Windows）、欢迎页字标、Web favicon 和清单，以及补丁 0006 和 0007 读取的品牌数据文件（各包里的 `brand.ts`，官方品牌插件里的 `product.ts`）。打包配置里的 `DSH_DESKTOP_PRODUCT_NAME` 要和 `brand.json` 的产品名保持一致，不一致时 `pnpm brand` 会提示。然后执行 `pnpm run stage --reset`，再完整打包（文案改动需要重新构建，不能用 `--skip-build`）。

## 部署公司服务

**现在的部署**：公司内网集群 office-test（Rancher + Fleet），清单在 infra 仓库 `fleet/apps/agent-work`（GL-Game-Group/infra#1，2026-10-06 上线）。

- 镜像：`main` 上 `admin/`、`gateway/`、`deploy/Dockerfile` 有改动时，`.github/workflows/image.yml` 调用组织流水线构建并推到 `glwork-registry.cn-hongkong.cr.aliyuncs.com/glwork/agent-work:<提交 SHA>`。发布新版本：在 infra 的 `fleet/apps/agent-work/company-service.yaml` 把镜像标签改成新的 SHA，提 PR 合并，Fleet 滚动更新。
- 访问路径：`agent.glwork.net`、`frp.glwork.net`、`*.glwork.app` 的 DNS（external-dns 建，不经 Cloudflare 代理）指向香港 frps 8.217.141.116 → 集群里的 frpc → Traefik（cert-manager 签发的证书）→ 公司服务 / 成员 frps。
- 数据：SQLite 在静态卷 `agent-work-data`（`prod-1` 的 `/var/lib/agent-work/data`）。密钥在命名空间 `agent-work` 的 Secret `agent-work-env`（`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`AGENT_WORK_SECRET_KEY`、`AGENT_WORK_FRP_PLUGIN_SECRET`），不在 Git；加密主密钥丢了，存着的厂商 Key 就读不出来，要和数据一起备份。
- 出站：经 `egress-proxy`（香港）访问 GitHub 和模型厂商，`NODE_USE_ENV_PROXY=1` 让 Node 按 `HTTPS_PROXY` 走代理。
- 管理：项目自己的 kubeconfig（只限命名空间 `agent-work`，90 天，infra 的 `scripts/tenant-kubeconfig.sh agent-work 90 <文件>` 签发）放在 `deploy/agent-work.kubeconfig`（不入库）：

```sh
K=deploy/agent-work.kubeconfig
kubectl --kubeconfig $K get pods
kubectl --kubeconfig $K exec deploy/agent-work -- node gateway/src/cli.ts member list    # 管理员命令行
kubectl --kubeconfig $K logs deploy/agent-work --tail 100
```

- `deploy/agent-deploy/`：平台的 `deploy.sh`（测试服务用，`*.glwork.dev`，无状态、单个 HTTP 应用），公司服务不用它。

**备用：Docker Compose**（一台有 Docker 的服务器，前面有基础设施 frps 时）。下面是 2026-10-05 在 47.236.206.86 上的部署方式，那台服务器已经下线，保留以便需要时再用：

公司服务（管理后台 + 公司服务，一个进程）和成员用的 frps 部署在新加坡服务器 47.236.206.86，只用 Docker Compose，文件在 `deploy/`。这台服务器的 80/443 属于基础设施的 frps（systemd，`/etc/frp/frps.toml`，内部集群的入口：80 是控制通道，443 按 SNI 透传，前面是 Cloudflare 代理），我们不改它，只作为它的一个客户端接入：

- `compose.yml`：Traefik（只监听 `127.0.0.1:8443`）、`agent-work`（`deploy/Dockerfile` 构建）、frps（成员隧道，官方镜像，和客户端同版本，只在 compose 网络内）、`frpc-ingress`（host 网络，用基础设施 frps 的令牌 `FRP_INGRESS_TOKEN` 登记 HTTPS 入口 `agent.glgwork.com`、`frp.glgwork.com`，TLS 透传到 Traefik）。
- 访问路径：Cloudflare（代理，`glgwork.com` 打开了“始终使用 HTTPS”）→ 服务器 443 → 基础设施 frps 按 SNI → frpc-ingress → Traefik → 公司服务 / frps。Traefik 看到的来源都是本机，公司服务从 `CF-Connecting-IP` 取客户端地址（`AGENT_WORK_CLIENT_IP_HEADER`，只用于审计和限流）。
- `dynamic.yml`：路由。`agent.glgwork.com` → 公司服务，其中 `/agent-work/frp/` 在公网一律 403（frps 在内部网络回调）；`frp.glgwork.com` → frps（frpc 的 wss）；成员网页隧道的泛域名 → frps。没有按来源地址放行的规则。证书是 `deploy/certs/` 里的 Cloudflare 源站证书（不入库）：`glgwork.com.pem/.key`、`glwork.app.pem/.key`。签发：Cloudflare 令牌需要 “SSL and Certificates: Edit” 权限，用 `POST /certificates`（`request_type: origin-rsa`，15 年）。
- 成员网页隧道在 `glwork.app`（`名字-成员.glwork.app`，后台“内网穿透 → 域名”里添加），`glwork.dev` 留给测试服务。隧道泛域名单独一条 proxy（`agent-work-tunnels`）：frps 遇到任何域名冲突会拒绝整条登记。`.app` 在浏览器里强制 HTTPS。
- 服务器上的 `/opt/agent-work/deploy/.env`（权限 600，模板是 `.env.example`）放密钥；数据库在 `data` 卷里，备份在 `/opt/agent-work-backups`（属主 uid 1000，即容器里的 node 用户；`backup.sh`，cron 每天 3:17，保留 14 天）。

```sh
AGENT_WORK_SERVER=root@47.236.206.86 AGENT_WORK_SSH_OPTS='-i ~/.ssh/agent_work_deploy' deploy/push.sh
# 发送构建需要的文件（白名单），在服务器上执行 update.sh：先备份数据库，构建以内容哈希为标签的镜像，
# 启动后等健康检查（/agent-work/healthz），不通过就回到上一个镜像
ssh root@47.236.206.86 'cd /opt/agent-work/deploy && docker compose exec agent-work node gateway/src/cli.ts member list'   # 管理员命令行
```

仓库推到 GitHub 后，可以改成服务器上 `git pull` 再执行 `update.sh`。

## 修改补丁

```sh
pnpm run stage --reset            # 从固定版本重新生成副本并应用全部补丁
# 在 build/upstream 中修改文件，每件事单独 git commit
pnpm save-patches             # 用固定版本之后的提交重写 patches/
```

`stage --reset` 会丢弃副本中未提交的改动（`node_modules` 等被忽略的构建产物保留）。`save-patches` 拒绝未提交的改动；由 `overlay/` 覆盖的路径不计入。

## 升级上游

```sh
git -C upstream fetch --tags origin
git -C upstream checkout <新 tag>
# 更新 upstream.json 的 tag 与 commit
pnpm run stage --reset            # 补丁不再适用时停下；在 build/upstream 中解决冲突后 git am --continue
pnpm save-patches
```

submodule 指针、`upstream.json`、补丁和插件依赖版本放在同一个 PR 中更新。

## 当前补丁

| 补丁 | 作用 |
|---|---|
| `0001-desktop-read-productName-…` | 应用名从 `DSH_DESKTOP_PRODUCT_NAME` 读取（默认 `DeepSeek Harness`）；打包、公证、打包后冒烟检查按 `<产品名>.app` 定位；macOS `dsh` 命令启动脚本从 `Info.plist` 读取可执行文件名 |
| `0002-desktop-keep-CFBundleLocalizations-…` | 修复上游 bug：`mac.extendInfo` 声明了两次，导致 `CFBundleLocalizations` 丢失；可提交给上游 |
| `0003-desktop-run-beside-other-Desktop-builds` | `DSH_DESKTOP_DEFAULT_HOME` / `DSH_DESKTOP_HOST_PORT`：打包时写入应用，运行者未设置 `DSH_HOME` / `DSH_DESKTOP_HOST_PORT` 时生效；配置了产品名时 Electron userData（含单实例锁）改为 `~/Library/Application Support/<产品名>`。三者使团队版与官方版可同时运行、数据互不共享 |
| `0004-desktop-preinstall-extra-default-bundles` | `DSH_DESKTOP_EXTRA_BUNDLE_DIRS` 列出的 bundle 目录在打包时打成 tarball 并加入运行时包集合，包名写入应用清单；新建的 profile 默认选中它们，每次启动时补回缺失的，恢复模式也保留它们。团队用它预装 `plugins/team-bundle` |
| `0006-desktop-brand-copy-from-brand.ts` | 桌面端的菜单、对话框、欢迎页文案，以及设置页账号和首次引导的文案，从同目录的 `brand.ts` 读取产品名、账号提供方、账号叫法和欢迎页标语。上游自带的 `brand.ts` 就是官方文案，overlay 用 `pnpm brand` 生成的版本替换。官方构建的窗口标题在设置了 `DSH_DESKTOP_PRODUCT_NAME` 时使用它 |
| `0007-client-brand-marks-and-hero-copy-from-brand-modules` | 官方品牌插件 `ui-brand-official` 读取 `product.ts`：配置了 logo 和产品名时，侧边栏显示它们，而不是鲸鱼和 DeepSeek 字标。会话组件 `ui-conversation` 读取 `brand.ts`，决定空白页的 logo、标题，以及是否显示"预览版"标签。默认文件保持官方样式 |
| `0005-desktop-account-only-sign-in-without-Platform-surfac…` | `DSH_DESKTOP_ACCOUNT_ONLY=1`：欢迎页只能登录进入（没有"填 API Key""稍后设置"入口），不暴露 DeepSeek 平台内嵌页的桥接。`ui-settings-account` 新增配置 `platformAccount`（默认 `true`），team-bundle 把它设为 `false`，从而隐藏余额、用量、充值、首次引导里的充值步骤和"添加 API Key"入口 |

### 补丁新增的打包配置（`.env.macos` / `.env.windows`）

| 配置项 | 示例 | 来源 |
|---|---|---|
| `DSH_DESKTOP_PRODUCT_NAME` | `"GL Work"` | 0001；也用作窗口标题（0006） |
| `DSH_DESKTOP_DEFAULT_HOME` | `~/.agent-work` | 0003 |
| `DSH_DESKTOP_HOST_PORT` | `19487` | 0003 |
| `DSH_DESKTOP_EXTRA_BUNDLE_DIRS` | `agent-work/plugins/team-bundle` | 0004；`pnpm run stage` 把 `plugins/team-bundle` 复制到副本的这个位置 |
| `DSH_DESKTOP_ACCOUNT_ONLY` | `1` | 0005 |

## 待办

- 客户端插件读取公共配置和 CLI 账号的接口（Host 服务），以及阶段 8 的 CLI 登录引导。
- 公司服务的 `AGENT_WORK_SECRET_KEY` 要和数据库一起备份；丢了它，已保存的 Key 和加密配置都无法读取，只能重新录入。

- Windows：`apps/desktop/cli/dsh.cmd` 仍写死 `DeepSeek Harness.exe`，也未读取 `DSH_DESKTOP_DEFAULT_HOME`；打 Windows 版之前需要补丁。
- 更新：`updates.glgwork.com` 目前只是占位，没有部署更新服务；更新检查失败不会提示用户。
- `dsh://` 协议与官方桌面端相同，两者同时安装时由最后启动的应用接管。
- Windows 安装程序的品牌图（`apps/desktop/installer/assets/`）和托盘图标 `tray-windows.ico` 仍是上游的，打 Windows 版之前需要补上。
- 上游测试 `apps/desktop/tests/main-startup.spec.ts`、`cli-launcher.spec.ts` 在 0001、0003 之后就失败（测试夹具里的假应用缺少应用清单和 `Info.plist`），只影响测试，需要补丁修复测试夹具。
