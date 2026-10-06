/** The web console's operations: members, vendors and keys, subscriptions, system config, self-service, internal keys. */
import assert from 'node:assert/strict'
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import { Store } from '../src/db.ts'
import { Refusal } from '../src/errors.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import type { Actor } from '../src/services.ts'

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => { server.listen(port, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string; json: () => any }

function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: () => JSON.parse(text) }) })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Run an operation expecting a refusal with this status. */
async function refused(status: number, operation: () => unknown): Promise<string> {
  try {
    await operation()
  } catch (error) {
    assert.ok(error instanceof Refusal, `expected a refusal, got ${String(error)}`)
    assert.equal(error.status, status, error.message)
    return error.message
  }
  assert.fail(`expected a ${String(status)} refusal`)
}

describe('web console operations', () => {
  const listed: string[] = []
  // Plays GitHub (profile lookups) and a vendor's model list.
  const fake = createServer((req, res) => {
    if (req.url === '/compatible-mode/v1/models') {
      listed.push(req.headers.authorization ?? '')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen-plus' }, { id: 'qwen-max' }, { id: 'qwen-plus' }, { id: 'bad id' }] }))
      return
    }
    const login = /^\/users\/([^/]+)$/u.exec(req.url ?? '')?.[1]
    const users: Record<string, number> = { carol: 303, dave: 404, erin: 505 }
    if (login !== undefined && users[login] !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: users[login], login })); return }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
  })
  const store = new Store(':memory:')
  let rt: Runtime
  let service: Server
  let port = 0
  let fakeOrigin = ''
  let alice: Actor
  let bobActor: Actor

  before(async () => {
    fakeOrigin = `http://127.0.0.1:${String(await listen(fake))}`
    const github = { clientId: 'x', clientSecret: 'x', org: '', webUrl: fakeOrigin, apiUrl: fakeOrigin }
    store.addMember({ name: 'alice', githubId: 101, githubLogin: 'alice', role: 'admin', displayName: '爱丽丝', team: 'dev' })
    store.addMember({ name: 'bob', githubId: 202, githubLogin: 'bob-gh', role: 'member', team: 'product' })
    const config: GatewayConfig = {
      publicOrigin: 'http://127.0.0.1:1', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false, databasePath: ':memory:', github,
      secretKey: Buffer.alloc(32, 9).toString('hex'),
    }
    rt = createRuntime(config, { store })
    service = createServer((req, res) => { void rt.gateway(req, res) })
    port = await listen(service)
    alice = { member: store.member('alice')!, ip: '10.0.0.1' }
    bobActor = { member: store.member('bob')!, ip: '10.0.0.2' }
  })

  after(() => { service.close(); fake.close(); store.close() })

  it('adds members by GitHub username and refuses bad input', async () => {
    const carol = await rt.admin.addMember(alice, { name: 'carol', github: '@carol', displayName: '卡罗', team: 'qa', vendors: ['deepseek'] })
    assert.deepEqual([carol.githubId, carol.displayName, carol.team, carol.tunnels, carol.ssh], [303, '卡罗', 'qa', true, false])
    assert.equal(store.member('bob')?.tunnels, false, 'product members start without tunnels')
    await refused(409, () => rt.admin.addMember(alice, { name: 'carol2', github: 'carol' }))
    await refused(400, () => rt.admin.addMember(alice, { name: 'dave', github: 'dave@example.com' }))
    await refused(400, () => rt.admin.addMember(alice, { name: 'Dave', github: 'dave' }))
    await refused(400, () => rt.admin.addMember(alice, { name: 'dave', github: 'dave', team: 'ceo' }))
    await refused(404, () => rt.admin.addMember(alice, { name: 'dave', github: 'nobody-here' }))
    await refused(404, () => rt.admin.addMember(alice, { name: 'dave', github: 'dave', vendors: ['nope'] }))
    assert.equal(store.member('dave'), undefined, 'nothing created on a refusal')
    assert.deepEqual(rt.admin.members().map(m => m.name), ['alice', 'bob', 'carol'])
    assert.equal(store.recentAudit().find(e => e.action === 'member-add')?.ip, '10.0.0.1', 'audited with the actor and address')
  })

  it('never removes the last administrator or locks the caller out', async () => {
    await refused(409, () => rt.admin.setStatus(alice, 'alice', 'disabled'))
    await refused(409, () => rt.admin.setRole(alice, 'alice', 'member'))
    await refused(409, () => rt.admin.deleteMember(alice, 'alice'))
    rt.admin.setRole(alice, 'bob', 'admin')
    rt.admin.setStatus(alice, 'bob', 'disabled')
    rt.admin.setStatus(alice, 'bob', 'active')
    rt.admin.setRole(alice, 'bob', 'member')
    await refused(400, () => rt.admin.setStatus(alice, 'bob', 'gone'))
    assert.equal(store.member('alice')?.role, 'admin')
  })

  it('edits profiles and tunnel grants', () => {
    assert.equal(rt.admin.setProfile(alice, 'bob', { displayName: '鲍勃', team: 'qa' }).displayName, '鲍勃')
    const granted = rt.admin.setTunnelGrants(alice, 'bob', { tunnels: true, ssh: true })
    assert.deepEqual([granted.tunnels, granted.ssh, granted.team], [true, true, 'qa'])
  })

  it('manages vendors and refreshes a model list with a sealed key', async () => {
    assert.deepEqual(rt.admin.vendorList().map(v => `${v.id} ${v.type}/${v.auth}`), ['codex cli/account', 'claude cli/account', 'qoder cli/account', 'qwen api/key', 'deepseek api/key', 'qwen-voice voice/key', 'volc-voice voice/key'])
    assert.equal(rt.admin.addVendor(alice, { id: 'moonshot', name: 'Kimi', type: 'api', auth: 'key', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1/' }).baseUrl, 'https://api.moonshot.cn/v1')
    await refused(409, () => rt.admin.addVendor(alice, { id: 'moonshot', name: 'x', type: 'api', auth: 'key', protocol: 'openai', baseUrl: 'https://a.example' }))
    await refused(400, () => rt.admin.addVendor(alice, { id: 'plain', name: 'x', type: 'api', auth: 'key', protocol: 'openai', baseUrl: 'http://a.example' }))
    await refused(400, () => rt.admin.updateVendor(alice, 'moonshot', { name: 'Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', compat: '[1]' }))
    rt.admin.deleteVendor(alice, 'moonshot')

    await refused(409, () => rt.admin.refreshCatalog(alice, 'qwen'))
    rt.admin.updateVendor(alice, 'qwen', { name: '千问', protocol: 'openai', baseUrl: `${fakeOrigin}/compatible-mode/v1` })
    const key = rt.admin.addKey(alice, { vendor: 'qwen', label: '主账号', key: 'sk-qwen-0123456789abcd' })
    assert.deepEqual([key.last4, key.mode], ['abcd', 'shared'])
    assert.equal(JSON.stringify(rt.admin.keys()).includes('sk-qwen'), false)
    const row = store.db.prepare('select secret from api_keys where id = ?').get(key.id) as { secret: string }
    assert.match(row.secret, /^v1:/u)
    await refused(400, () => rt.admin.addKey(alice, { vendor: 'codex', label: 'x', key: 'sk-whatever-123' }))
    const vendor = await rt.admin.refreshCatalog(alice, 'qwen')
    assert.deepEqual(vendor.catalog, ['qwen-max', 'qwen-plus'])
    assert.equal(listed.at(-1), 'Bearer sk-qwen-0123456789abcd')
    assert.deepEqual(rt.admin.setModels(alice, 'qwen', [{ id: 'qwen-plus', name: 'Qwen Plus' }, 'qwen-max']).models, [{ id: 'qwen-plus', name: 'Qwen Plus' }, { id: 'qwen-max' }])
    await refused(409, () => { rt.admin.deleteVendor(alice, 'qwen') })
    assert.equal(JSON.stringify(rt.admin.auditLog()).includes('sk-qwen'), false, 'keys stay out of the audit log')
  })

  it('balances shared keys, keeps dedicated keys to one member, and assigns by mode', () => {
    const first = rt.admin.keys().find(k => k.vendor === 'qwen')!.id
    const second = rt.admin.addKey(alice, { vendor: 'qwen', label: '备用', key: 'sk-qwen-second-key-wxyz' }).id
    rt.admin.assign(alice, 'alice', 'qwen', {})
    rt.admin.assign(alice, 'bob', 'qwen', {})
    rt.admin.assign(alice, 'carol', 'qwen', {})
    const keyOf = (m: string) => rt.vendors.assignment(m, 'qwen')?.apiKey
    assert.deepEqual([keyOf('alice'), keyOf('bob'), keyOf('carol')], [first, second, first], 'least-shared first')
    rt.admin.setKeyStatus(alice, second, 'disabled')
    assert.equal(keyOf('bob'), first, 'moved off a disabled key')
    rt.admin.deleteKey(alice, second)

    const dedicated = rt.admin.addKey(alice, { vendor: 'qwen', label: '研发专用', key: 'sk-dedicated-9999', mode: 'dedicated', member: 'alice' })
    assert.deepEqual(rt.vendors.assignment('alice', 'qwen'), { member: 'alice', vendor: 'qwen', mode: 'dedicated', apiKey: dedicated.id, cliAccount: null })
    assert.throws(() => rt.admin.assign(alice, 'bob', 'qwen', { mode: 'dedicated', apiKey: dedicated.id }), (e: Refusal) => e.status === 409)
    assert.throws(() => rt.admin.assign(alice, 'bob', 'qwen', { mode: 'shared', apiKey: dedicated.id }), (e: Refusal) => e.status === 400)
    assert.throws(() => rt.admin.assign(alice, 'bob', 'codex', { mode: 'shared' }), (e: Refusal) => e.status === 400)
    rt.admin.assign(alice, 'bob', 'qwen', { mode: 'dedicated' })
    assert.equal(keyOf('bob'), null, 'waits for a free dedicated key')
    const spare = rt.admin.addKey(alice, { vendor: 'qwen', label: '备用', key: 'sk-dedicated-8888', mode: 'dedicated' })
    assert.equal(keyOf('bob'), spare.id, 'handed out as it arrives')
    assert.throws(() => rt.admin.addKey(alice, { vendor: 'qwen', label: 'x', key: 'sk-shared-7777', member: 'bob' }), (e: Refusal) => e.status === 400)
    rt.admin.unassign(alice, 'bob', 'qwen')
    assert.equal(rt.vendors.assignment('bob', 'qwen'), undefined)
    assert.deepEqual(rt.admin.members().find(m => m.name === 'carol')?.vendors.map(v => `${v.vendor}:${v.mode}`), ['deepseek:shared', 'qwen:shared'])
  })

  it('manages subscriptions and accounts, one member per account', async () => {
    const sub = rt.admin.addSubscription(alice, { vendor: 'claude', plan: 'Claude Max 5x', seats: 2, price: '$100', renewsAt: Date.now() + 4 * 86_400_000, owner: 'alice' })
    await refused(400, () => rt.admin.addSubscription(alice, { vendor: 'deepseek', plan: 'x', seats: 1 }))
    await refused(400, () => rt.admin.addSubscription(alice, { vendor: 'claude', plan: 'x', seats: 0 }))
    assert.equal(rt.admin.updateSubscription(alice, sub.id, { plan: 'Claude Max 20x', seats: 3 }).seats, 3)
    rt.admin.assign(alice, 'carol', 'claude', {})
    const account = rt.admin.addAccount(alice, { subscription: sub.id, account: 'ai-claude-1@example.com' })
    assert.deepEqual([account.vendor, account.subscription], ['claude', sub.id])
    assert.equal(rt.admin.accounts().find(a => a.id === account.id)?.member, 'carol', 'goes to the member waiting')
    await refused(409, () => rt.admin.addAccount(alice, { subscription: sub.id, account: 'ai-claude-1@example.com' }))
    await refused(400, () => rt.admin.addAccount(alice, { vendor: 'qwen', account: 'x' }))
    assert.throws(() => rt.admin.assign(alice, 'bob', 'claude', { cliAccount: account.id }), (e: Refusal) => e.status === 409)
    rt.admin.assign(alice, 'bob', 'claude', {})
    assert.equal(rt.admin.releaseAccount(alice, account.id), 'carol')
    assert.equal(rt.vendors.assignment('carol', 'claude'), undefined, 'carol no longer has Claude')
    assert.equal(rt.vendors.assignment('bob', 'claude')?.cliAccount, account.id, 'the next member waiting gets it')
    rt.admin.deleteSubscription(alice, sub.id)
    assert.equal(rt.vendors.account(account.id)?.subscription, null, 'accounts outlive their subscription')
  })

  it('keeps system config, sealing secret values and never showing them', async () => {
    rt.admin.setConfig(alice, { key: 'oss.bucket', value: 'gl-assets', group: '阿里云 OSS' })
    const secret = rt.admin.setConfig(alice, { key: 'oss.secret', value: 'very-secret', secret: true, group: '阿里云 OSS' })
    assert.equal(secret.value, null)
    rt.admin.setConfig(alice, { key: 'oss.secret', secret: true, note: '只读' })
    assert.equal(JSON.stringify(rt.admin.systemConfig()).includes('very-secret'), false)
    assert.equal(JSON.stringify(rt.self.systemConfig()).includes('very-secret'), false)
    await refused(400, () => rt.admin.setConfig(alice, { key: '1bad', value: 'x' }))
    const audit = JSON.stringify(rt.admin.auditLog())
    assert.equal(audit.includes('very-secret') || audit.includes('gl-assets'), false, 'values stay out of the audit log')
  })

  it('shows members what they were given, never the key itself', async () => {
    const profile = rt.self.profile(rt.self.subject(bobActor.member, null))
    const qwen = profile.vendors.find(v => v.vendor === 'qwen')
    assert.equal(qwen, undefined)
    const claude = profile.vendors.find(v => v.vendor === 'claude')
    assert.deepEqual(claude?.account, { account: 'ai-claude-1@example.com', plan: null })
    const alicesView = rt.self.profile(alice.member).vendors.find(v => v.vendor === 'qwen')
    assert.deepEqual(alicesView?.key, { label: '研发专用', last4: '9999' })
    assert.equal(alicesView?.url, 'http://127.0.0.1:1/agent-work/llm/qwen')
    assert.equal(JSON.stringify(rt.self.profile(alice.member)).includes('sk-'), false)
    await refused(403, () => rt.self.subject(bobActor.member, 'alice'))
    assert.equal(rt.self.subject(alice.member, 'bob').name, 'bob', 'administrators preview members')
  })

  it('issues internal keys for tools: the gateway and system config, not the Host config', async () => {
    const issued = rt.self.issueKey(bobActor, 'Claude Code')
    assert.match(issued.token, /^awk_/u)
    const bearer = { authorization: `Bearer ${issued.token}` }
    assert.deepEqual((await send(port, 'GET', '/agent-work/config/system', bearer)).json(), { 'oss.bucket': 'gl-assets', 'oss.secret': 'very-secret' })
    assert.deepEqual((await send(port, 'GET', '/agent-work/config/system/oss.bucket', bearer)).json(), { key: 'oss.bucket', value: 'gl-assets' })
    assert.equal((await send(port, 'GET', '/agent-work/config/system/nope', bearer)).status, 404)
    assert.equal((await send(port, 'GET', '/agent-work/config/system')).status, 401)
    assert.equal(rt.vendors.listPublic().find(e => e.key === 'oss.bucket')?.reads, 2, 'tool reads are counted')
    assert.equal((await send(port, 'GET', '/agent-work/config', bearer)).status, 403, 'the Host config is for device tokens')
    assert.equal((await send(port, 'GET', '/agent-work/whoami', bearer)).json().credential.kind, 'key')
    assert.equal(rt.self.devices(bobActor.member).find(d => d.id === issued.id)?.lastIp, '127.0.0.1', 'last address recorded')
    assert.equal(JSON.stringify(rt.self.devices(bobActor.member)).includes(issued.token), false, 'shown once')

    const alices = store.issueCredential('alice', 'device', 'mac', 60_000).credential.id
    await refused(404, () => { rt.self.revoke(bobActor, alices) })
    rt.self.revoke(bobActor, issued.id)
    assert.equal((await send(port, 'GET', '/agent-work/config/system', bearer)).status, 401, 'revoked at once')

    const byAdmin = rt.admin.issueKey(alice, 'bob', 'CI')
    rt.admin.setStatus(alice, 'bob', 'disabled')
    assert.equal((await send(port, 'GET', '/agent-work/config/system', { authorization: `Bearer ${byAdmin.token}` })).status, 401, 'disabling the member revokes their keys')
    await refused(409, () => rt.admin.issueKey(alice, 'bob', 'again'))
    rt.admin.setStatus(alice, 'bob', 'active')
    assert.equal(JSON.stringify(rt.admin.auditLog()).includes('awk_'), false, 'tokens stay out of the audit log')
    await refused(400, () => rt.self.issueKey(bobActor, ''))
  })

  it('sends the old console address to the web console', async () => {
    const old = await send(port, 'GET', '/agent-work/admin')
    assert.deepEqual([old.status, old.headers.location], [301, '/'])
    assert.equal((await send(port, 'GET', '/agent-work/admin/api/overview')).status, 301)
  })

  it('reports usage by member, vendor and key', () => {
    store.recordUsage('bob', 'x', { model: 'deepseek-flash', status: 200, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 }, { vendor: 'deepseek', apiKey: 'key_x' })
    const usage = rt.admin.usage(7)
    assert.equal(usage.members.find(u => u.member === 'bob')?.inputTokens, 100)
    assert.deepEqual(usage.byVendor, [{ member: 'bob', vendor: 'deepseek', tokens: 120 }])
    assert.equal(usage.daily[0]?.tokens, 120)
    assert.throws(() => rt.admin.usage(3), (e: Refusal) => e.status === 400)
  })
})
