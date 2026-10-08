# CLAUDE.md

公司内部 AI 工作台。团队 3–8 人（产品、开发、测试）。每个成员使用品牌化的官方 DeepSeek Harness 桌面端，Host 运行在本机。只替换登录部分：成员用 GitHub 账号登录公司服务（`https://agent.glwork.net`，部署在公司内网集群 office-test，经香港 frps 对外），登录后由公司服务下发模型配置、网关 Key 和团队插件。macOS 安装包在负责人的电脑上签名和公证（`overlay/apps/desktop` 的打包流程）；服务器端的构建和发布集成在新加坡云服务器。使用方法和命令见 [README.md](README.md)；需求背景见 [项目设计.md](项目设计.md)。

## 架构

| 阶段 | 内容 | 位置 | 状态 |
|---|---|---|---|
| 1 | 公司服务的身份部分：GitHub 登录、设备令牌、成员、审计、管理员命令行 | `gateway/` | 已完成 |
| 2 | 公司账号插件：替换 `deepseek-account`，在 Host 里完成登录 | `plugins/`、`gateway/` | 已完成 |
| 3 | 桌面端补丁：0004 预装 team-bundle；0005 登录界面只保留公司登录；0006、0007 品牌；0008 预装插件的 `bin/` 放到 asar 外；0009 用户菜单的“公司文档”；0010 登录窗口的服务器设置；0011 工作区菜单的插件扩展点；打包 | `patches/`、`overlay/` | 已完成 |
| 4 | 配置下发和模型网关（第一版内置透传网关，用设备令牌作为每人的 Key；以后需要多厂商协议转换时再引入 LiteLLM） | `gateway/`、`plugins/` | 已完成（第一版） |
| 5 | 管理后台第一版（成员、设备、用量、审计）；本地调试完成后部署 | `gateway/` | 已完成 |
| 5.1 | 部署：公司内网集群 office-test（Rancher，infra 仓库的 Fleet：`fleet/apps/agent-work`），经香港 frps 对外；镜像由 `.github/workflows/image.yml` 推到阿里云 ACR；在负责人电脑上打出签名的 mac 安装包；里程碑 M1：内测 | `deploy/`、infra | 已上线（2026-10-06，infra#1）：`https://agent.glwork.net`、`frp.glwork.net`、`*.glwork.app`，证书由 cert-manager 签发，管理员 wuming；数据 2026-10-08 起在内网 PostgreSQL（db-1 internal 实例的 `agent_work`，db-provisioner 建库，Secret `agent-work-db`，infra#3/#4），原 SQLite 文件留在持久卷上作备份；Docker Compose（`deploy/compose.yml`）保留为备用；mac 安装包待打 |
| 5.2 | 厂商管理（API Key 和账号两种登录方式）、加密 Key、模型开放、按成员分配、多厂商模型网关、公共配置 | `gateway/`、`plugins/` | 已完成；客户端读取公共配置和 CLI 账号的接口留到阶段 8 |
| 5.3 | 管理后台重做（SvelteKit + shadcn-svelte，和公司服务同进程）：订阅、独立 Key、内部 Key、系统配置读取接口、成员工作台 | `admin/`、`gateway/` | 已完成 |
| 6 | 自动更新：OSS 和强制更新策略（0006）；发布流程集成到 infra（Fleet）；里程碑 M2：全员推广 | `patches/`、`scripts/` | |
| 7 | 插件分发：插件包（tarball）放 OSS，后台登记版本和下载地址，成员在 GL Work 里按需安装；插件多了或互相依赖时再引入私有 npm 源；内网穿透插件预装 | `gateway/`、`plugins/` | 后台插件目录、桌面端“公司插件”列表和安装（核对 sha512）已完成；预装内网穿透随 7.1 一起做 |
| 7.1 | 内网穿透（frp）：frps 回调公司服务校验登录、隧道和心跳；后台管理隧道、域名、设置；`plugins/tunnel` 运行 frpc；随 GL Work 预装 | `gateway/`、`admin/`、`plugins/` | 服务端、后台、桌面端插件、随 GL Work 附带 frpc 并预装已完成（签名的 mac 目录版里实际开过隧道）；frps 部署随 5.1 |
| 7.2 | 工作区管理：本地文件夹或公司 GitHub 仓库新建工作区，复制为工作区（git 工作树），GitHub CLI 一键安装和登录 | `plugins/workspace`、`patches/` | 插件和补丁 0011 已完成（真实 Host 端到端测试） |
| 8 | AI 命令行工具：检测、安装、登录 Claude Code、Codex、Qoder CLI（需要服务地区合规）；直连模式（命令行作为模型，全部权限） | `plugins/agents` | 已完成（真实 Claude Code、Codex 对话和提问卡片已验证；Qoder 没有账号未实测） |
| 9 | 管理后台第二版：用量限额、订阅席位 | `gateway/` | |
| 10 | 由 AI 管理 Dokploy 部署 | — | 单独出方案 |
| 11 | 手机端（iOS 原生，参考 DSHRemote，MIT）：R1 Mac 端手机远程 + 公司服务中转和手机登录；R2 iOS App（GL Work 品牌、GitHub 登录、TestFlight）；R3 推送 | `plugins/tunnel`、`gateway/`、`mobile/ios` | R1 已完成（真实 Host + frps/frpc 端到端验证）；R2 App 已完成（模拟器经本机中转连上真实 Host 验证），GitHub 登录弹窗待真机验收，TestFlight 待上线后上传；R3 未开始；语音（千问、火山直连，临时令牌）：公司服务和后台已完成，手机端播报、识别进行中 |

上游 DeepSeek Harness 在 `upstream/`（submodule，只读）。修改补丁或编写 Host 插件之前，先读 [upstream/CLAUDE.md](upstream/CLAUDE.md) 和相关包的 README。

### 重构：基于 Orca（2026-10-08 起）

GL Work 改为在 [Orca](https://github.com/stablyai/orca)（MIT）上二次开发，需求见 [重构.md](重构.md)。上面基于 DeepSeek Harness 的部分（`upstream/`、`patches/`、`overlay/`、`plugins/`、`mobile/ios`）作为历史版本保留不动；公司服务和后台（`gateway/`、`admin/`）两套客户端共用。

- `orca/`：子仓库，`GL-Game-Group/gl-orca` 的 `my/main`。对 Orca 的改动都在 gl-orca 里提交，按它的 [docs/fork/README.md](orca/docs/fork/README.md)：功能分支 `my/<功能>` 合入 `my/main`（merge，不 rebase），提交前缀 `eva:`，新代码放新文件、官方文件只加接入点，每项改动在 `docs/fork/changes/` 留记录，检查用 Orca 自己的（`pnpm tc`、`pnpm run check:code-quality:changed`、相关测试；它启动的应用要带 `ORCA_BACKGROUND_LAUNCH=1`）。agent-work 只提交子仓库指针。
- 阶段：R0 品牌与打包（已完成：`com.glgwork.work`、数据目录 `glwork`、关闭 Orca 更新和云账号，`orca/docs/fork/changes/glwork-brand.md`）；R1 公司账号登录和“模型来源”（已完成：「设置 → 公司账号」用 GitHub 登录公司服务、设备令牌加密保存、列出公司模型；Claude Code、Qwen Code 可选公司模型，启动时注入公司网关地址和设备令牌，`orca/docs/fork/changes/glwork-account.md`；公司服务新增 `GET /agent-work/models`）；R2 Claude Code、Codex、Qoder 的检测、安装、登录、停用；R3 手机端（iOS，Orca 的 React Native 端）GitHub 登录、选在线电脑连接（第一步连通性已完成：电脑端“手机远程”开关和 frpc、公司服务的 Orca 中转路径、手机端公司登录和电脑列表，`orca/docs/fork/changes/glwork-remote.md`；本机全链路已验证：脚本按手机协议走一遍，iOS 模拟器里的 App 也实际走通登录、列表、配对、连接；真机待公司服务部署后验收）；R4 语音；R5 打包签名和发布。桌面第一版只做 macOS。
- 构建：`cd orca && pnpm install && (cd mobile && pnpm install)`，然后 `node config/scripts/glwork-build-mac.mjs --dir`（本机试用的 `dist/mac-arm64/GL Work.app`）；开发版 `GLWORK_BUILD=1 ORCA_BACKGROUND_LAUNCH=1 pnpm dev`。图标仍由本仓库的 `pnpm brand` 生成（写到 `orca/resources/glwork/`）。

## 工作流程

**先出方案，经人确认后再动手。** 这条规则来自项目设计，适用于以下情况：

- 新功能、新目录，或新增依赖、新增服务
- 改动认证方式、公司服务的部署或网络暴露面
- 新增或修改 `patches/`
- 升级上游版本
- 任何会影响成员正在使用的服务的操作（重启服务、改 DNS 或证书、更换网关 Key）

方案写在对话里即可，不用另建文档，包含五项：

1. 目标：要解决什么问题，给谁用
2. 做法：改动哪些文件，为什么选这个做法；如果有备选做法，说明为什么不选
3. 风险：会不会影响成员现有的配置和数据，能否回滚
4. 验证：怎么证明它能用，测试同事照着做就能复现
5. 不做什么：明确这次的范围

方案里的待定项一律写成"建议：……"并说明理由，不写成"……可以吗？"。负责人看过方案后没有反对的，就按建议执行。只有缺少只有负责人才知道的信息时（比如组织名、所在地区、账号），才单独列为"需要你提供的信息"。

实现过程中如果发现方案需要较大调整，先停下来说明，再继续。

文档修正、错别字、不改变行为的小重构，可以直接做。

## 硬性规则

- `upstream/` 只读。必须改上游源码时，在 `build/upstream` 里提交，再用 `pnpm save-patches` 生成补丁。一个补丁只做一件事。
- 功能代码优先写进 `plugins/`，其次才考虑补丁。补丁只做插件无法完成的部分。
- 管理后台（`admin/`）的页面和表单只调用 `gateway/src/services.ts`；校验、权限规则、审计都写在服务层并带测试，不写在页面里。
- 公司服务是身份认证的边界：
  - 用 cookie 认证的请求必须通过跨站检查，`same-site`（glgwork.com 下的其他子域名）也算外部来源。
  - 修改认证逻辑，必须在 `gateway/test/` 里补上对应的攻击用例。
- 成员的电脑由成员自己掌控，客户端上的任何限制都可以被绕过。所以真正有约束力的控制必须放在服务端：网关 Key 每人一个、可以吊销、有限额。不要把厂商的真实 Key 下发到客户端。
- 公司下发的配置不能覆盖成员自己的修改：只写公司管理的那几项，并保存"上次下发的值"，用三方比较来判断成员有没有改过。
- 不代持、不分发、不读取成员的订阅凭据（Claude、Codex 等）。订阅只能由成员本人在浏览器里通过官方流程登录。
- 安装软件、修改其他工具的配置之前，必须先向成员说明并等待确认，不在后台静默执行。
- 密钥、证书、`.env` 不入库，只提交 `.example`。
- 品牌只改 `overlay/apps/desktop/branding/`，再用 `pnpm brand` 生成其余文件，不要手改生成出来的图标、字标和 `brand.ts`。

## 验证

改哪部分，就跑哪部分的检查，并在提交说明和给负责人的回复里写出实际运行的命令和结果：

| 改动 | 至少要做 |
|---|---|
| `gateway/` | `pnpm gateway:test`（类型检查加测试） |
| `admin/` | `pnpm admin:check`（类型检查加构建）；改了页面的，用 `pnpm admin:dev` 实际走一遍 |
| `patches/`、`overlay/` | `pnpm run stage --reset` 能干净应用（CI 也会检查）；改动桌面端行为的，打出目录版应用实际走一遍 |
| `plugins/team-bundle` 账号插件 | `pnpm --filter @agent-work/dsh-team-bundle typecheck`，以及 `test:e2e`（需要 `AGENT_WORK_DSH` 指向一个装有 dsh 的目录） |
| `deploy/` | 本地用 compose 整套跑一遍（本地 CA 代替 Let's Encrypt）：健康检查、后台、`/agent-work/frp/` 公网 403、frpc 经 wss 开网页隧道；上服务器后按 README 的上线检查走一遍 |
| `mobile/ios` | `xcodebuild` 模拟器构建通过；改动连接或登录的，在模拟器里连本机公司服务和真实 Host 走一遍（README“手机端”的调试变量） |
| `plugins/` | 用临时 `DSH_HOME` 执行 `dsh plugin --profile web add file:<路径>` 后启动 `dsh web`，确认没有报错，并且首页里实际加载的客户端模块符合预期 |

没跑过的检查，要明确说明"没跑"及原因，不要写成已验证。

## 提交

- 不走分支和 PR：需求在对话里经负责人确认后直接编码，验证通过后提交到 `main` 并推送。一个提交只做一件事。
- 提交信息用中文或英文都行，第一行说清楚做了什么。
- 升级上游时，submodule 指针、`upstream.json`、补丁、插件依赖放在同一个提交里。
- 改动公司服务部署（infra 仓库、集群里的资源）前，先在对话里说明并经负责人确认。

## 已知的坑

- 在 VS Code 或 Claude Code 的终端里运行 Electron 时，`ELECTRON_RUN_AS_NODE=1` 会被继承，导致 `import { BrowserWindow } from 'electron'` 报错。需要用 `env -u ELECTRON_RUN_AS_NODE` 启动。
- Node 只擦除 TypeScript 的类型，不做编译，所以不能用构造函数参数属性（`constructor(private x)`）、`enum` 这类需要编译的语法，`tsconfig` 里的 `erasableSyntaxOnly` 会报错。
- 修改插件后，必须重新执行 `dsh plugin --profile <profile> add file:<路径>`，Host 才会用到新内容。
- 在补丁里用 `id` 覆盖已有行的 `name`，不会生效，只会打一条警告。要替换一个插件，必须用 `disabled: true` 关掉原来那一行，再用 `insert` 以新的 id 插入。所以修改之后一定要检查实际加载的模块，不能只看 Host 有没有报错。
- 加载器计算可导入范围时会排除 bundle 包本身。所以 bundle 自己带的插件，在补丁里要用文件路径来引用（`name: ./account.js`），不要写成包的子路径（`@agent-work/dsh-team-bundle/account`）。用 `dsh plugin add` 装进 profile 测试时，两种写法都能工作，但预装进桌面端后，只有文件路径的写法能用。
- 一个带客户端模块（`dsh.client` 加 `./client` 导出）的包只能对应一个插件条目，否则 Host 启动时报 "resolves from multiple active Loader sources"。团队插件的界面因此放在子包里（`plugins/team-bundle/company/`，有自己的 `package.json`，只对应 `company-plugins` 一个条目），加载器以离文件最近的 `package.json` 作为它所属的包。
- 界面访问 Host 用 `ctx.connection.fetch.register` 注册的 `/api/...` 接口：它只接受已登录的 GL Work 窗口，桌面端的 `dsh-app://app/api/...` 请求会被转发过去；客户端代码用相对地址（`new URL('api/...', document.baseURI)`）。
- pnpm 11 自带 `pnpm stage` 命令（发布暂存），会盖过根目录 `package.json` 里同名的脚本，什么也不做就退出。生成构建副本要用 `pnpm run stage`。
- macOS 的文件系统不区分大小写。同一目录下不能出现只差大小写的文件，比如 `brand.ts` 和 `Brand.tsx`，否则 `tsc -b` 生成声明文件时会报 TS5056。新增文件时要先看清同目录里已有的文件名。
- 上游的 Settings → Models 第一次保存时，会把 `llm-pi-ai` 当前生效的整个 `providers` 拷进成员自己的 profile 补丁。所以公司的提供商配置不能写在 team-bundle 的静态补丁里（会被冻结），要通过 `ctx.settings.mutate` 按路径写入。
- 插件安装时，`KEY`、`TOKEN`、`SECRET` 这类环境变量会被清掉，所以 `.npmrc` 里不能用 `${TOKEN}` 引用环境变量，令牌要直接写进 profile 目录下的 `.npmrc`。
- 插件放在 `node_modules` 里运行，而 Node 不会对 `node_modules` 里的 `.ts` 做类型擦除，所以团队插件用 JavaScript 加 JSDoc 写，再用 `tsc --checkJs` 对照上游发布的类型做检查。
- 上游的 `main-startup.spec.ts`、`cli-launcher.spec.ts` 在补丁 0001、0003 之后就失败（测试夹具问题，见 README 待办），跑桌面端测试时先排除这两个文件，不要误以为是新改动引起的。
- frpc 开着 tcpMux（默认）时不发心跳，frps 也就不会回调公司服务的 Ping，管理员关闭隧道不会生效、后台显示离线。插件生成的配置必须写 `transport.heartbeatInterval`。
- `pnpm pack` 只给 `package.json` 里 `bin` 列出的文件保留可执行位，其他文件一律变成 644。所以打包时 `scripts/package.mjs` 会在构建副本里给 frpc 写上 `bin`，源码里的 `package.json` 不写。
- 桌面端里插件的 JS 是从 `app.asar` 读出来的，`bin/` 放在旁边的 `app.asar.unpacked`（补丁 0008）。插件按 `import.meta.dirname` 拼出的路径要把 `app.asar` 换成 `app.asar.unpacked`，否则 `existsSync` 为真但启动不了。
- 测试里会执行 `git config --global`（或替身命令会写全局配置）的，必须给 Host 设 `GIT_CONFIG_GLOBAL` 指向测试目录：Host 的子进程不一定用测试传入的 `HOME`，否则会改到开发者自己的 `~/.gitconfig`。
- `git remote get-url` 会套用 `insteadOf` 改写，要判断仓库身份时读 `git config --get remote.origin.url`。
- Host 的路由（`connection.fetch.register`）按路径区分，不按方法：同一路径的 GET 和 POST 会冲突，要用不同的路径。
- 新增的本地文件必须写进插件 `package.json` 的 `files`，否则 `dsh plugin add` 装进去的包里没有它，Host 报 "failed to import"。
- 插件替换单占位（如 `sidebar.workspaces.directoryFlow`）时要用 `priority: -1`，同优先级会抛错导致整个插件激活失败，桌面端随之退出。
- 测试给 `dsh web` 传 `HOME` 没用：插件里的 `os.homedir()` 仍是开发者真实的用户目录。插件要扫描用户目录的，给一个配置项（如工作区插件的 `searchRoots`），测试里用它指向临时目录。
- 启动子进程（安装脚本、命令行）时显式传 `HOME`：Host 的子进程不一定继承 Host 看到的 HOME。
- dsh 0.2 改了几个手机远程用到的宿主接口：`typertGateway.wireStream.open` 要传 `(endpoint, payload, uplink, peer, signal)` 五个参数，少传时信号落到 uplink 上，`$events` 一打开就失败；`session/control` 不再有队列帧，排队消息在 `inbox` 投影里；`subagents/list` 不再是远程方法，子代理列表在父会话的 `subagentCatalog` 投影里。
- “长输入”（`plugins/team-bundle/long-input/client.js`）靠上游会话框的 DOM 标记放大会话框、改 Enter：`data-conversation-content`/`data-conversation-session`/`data-content-phase`、`data-composer-seat` 上声明的 `--dsh-composer-text-max-height`、`data-composer-input`、`data-chain-overlay-fallback`、`data-trigger-menu` 及其 listbox 的 `aria-activedescendant`。它们不是上游承诺的接口，升级上游后要实际点一下“长输入”和“展开”：改名了不会报错，只会不再放大或 Enter 又变成发送。
- Host 读取的是启动时的环境变量快照，运行中修改 `process.env` 不会生效。要给 Host 提供 Key，就写进凭据存储（`ctx.credentials.set`）。
