/** Tunnels: what GL Work may define, and what frps lets through when it asks the company service. */
import assert from 'node:assert/strict'
import { request as httpRequest, createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import { Store } from '../src/db.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import type { Actor } from '../src/services.ts'

const pick = (d: { dns: string; cert: string }) => [d.dns, d.cert]

const SECRET = 'frp-plugin-secret-0123456789abcdef'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: () => any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...payload === undefined ? {} : { 'content-type': 'application/json' }, ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

describe('tunnels', () => {
  const store = new Store(':memory:')
  let rt: Runtime
  let service: Server
  let port = 0
  let admin: Actor
  /** Device tokens: alice has two machines; bob one; carol no SSH grant. */
  const token: Record<string, string> = {}
  let time = 1_800_000_000_000

  const as = (who: string) => ({ authorization: `Bearer ${token[who] as string}` })
  /** One frps plugin call, as frps makes it. */
  const frp = async (op: string, content: Record<string, unknown>, secret = SECRET) => {
    const res = await send(port, 'POST', `/agent-work/frp/${secret}?version=0.1.0&op=${op}`, {}, { version: '0.1.0', op, content })
    return { status: res.status, ...res.status === 200 ? res.json() : {} }
  }
  const userOf = (member: string, device = member) => ({ user: member, metas: { token: token[device] }, run_id: 'r1' })

  before(async () => {
    store.addMember({ name: 'alice', githubId: 1, githubLogin: 'alice', role: 'admin', tunnels: true, ssh: true })
    store.addMember({ name: 'bob', githubId: 2, githubLogin: 'bob', role: 'member', tunnels: true, ssh: true })
    store.addMember({ name: 'carol', githubId: 3, githubLogin: 'carol', role: 'member', tunnels: true, ssh: false })
    const config: GatewayConfig = {
      publicOrigin: 'https://agent.example.com', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false, databasePath: ':memory:',
      github: { clientId: 'x', clientSecret: 'x', org: '', webUrl: 'http://127.0.0.1:9', apiUrl: 'http://127.0.0.1:9' },
      frps: { addr: 'frp.example.com', port: 443, protocol: 'wss', pluginSecret: SECRET, publicIp: '203.0.113.7', vhost: null },
    }
    rt = createRuntime(config, { store, now: () => time })
    service = createServer((req, res) => { void rt.gateway(req, res) })
    port = await listen(service)
    admin = { member: store.member('alice')!, ip: '127.0.0.1' }
    for (const [key, member] of [['alice', 'alice'], ['alice2', 'alice'], ['bob', 'bob'], ['carol', 'carol']] as const) {
      token[key] = store.issueCredential(member, 'device', key, 86_400_000).token
    }
    token.browser = store.issueCredential('alice', 'browser', 'Chrome', 86_400_000).token
    token.key = store.issueCredential('alice', 'key', 'ci', 86_400_000).token
  })

  after(() => { service.close() })

  beforeEach(() => {
    for (const t of rt.tunnels.list()) rt.tunnels.delete(t.id, store.member(t.member))
    rt.tunnels.setSettings({ enabled: true, allowPublic: true, perMember: 5, ssh: true, publicTcp: false, portRange: '20000-20001' })
    store.setTunnelGrants('alice', { tunnels: true, ssh: true })
  })

  describe('domains', () => {
    it('must not be the service domain or its parent, and become usable once DNS and the certificate check out', async () => {
      await assert.rejects(async () => { rt.admin.addTunnelDomain(admin, { name: 'agent.example.com' }) }, /公司服务所在的域名/u)
      await assert.rejects(async () => { rt.admin.addTunnelDomain(admin, { name: 'example.com' }) }, /公司服务所在的域名/u)
      await assert.rejects(async () => { rt.admin.addTunnelDomain(admin, { name: 'not a domain' }) }, /有效的域名/u)
      const domain = rt.admin.addTunnelDomain(admin, { name: '*.t.example.net' })
      assert.equal(domain.name, 't.example.net')
      assert.equal(domain.isDefault, true)
      assert.deepEqual(rt.tunnels.usableDomains(), [])
      // A wildcard pointing elsewhere (no frps of ours behind it) is "wrong", and the certificate is not judged.
      const nowhere = async () => ({ tls: true, frps: false })
      assert.deepEqual(pick(await rt.tunnels.checkDomain('t.example.net', async () => ['198.51.100.1'], nowhere)), ['wrong', 'unknown'])
      assert.deepEqual(pick(await rt.tunnels.checkDomain('t.example.net', async () => { throw new Error('ENOTFOUND') }, nowhere)), ['missing', 'unknown'])
      // Behind Cloudflare: other addresses, but HTTPS reaches this frps.
      assert.deepEqual(pick(await rt.tunnels.checkDomain('t.example.net', async () => ['104.21.0.1'], async () => ({ tls: true, frps: true }))), ['ok', 'ok'])
      assert.deepEqual(pick(await rt.tunnels.checkDomain('t.example.net', async () => ['104.21.0.1'], async () => ({ tls: false, frps: false }))), ['wrong', 'unknown'])
      // Straight to the server, with a certificate that does not verify.
      assert.deepEqual(pick(await rt.tunnels.checkDomain('t.example.net', async () => ['203.0.113.7'], async () => ({ tls: false, frps: false }))), ['ok', 'failed'])
      rt.tunnels.markDomain('t.example.net', 'ok', 'ok')
      rt.admin.addTunnelDomain(admin, { name: 'dev.example.org' })
      await assert.rejects(async () => { rt.admin.setDefaultTunnelDomain(admin, 'dev.example.org') }, /就绪后/u)
      rt.tunnels.markDomain('dev.example.org', 'ok', 'ok')
      assert.deepEqual(rt.tunnels.usableDomains().map(d => d.name), ['t.example.net', 'dev.example.org'])
    })
  })

  describe('GL Work defines tunnels', () => {
    it('lists the server, grants, domains and its tunnels; device tokens only', async () => {
      const res = await send(port, 'GET', '/agent-work/tunnels', as('alice'))
      assert.equal(res.status, 200)
      const body = res.json()
      assert.deepEqual(body.server, { addr: 'frp.example.com', port: 443, protocol: 'wss' })
      assert.equal(body.settings.enabled, true)
      assert.deepEqual(body.grants, { tunnels: true, ssh: true })
      assert.deepEqual(body.colleagues.map((c: { name: string }) => c.name), ['bob', 'carol'])
      assert.equal((await send(port, 'GET', '/agent-work/tunnels', as('key'))).status, 403)
      assert.equal((await send(port, 'GET', '/agent-work/tunnels', { cookie: `aw_session=${token.browser as string}` })).status, 401)
      assert.equal((await send(port, 'GET', '/agent-work/tunnels')).status, 401)
    })

    it('creates a web tunnel at <name>-<member>.<domain>, and enforces grants, names, limits and passwords', async () => {
      const created = await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'http', name: 'preview', localPort: 5173, domain: 't.example.net' })
      assert.equal(created.status, 201)
      assert.equal(created.json().host, 'preview-alice.t.example.net')
      assert.equal(created.json().protection, 'password', 'a password unless the member asks for a public tunnel')
      const again = await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'http', name: 'preview', localPort: 3000 })
      assert.equal(again.status, 409)
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'http', name: 'Bad_Name', localPort: 1 })).status, 400)
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'http', name: 'x', localPort: 70000 })).status, 400)
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'http', name: 'x', localPort: 80, domain: 'evil.example' })).status, 400)
      rt.tunnels.setSettings({ allowPublic: false })
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'http', name: 'open', localPort: 80, protection: 'public' })).status, 400)
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('carol'), { type: 'ssh', name: 'box', localPort: 22, sshAccess: 'all' })).status, 403)
      rt.tunnels.setSettings({ perMember: 1 })
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'http', name: 'second', localPort: 80 })).status, 409)
      // Members change and delete only their own.
      const id = created.json().id as string
      assert.equal((await send(port, 'PATCH', `/agent-work/tunnels/${id}`, as('bob'), { localPort: 1 })).status, 404)
      assert.equal((await send(port, 'DELETE', `/agent-work/tunnels/${id}`, as('bob'))).status, 404)
      assert.equal((await send(port, 'PATCH', `/agent-work/tunnels/${id}`, as('alice'), { localPort: 4000 })).json().localPort, 4000)
      assert.equal((await send(port, 'DELETE', `/agent-work/tunnels/${id}`, as('alice'))).status, 204)
    })

    it('gives SSH tunnels a key, and shows them to the members allowed to connect', async () => {
      const created = await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'ssh', name: 'box', localPort: 22, sshAccess: ['bob', 'alice'] })
      assert.equal(created.status, 201)
      const mine = (await send(port, 'GET', '/agent-work/tunnels', as('alice'))).json()
      assert.deepEqual(mine.tunnels[0].allowUsers, ['bob'])
      assert.match(mine.tunnels[0].secretKey, /^.{32}$/u)
      const bob = (await send(port, 'GET', '/agent-work/tunnels', as('bob'))).json()
      assert.deepEqual(bob.shared.map((s: { owner: string; name: string }) => `${s.owner}/${s.name}`), ['alice/box'])
      assert.equal(bob.shared[0].secretKey, mine.tunnels[0].secretKey)
      assert.deepEqual((await send(port, 'GET', '/agent-work/tunnels', as('carol'))).json().shared, [])
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'ssh', name: 'x', localPort: 22, sshAccess: ['nobody'] })).status, 400)
      // Public ports: only when allowed, from the range, until it runs out.
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'ssh', name: 'pub', localPort: 22, sshAccess: 'all', publicPort: true })).status, 403)
      rt.tunnels.setSettings({ publicTcp: true })
      const ports = []
      for (const name of ['p1', 'p2']) ports.push((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'ssh', name, localPort: 22, sshAccess: 'all', publicPort: true })).json().publicPort)
      assert.deepEqual(ports, [20000, 20001])
      assert.equal((await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'ssh', name: 'p3', localPort: 22, sshAccess: 'all', publicPort: true })).status, 409)
    })
  })

  describe('frps asks the company service', () => {
    const web = async (who = 'alice') => (await send(port, 'POST', '/agent-work/tunnels', as(who), { type: 'http', name: 'web', localPort: 5173 })).json()
    const httpProxy = (id: string, member = 'alice', device = member, extra: Record<string, unknown> = {}) => ({
      user: userOf(member, device), proxy_name: `${member}.${id}`, proxy_type: 'http', custom_domains: [`web-${member}.t.example.net`], http_user: 'u', http_pwd: 'p', ...extra,
    })

    it('answers only on the secret path', async () => {
      assert.equal((await frp('Login', { user: 'alice', metas: { token: token.alice } }, 'wrong-secret')).status, 404)
      assert.equal((await frp('Login', { user: 'alice', metas: { token: token.alice } }, SECRET.slice(0, -1))).status, 404)
      assert.equal((await send(port, 'GET', `/agent-work/frp/${SECRET}`)).status, 404)
    })

    it('lets frpc log in only with a live device token of the member it claims to be', async () => {
      assert.deepEqual(await frp('Login', { user: 'alice', metas: { token: token.alice } }), { status: 200, reject: false, unchange: true })
      assert.equal((await frp('Login', { user: 'bob', metas: { token: token.alice } })).reject, true, 'user must be the token\'s member')
      assert.equal((await frp('Login', { user: 'alice', metas: { token: token.key } })).reject, true, 'internal keys are not devices')
      assert.equal((await frp('Login', { user: 'alice', metas: { token: token.browser } })).reject, true)
      assert.equal((await frp('Login', { user: 'alice', metas: {} })).reject, true)
      assert.equal((await frp('Login', { user: 'alice', privilege_key: 'anything' })).reject, true)
      rt.tunnels.setSettings({ enabled: false })
      assert.equal((await frp('Login', { user: 'alice', metas: { token: token.alice } })).reject, true)
    })

    it('opens a web tunnel only as registered, from the device that registered it', async () => {
      const t = await web()
      assert.equal((await frp('NewProxy', httpProxy(t.id))).reject, false)
      assert.equal(rt.tunnels.get(t.id)?.online, true)
      assert.equal((await frp('NewProxy', httpProxy(t.id, 'alice', 'alice2'))).reject, true, 'another device of the same member')
      assert.equal((await frp('NewProxy', { ...httpProxy(t.id), user: userOf('bob') })).reject, true, 'another member')
      assert.equal((await frp('NewProxy', httpProxy(t.id, 'alice', 'alice', { custom_domains: ['admin.t.example.net'] }))).reject, true, 'a host it was not given')
      assert.equal((await frp('NewProxy', httpProxy(t.id, 'alice', 'alice', { custom_domains: ['web-alice.t.example.net', 'x.t.example.net'] }))).reject, true)
      assert.equal((await frp('NewProxy', httpProxy(t.id, 'alice', 'alice', { subdomain: 'admin' }))).reject, true)
      assert.equal((await frp('NewProxy', httpProxy(t.id, 'alice', 'alice', { http_user: '', http_pwd: '' }))).reject, true, 'its password was dropped')
      assert.equal((await frp('NewProxy', httpProxy(t.id, 'alice', 'alice', { proxy_type: 'tcp', remote_port: 22 }))).reject, true, 'not the registered type')
      assert.equal((await frp('NewProxy', httpProxy('tun_unknown'))).reject, true, 'not registered')
      assert.equal((await frp('NewProxy', { ...httpProxy(t.id), proxy_name: `alice.${t.id as string}-public`, proxy_type: 'tcp', remote_port: 20000 })).reject, true)
      // The grant withdrawn, or the domain no longer usable: refused.
      store.setTunnelGrants('alice', { tunnels: false })
      assert.equal((await frp('NewProxy', httpProxy(t.id))).reject, true)
      store.setTunnelGrants('alice', { tunnels: true })
      rt.tunnels.markDomain('t.example.net', 'ok', 'failed')
      assert.equal((await frp('NewProxy', httpProxy(t.id))).reject, true)
      rt.tunnels.markDomain('t.example.net', 'ok', 'ok')
    })

    it('opens an SSH tunnel only with its key and access list, and a public port only as allocated', async () => {
      rt.tunnels.setSettings({ publicTcp: true })
      const t = (await send(port, 'POST', '/agent-work/tunnels', as('alice'), { type: 'ssh', name: 'box', localPort: 22, sshAccess: ['bob'], publicPort: true })).json()
      const sk = rt.tunnels.forMember(store.member('alice')!).tunnels[0]!.secretKey
      const stcp = (extra: Record<string, unknown> = {}) => ({ user: userOf('alice'), proxy_name: `alice.${t.id as string}`, proxy_type: 'stcp', sk, allow_users: ['bob'], ...extra })
      assert.equal((await frp('NewProxy', stcp())).reject, false)
      assert.equal((await frp('NewProxy', stcp({ sk: 'guessed' }))).reject, true)
      assert.equal((await frp('NewProxy', stcp({ allow_users: ['*'] }))).reject, true, 'opened to everyone behind the company\'s back')
      assert.equal((await frp('NewProxy', stcp({ allow_users: ['bob', 'carol'] }))).reject, true)
      assert.equal((await frp('NewProxy', stcp({ proxy_type: 'tcp', remote_port: 22 }))).reject, true)
      const pub = (remote: number) => ({ user: userOf('alice'), proxy_name: `alice.${t.id as string}-public`, proxy_type: 'tcp', remote_port: remote })
      assert.equal((await frp('NewProxy', pub(t.publicPort))).reject, false)
      assert.equal((await frp('NewProxy', pub(22))).reject, true)
      rt.tunnels.setSettings({ publicTcp: false })
      assert.equal((await frp('NewProxy', pub(t.publicPort))).reject, true)
      rt.tunnels.setSettings({ ssh: false })
      assert.equal((await frp('NewProxy', stcp())).reject, true)
    })

    it('stops what an administrator closed, a revoked device, and a disabled member', async () => {
      const t = await web()
      assert.equal((await frp('NewProxy', httpProxy(t.id))).reject, false)
      rt.admin.setTunnelClosed(admin, t.id, true)
      assert.throws(() => { rt.admin.deleteTunnel(admin, t.id) }, /先关闭/u, 'still running at frps')
      // The device's next heartbeat is refused, so frps drops it and asks about every tunnel again.
      assert.equal((await frp('Ping', { user: userOf('alice') })).reject, true)
      await frp('CloseProxy', { user: userOf('alice'), proxy_name: `alice.${t.id as string}` })
      assert.equal((await frp('Ping', { user: userOf('alice') })).reject, false)
      assert.equal((await frp('NewProxy', httpProxy(t.id))).reject, true)
      assert.equal((await frp('NewUserConn', { user: userOf('alice'), proxy_name: `alice.${t.id as string}`, proxy_type: 'http' })).reject, true)
      rt.admin.setTunnelClosed(admin, t.id, false)
      assert.equal((await frp('NewProxy', httpProxy(t.id))).reject, false)
      // So does a withdrawn grant.
      store.setTunnelGrants('alice', { tunnels: false })
      assert.equal((await frp('Ping', { user: userOf('alice') })).reject, true)
      store.setTunnelGrants('alice', { tunnels: true })
      // Heartbeats keep it online; frps closes the client when they are refused.
      time += 60_000
      assert.equal((await frp('Ping', { user: userOf('alice') })).reject, false)
      assert.equal(rt.tunnels.get(t.id)?.lastSeenAt, time)
      time += 10 * 60_000
      assert.equal(rt.tunnels.get(t.id)?.online, false, 'not heard of for long: offline')
      const bobs = store.issueCredential('bob', 'device', 'spare', 86_400_000)
      token.spare = bobs.token
      store.revokeCredential(bobs.credential.id)
      assert.equal((await frp('Ping', { user: userOf('bob', 'spare') })).reject, true)
      store.setStatus('bob', 'disabled')
      assert.equal((await frp('Ping', { user: userOf('bob') })).reject, true)
      assert.equal((await frp('Login', { user: 'bob', metas: { token: token.bob } })).reject, true)
      store.setStatus('bob', 'active')
      await frp('CloseProxy', { user: userOf('alice'), proxy_name: `alice.${t.id as string}` })
      assert.equal(rt.tunnels.get(t.id)?.online, false)
    })
  })
})
