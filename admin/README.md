# @agent-work/admin

GL Work 的管理后台和成员工作台（SvelteKit + shadcn-svelte），也是公司服务在生产环境的入口：`server.js` 把 `/agent-work/*`（登录、模型网关、桌面端配置）交给 `gateway/` 的处理函数，其余交给 SvelteKit。

```bash
pnpm admin:dev           # 仓库根目录运行：http://127.0.0.1:5173，模拟 GitHub 加演示数据
pnpm admin:dev:github    # 真实配置（gateway/.env），真实 GitHub 登录
pnpm admin:check         # 类型检查 + 构建（输出 admin/build/）
node server.js           # 生产启动，配置见 gateway/.env.example
```

- 页面在服务端渲染：`+page.server.ts` 的 `load` 读数据，表单提交（form actions）改数据，都通过 `#lib/server/context.ts` 拿到同进程的公司服务（`getRuntime()`），只调用 `gateway/src/services.ts`。
- `hooks.server.ts` 识别登录的成员（浏览器会话 Cookie），拒绝其他站点（包括 glgwork.com 的其他子域名）发起的写请求和数据读取。
- 页面安全策略（CSP）由 SvelteKit 生成（脚本带 nonce）。

| 路径 | 页面 |
|---|---|
| `/` | 概览 |
| `/ai/vendors`、`/ai/keys`、`/ai/subscriptions` | 厂商与模型、API Key、订阅与账号 |
| `/members`、`/members/<成员名>` | 成员、成员详情（AI 资源分配、内部 Key、设备、隧道权限） |
| `/devices`、`/settings`、`/usage`、`/audit` | 设备、系统配置、用量、审计 |
| `/plugins` | 插件目录：登记（粘贴 OSS 地址，服务端核对）、更新版本、上架下架、各台 GL Work 的安装情况 |
| `/me` | 成员工作台；管理员可以用 `?as=<成员名>` 预览 |
| `/login` | GitHub 登录，失败时显示原因 |
| `/tunnels`、`/desktop` | 原型（模拟数据，`src/lib/mock/`） |

组件用 `npx shadcn-svelte@latest add <组件>` 添加，放在 `src/lib/components/ui/`，不要手改；业务组件在 `src/lib/components/app/`。
