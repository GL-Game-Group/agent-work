/**
 * A company service for local development: a fake GitHub whose authorize page
 * lists the seeded members (pick one to sign in as them) and which also serves
 * sample plugin packages at /plugins/ (OSS's part), and a store seeded
 * with members, keys, subscriptions and two weeks of usage. Nothing reaches
 * real vendors except a DEEPSEEK_API_KEY from the environment, imported as usual.
 *
 * Used by admin/'s Vite plugin (`pnpm admin:dev`) and gateway/scripts/dev.ts.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GatewayConfig } from './config.ts'
import { Store } from './db.ts'
import { packTarball, readPackage, sampleBundle } from './plugins.ts'
import { createRuntime, type Runtime } from './runtime.ts'
import { openPglite } from './sql.ts'

const DAY = 24 * 60 * 60 * 1000

interface SeedMember {
  name: string; displayName: string; githubId: number; login: string; role: 'admin' | 'member'; team: 'dev' | 'product' | 'qa'; disabled?: boolean
}

/** GitHub ids far above real ones, so avatars fall back to initials rather than strangers' photos. */
const MEMBERS: SeedMember[] = [
  { name: 'wuming', displayName: '吴明', githubId: 9000009919, login: 'eva2show', role: 'admin', team: 'dev' },
  { name: 'lina', displayName: '李娜', githubId: 9000001024, login: 'lina-pm', role: 'admin', team: 'product' },
  { name: 'zhangwei', displayName: '张伟', githubId: 9000004096, login: 'zw-dev', role: 'member', team: 'dev' },
  { name: 'chenjie', displayName: '陈杰', githubId: 9000002048, login: 'chenjie', role: 'member', team: 'dev' },
  { name: 'sunyu', displayName: '孙雨', githubId: 9000008192, login: 'sunyu-qa', role: 'member', team: 'qa' },
  { name: 'zhaolei', displayName: '赵磊', githubId: 9000016384, login: 'zhaolei', role: 'member', team: 'product', disabled: true },
]

/** Sample plugin packages the fake server also serves (standing in for OSS) at /plugins/<file>. */
const SAMPLE_PLUGINS: Record<string, Buffer> = Object.fromEntries(([
  ['dsh-tunnel-0.1.0.tgz', '@agent-work/dsh-tunnel', '0.1.0', '内网穿透：把本机网页服务发布到公网，或让同事经 GL Work 连到你电脑的 SSH（frp）'],
  ['dsh-feishu-0.2.0.tgz', '@agent-work/dsh-feishu', '0.2.0', '把会话摘要和发版通知发到飞书群'],
  ['dsh-feishu-0.3.0.tgz', '@agent-work/dsh-feishu', '0.3.0', '把会话摘要和发版通知发到飞书群'],
  ['dsh-prd-0.1.0.tgz', '@agent-work/dsh-prd', '0.1.0', '按团队模板起草需求文档'],
] as const).map(([file, name, version, description]) => [file, packTarball(sampleBundle(name, version, { description }))]))

/** A fake GitHub: an account chooser at /login/oauth/authorize, then /user answers as the chosen account. */
function fakeGitHub(store: Store): Server {
  const escape = (text: string) => text.replace(/[&<>"']/gu, c => `&#${String(c.charCodeAt(0))};`)
  return createServer((req, res) => {
    answer(req, res).catch((error: unknown) => {
      console.error('dev: fake GitHub failed', error)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://github.invalid')
    const sample = /^\/plugins\/([^/]+)$/u.exec(url.pathname)?.[1]
    if (sample !== undefined) {
      const body = SAMPLE_PLUGINS[sample]
      if (body === undefined) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': 'application/gzip' }).end(body)
      return
    }
    if (url.pathname === '/login/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri') ?? '')
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      const choices = [...(await store.listMembers()).map(m => ({ login: m.githubLogin, note: `${m.displayName} · ${m.role === 'admin' ? '管理员' : '成员'}${m.status === 'disabled' ? ' · 已停用' : ''}` })),
        { login: 'stranger-dev', note: '没有开通的 GitHub 账号' }]
      const links = choices.map(({ login, note }) => {
        back.searchParams.set('code', login)
        return `<a href="${escape(back.href)}"><b>${escape(login)}</b><span>${escape(note)}</span></a>`
      }).join('')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>模拟 GitHub</title>
<style>body{font:14px -apple-system,"PingFang SC",sans-serif;max-width:26rem;margin:10vh auto;padding:0 16px}a{display:flex;justify-content:space-between;padding:10px 12px;border:1px solid #ddd;border-radius:8px;margin:6px 0;color:inherit;text-decoration:none}a:hover{border-color:#037cf4}span{color:#888}</style>
<h2>模拟 GitHub：选择要登录的账号</h2><p style="color:#888">本地开发用，不会连接真正的 GitHub。</p>${links}`)
      return
    }
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/login/oauth/access_token') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => { res.end(JSON.stringify({ access_token: new URLSearchParams(body).get('code') ?? JSON.parse(body || '{}').code ?? 'stranger-dev' })) })
      return
    }
    const token = (req.headers.authorization ?? '').replace(/^(?:Bearer|token) /u, '')
    const known = (await store.listMembers()).find(m => m.githubLogin === token)
    const user = known === undefined ? { id: 9_999_999_999, login: token || 'stranger-dev' } : { id: known.githubId, login: known.githubLogin }
    if (url.pathname === '/user') { res.end(JSON.stringify(user)); return }
    if (url.pathname.startsWith('/user/memberships/orgs/')) { res.end(JSON.stringify({ state: 'active' })); return }
    // Profile lookup when the console adds a member: a stable made-up id per login.
    const lookup = /^\/users\/([^/]+)$/u.exec(url.pathname)?.[1]
    if (lookup !== undefined) {
      // Far above real GitHub ids, so no stranger's avatar shows up.
    const id = [...lookup].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_000_000, 7) + 9_000_000_000
      res.end(JSON.stringify({ id, login: lookup }))
      return
    }
    res.writeHead(404).end('{}')
  }
}

async function seed(runtime: Runtime, samples: string): Promise<void> {
  const { store, vendors, plugins } = runtime
  const now = Date.now()
  for (const m of MEMBERS) {
    await store.addMember({ name: m.name, displayName: m.displayName, githubId: m.githubId, githubLogin: m.login, role: m.role, team: m.team })
    if (m.disabled === true) await store.setStatus(m.name, 'disabled')
  }
  await store.setTunnelGrants('wuming', { ssh: true })
  await store.setTunnelGrants('zhangwei', { ssh: true })
  await vendors.updateVendor('qwen', { name: '千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', compat: '{"thinkingFormat":"qwen"}' })
  await vendors.setModels('qwen', [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' }, 'qwen-plus', 'qwen-max'])
  await vendors.addVendor({ id: 'volcengine', name: '火山方舟', type: 'api', auth: 'key', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })
  await vendors.setModels('volcengine', [{ id: 'doubao-seed-1-6', name: '豆包 Seed 1.6' }])
  const shared = (await vendors.listKeys('deepseek'))[0]?.id ?? (await vendors.addKey('deepseek', '公司主账号', 'sk-dev-deepseek-shared-c893', 'shared')).id
  const dedicated = (await vendors.addKey('deepseek', '研发专用', 'sk-dev-deepseek-dedicated-7a1e', 'dedicated')).id
  const qwen = (await vendors.addKey('qwen', '百炼主账号', 'sk-dev-qwen-1111', 'shared')).id
  await vendors.setKeyStatus((await vendors.addKey('volcengine', '方舟测试', 'sk-dev-ark-e0f2', 'shared')).id, 'disabled')
  const claude = await vendors.addSubscription({ vendor: 'claude', plan: 'Claude Max 5x', seats: 2, price: '$100', renewsAt: now + 4 * DAY, owner: 'wuming', note: '公司信用卡' })
  const codex = await vendors.addSubscription({ vendor: 'codex', plan: 'ChatGPT Team', seats: 3, price: '$30 / 席', renewsAt: now + 18 * DAY, owner: 'wuming' })
  const qoder = await vendors.addSubscription({ vendor: 'qoder', plan: 'Qoder Pro', seats: 1, price: '$20', renewsAt: now + 26 * DAY, owner: 'lina' })
  await vendors.addAccount(claude.id, 'ai-claude-1@glgwork.com', null, null)
  await vendors.addAccount(claude.id, 'ai-claude-2@glgwork.com', null, null)
  await vendors.addAccount(codex.id, 'codex-dev-1@glgwork.com', null, null)
  await vendors.addAccount(codex.id, 'codex-dev-2@glgwork.com', null, null)
  await vendors.addAccount(codex.id, 'codex-qa@glgwork.com', '测试组共用设备', null)
  await vendors.addAccount(qoder.id, 'qoder-1@glgwork.com', null, null)
  await vendors.setMemberVendors('wuming', [{ vendor: 'deepseek', mode: 'dedicated', apiKey: dedicated }, 'claude', 'qwen'])
  await vendors.setMemberVendors('lina', ['deepseek', 'qoder'])
  await vendors.setMemberVendors('zhangwei', ['deepseek', 'codex', 'claude'])
  await vendors.setMemberVendors('chenjie', ['deepseek', 'codex', 'qwen'])
  await vendors.setMemberVendors('sunyu', ['deepseek', 'codex', 'qoder'])
  for (const [config, value, secret, group, note] of [
    ['oss.region', 'oss-ap-southeast-1', false, '阿里云 OSS', '新加坡'],
    ['oss.bucket', 'gl-work-assets', false, '阿里云 OSS', null],
    ['oss.accessKeyId', 'LTAI5t-dev-example', true, '阿里云 OSS', '只读 RAM 用户'],
    ['oss.accessKeySecret', 'dev-example-secret', true, '阿里云 OSS', '只读 RAM 用户'],
    ['feishu.webhook', 'https://open.feishu.cn/open-apis/bot/v2/hook/dev', true, '通知', '发版通知群机器人'],
    ['release.channel', 'beta', false, '发布', '客户端更新通道'],
  ] as const) await vendors.setPublic(config, value, secret, note, group)
  // The plugin catalog: the preinstalled tunnel plugin, one published plugin, one still hidden.
  const register = async (file: string, meta: { displayName: string; permissions: string[]; preinstalled: boolean; status: 'published' | 'hidden' }) =>
    await plugins.save(readPackage(SAMPLE_PLUGINS[file]!), `${samples}/plugins/${file}`, meta)
  await register('dsh-tunnel-0.1.0.tgz', { displayName: '内网穿透', permissions: ['运行随插件附带的 frpc', '连接公司服务器', '转发你选择的本机端口'], preinstalled: true, status: 'published' })
  await register('dsh-feishu-0.2.0.tgz', { displayName: '飞书通知', permissions: ['读取系统配置 feishu.webhook', '发送网络请求到 open.feishu.cn'], preinstalled: false, status: 'published' })
  await register('dsh-prd-0.1.0.tgz', { displayName: '需求文档助手', permissions: ['读写当前工作区的文件'], preinstalled: false, status: 'hidden' })
  // Devices and internal keys, then two weeks of usage on the gateway.
  const device = async (member: string, label: string, ip: string, installed: [string, string][]) => {
    const issued = await store.issueCredential(member, 'device', label, 90 * DAY)
    await store.authenticate(issued.token, 'device', ip)
    await plugins.report(issued.credential.id, installed.map(([name, version]) => ({ name, version })))
    return issued.credential.id
  }
  const tunnel: [string, string] = ['@agent-work/dsh-tunnel', '0.1.0']
  const wumingMac = await device('wuming', 'MacBook Pro 16"（darwin-arm64）', '58.247.10.21', [tunnel, ['@agent-work/dsh-feishu', '0.2.0']])
  await device('lina', 'MacBook Air（darwin-arm64）', '116.228.3.7', [tunnel])
  const zhangweiMac = await device('zhangwei', 'Mac Studio（darwin-arm64）', '101.80.44.2', [tunnel, ['@agent-work/dsh-feishu', '0.1.0']])
  const chenjiePc = await device('chenjie', 'ThinkPad X1（win32-x64）', '180.169.9.30', [tunnel])
  await device('sunyu', 'MacBook Pro 14"（darwin-arm64）', '222.66.1.18', [])
  // Tunnels: one domain ready, one still waiting for DNS; a few tunnels, one closed by an administrator.
  const { tunnels } = runtime
  await tunnels.addDomain({ name: 'tunnel.glgwork.net', note: '阿里云 DNS，泛解析' })
  await tunnels.markDomain('tunnel.glgwork.net', 'ok', 'ok')
  await tunnels.addDomain({ name: 'preview.glgwork.net', note: '给演示用' })
  const credentialOf = async (id: string) => (await store.listCredentials()).find(c => c.id === id)!
  const memberOf = async (name: string) => (await store.member(name))!
  const preview = await tunnels.create(await memberOf('wuming'), await credentialOf(wumingMac), { type: 'http', name: 'preview', localPort: 5173 })
  await tunnels.create(await memberOf('wuming'), await credentialOf(wumingMac), { type: 'ssh', name: 'devbox', localPort: 22, sshAccess: ['zhangwei', 'lina'] })
  await tunnels.create(await memberOf('zhangwei'), await credentialOf(zhangweiMac), { type: 'http', name: 'api', localPort: 8080, protection: 'public' })
  const demo = await tunnels.create(await memberOf('chenjie'), await credentialOf(chenjiePc), { type: 'http', name: 'demo', localPort: 3000 })
  await tunnels.setClosed(demo.id, 'lina')
  await store.sql.run('update tunnels set online = 1, last_seen_at = ? where id = ?', [now, preview.id])
  // 手机远程: wuming's Mac has it on, and wuming's iPhone is signed in.
  const remote = await tunnels.create(await memberOf('wuming'), await credentialOf(wumingMac), { type: 'remote' })
  await store.sql.run('update tunnels set online = 1, last_seen_at = ? where id = ?', [now, remote.id])
  await store.issueCredential('wuming', 'phone', 'wuming 的 iPhone', 90 * DAY)
  await store.issueCredential('wuming', 'key', 'Claude Code（DeepSeek）', 365 * DAY)
  await store.issueCredential('zhangwei', 'key', 'CI 脚本', 365 * DAY)
  const insert = (...row: unknown[]) => store.sql.run(`insert into llm_usage (at, member, credential, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, vendor, api_key)
    values (?, ?, 'seed', ?, 200, ?, ?, ?, 0, ?, ?)`, row)
  for (let d = 13; d >= 0; d -= 1) {
    const weekend = [0, 6].includes(new Date(now - d * DAY).getDay())
    for (const [who, i] of [['wuming', 1], ['zhangwei', 2], ['chenjie', 3], ['sunyu', 4], ['lina', 5]] as const) {
      const scale = (weekend ? 0.3 : 1) * (1 + ((d * 7 + i * 3) % 5) / 4)
      const key = who === 'wuming' ? dedicated : shared
      await insert(now - d * DAY - i * 3_600_000, who, 'deepseek-flash', Math.round(180_000 * scale), Math.round(14_000 * scale), Math.round(260_000 * scale), 'deepseek', key)
      if (who === 'chenjie' || who === 'wuming') await insert(now - d * DAY - i * 3_700_000, who, 'qwen3-coder-plus', Math.round(60_000 * scale), Math.round(6_000 * scale), 0, 'qwen', qwen)
    }
  }
}

export interface DevRuntimeOptions {
  /** The origin browsers use, e.g. http://127.0.0.1:5173 (Vite) or http://127.0.0.1:8787. */
  publicOrigin: string
  /** A PGlite data directory to keep data across restarts; in memory by default. */
  dataDir?: string
}

/** @returns the runtime and a function stopping the fake GitHub. */
export async function startDevRuntime(options: DevRuntimeOptions): Promise<{ runtime: Runtime; close: () => void }> {
  const store = await Store.open(await openPglite(options.dataDir))
  const github = fakeGitHub(store)
  await new Promise<void>((resolve) => { github.listen(0, '127.0.0.1', resolve) })
  const githubOrigin = `http://127.0.0.1:${String((github.address() as AddressInfo).port)}`
  const config: GatewayConfig = {
    productName: process.env.AGENT_WORK_PRODUCT_NAME || 'GL Work',
    publicOrigin: options.publicOrigin, listenHost: '127.0.0.1', listenPort: Number(new URL(options.publicOrigin).port || 80),
    trustProxy: false, dataDir: options.dataDir ?? null,
    github: { clientId: 'dev', clientSecret: 'dev', org: 'GL-Game-Group', webUrl: githubOrigin, apiUrl: githubOrigin },
    // A data directory keeps its keys readable across restarts only with the same master key.
    secretKey: process.env.AGENT_WORK_SECRET_KEY || randomBytes(32).toString('base64'),
    // A local frps may call back on this secret path (frps.toml: path = "/agent-work/frp/<secret>").
    // AGENT_WORK_DEV_FRPS_PORT: macOS's AirPlay Receiver holds 7000.
    frps: { addr: '127.0.0.1', port: Number(process.env.AGENT_WORK_DEV_FRPS_PORT || 7000), protocol: 'tcp', pluginSecret: process.env.AGENT_WORK_FRP_PLUGIN_SECRET || randomBytes(24).toString('base64url'), publicIp: null,
      // 手机远程 relays through the local frps's vhostHTTPPort.
      vhost: { host: '127.0.0.1', port: Number(process.env.AGENT_WORK_FRPS_VHOST_PORT || 8080) } },
    ...process.env.DEEPSEEK_API_KEY ? { deepseek: { baseUrl: process.env.DEEPSEEK_UPSTREAM ?? 'https://api.deepseek.com/anthropic', apiKey: process.env.DEEPSEEK_API_KEY } } : {},
  }
  const fresh = (await store.listMembers()).length === 0
  const runtime = await createRuntime(config, { store })
  if (fresh) await seed(runtime, githubOrigin)
  return { runtime, close: () => { github.close(); void store.close() } }
}
