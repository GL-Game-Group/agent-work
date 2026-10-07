/**
 * 手机远程: GL Work for iOS signs in, lists the member's Macs, and reaches
 * them only through the relay, against a fake GitHub and a stand-in for
 * frps's HTTP port (which routes on the Host header, as frps does).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import type { Store } from '../src/db.ts'
import { memoryStore } from './memory.ts'
import { GitHub } from '../src/github.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import { REMOTE_DOMAIN } from '../src/tunnels.ts'
import { codeChallenge, randomSecret } from '../src/tokens.ts'

const SECRET = 'remote-test-plugin-secret-0123456789'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** A raw WebSocket handshake through the relay; resolves with the response head and the socket. */
function upgrade(port: number, path: string, headers: Record<string, string>): Promise<{ head: string; socket: import('node:net').Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const lines = [`GET ${path} HTTP/1.1`, 'Host: agent.example.com', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)]
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      resolve({ head: buffer.subarray(0, end).toString(), socket, rest: buffer.subarray(end + 4) })
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

describe('手机远程', () => {
  const store = memoryStore()
  const github = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://github.invalid')
    const login = req.headers.authorization?.replace('Bearer tok-', '')
    const users: Record<string, number> = { alice: 101, bob: 102 }
    const reply = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => { reply(200, { access_token: `tok-${(JSON.parse(body) as { code: string }).code}` }) })
      return
    }
    if (url.pathname === '/user' && login !== undefined && users[login] !== undefined) { reply(200, { id: users[login], login }); return }
    reply(404, {})
  })
  /** What frps would pass to the Macs' frpc, by tunnel host. */
  const seen: { host: string | undefined; path: string | undefined; authorization: string | undefined; cookie: string | undefined; body: string }[] = []
  const vhost = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      if (!(req.headers.host ?? '').endsWith(`.${REMOTE_DOMAIN}`)) { res.writeHead(404, { 'content-type': 'text/html' }).end('not found'); return }
      seen.push({ host: req.headers.host, path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { echoed: body } } }))
    })
  })
  // The Mac's events.mux: accept the handshake, then echo bytes.
  vhost.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC11B85`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Seen-Host: ${String(req.headers.host)}\r\nX-Seen-Auth: ${String(req.headers.authorization ?? 'none')}\r\n\r\n`)
    socket.pipe(socket)
  })
  let rt: Runtime
  let service: Server
  let port = 0
  const device: Record<string, { id: string; token: string }> = {}
  const phone: Record<string, string> = {}

  /** frps opening a Mac's remote proxy, as its plugin call. */
  const openProxy = async (member: string, tunnel: string, extra: Record<string, unknown> = {}) => await rt.tunnels.frp('NewProxy', {
    user: { user: member, metas: { token: device[member]?.token } }, proxy_name: `${member}.${tunnel}`, proxy_type: 'http',
    custom_domains: [(await rt.tunnels.get(tunnel))?.host], ...extra,
  })

  async function phoneLogin(login: string, verifier = randomSecret()): Promise<Reply> {
    const clientState = randomSecret()
    const start = await send(port, 'GET', `/agent-work/auth/phone/start?code_challenge=${codeChallenge(verifier)}&state=${clientState}`)
    assert.equal(start.status, 302)
    const state = new URL(start.headers.location as string).searchParams.get('state') as string
    const callback = await send(port, 'GET', `/agent-work/auth/github/callback?code=${login}&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 303)
    const back = new URL(callback.headers.location as string)
    assert.equal(`${back.protocol}//${back.host}${back.pathname}`, 'glwork://auth')
    assert.equal(back.searchParams.get('state'), clientState)
    return send(port, 'POST', '/agent-work/auth/phone/token', { 'content-type': 'application/json' },
      JSON.stringify({ code: back.searchParams.get('code'), code_verifier: verifier, device_name: `${login} 的 iPhone` }))
  }

  before(async () => {
    await store.addMember({ name: 'alice', githubId: 101, githubLogin: 'alice', role: 'member' })
    await store.addMember({ name: 'bob', githubId: 102, githubLogin: 'bob', role: 'member' })
    for (const name of ['alice', 'bob']) {
      const issued = await store.issueCredential(name, 'device', `${name} 的 MacBook`, 86_400_000)
      device[name] = { id: issued.credential.id, token: issued.token }
    }
    const githubOrigin = `http://127.0.0.1:${String(await listen(github))}`
    const vhostPort = await listen(vhost)
    const config: GatewayConfig = {
      publicOrigin: 'https://agent.example.com', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false,
      github: { clientId: 'x', clientSecret: 'x', org: '', webUrl: githubOrigin, apiUrl: githubOrigin },
      frps: { addr: 'frp.example.com', port: 443, protocol: 'wss', pluginSecret: SECRET, publicIp: null, vhost: { host: '127.0.0.1', port: vhostPort } },
    }
    rt = await createRuntime(config, { store, authRateLimit: { requests: 1000, windowMs: 60_000 } })
    service = createServer((req, res) => { void rt.gateway(req, res) })
    service.on('upgrade', (req, socket, head) => { if (!rt.upgrade(req, socket, head)) socket.destroy() })
    port = await listen(service)
  })

  after(async () => {
    service.closeAllConnections()
    service.close()
    vhost.closeAllConnections()
    vhost.close()
    github.close()
    await store.close()
  })

  it('signs the phone in through GitHub with PKCE, as a phone and nothing more', async () => {
    const reply = await phoneLogin('alice')
    assert.equal(reply.status, 200)
    const body = JSON.parse(reply.body) as { token: string; member: string }
    assert.match(body.token, /^awp_/u)
    assert.equal(body.member, 'alice')
    phone.alice = body.token
    const bob = JSON.parse((await phoneLogin('bob')).body) as { token: string }
    phone.bob = bob.token
    assert.equal((await store.listCredentials('alice')).find(c => c.kind === 'phone')?.label, 'alice 的 iPhone')
  })

  it('keeps phone and desktop sign-in codes apart', async () => {
    // A phone's code traded at the desktop endpoint (or the other way round) is refused.
    const verifier = randomSecret()
    const start = await send(port, 'GET', `/agent-work/auth/phone/start?code_challenge=${codeChallenge(verifier)}&state=${randomSecret()}`)
    const state = new URL(start.headers.location as string).searchParams.get('state') as string
    const callback = await send(port, 'GET', `/agent-work/auth/github/callback?code=alice&state=${encodeURIComponent(state)}`)
    const code = new URL(callback.headers.location as string).searchParams.get('code')
    const desktop = await send(port, 'POST', '/agent-work/auth/desktop/token', { 'content-type': 'application/json' }, JSON.stringify({ code, code_verifier: verifier }))
    assert.equal(desktop.status, 400)
    assert.equal((await send(port, 'GET', '/agent-work/auth/phone/start?code_challenge=short&state=x')).status, 400)
  })

  it('gives a phone token none of the desktop\'s routes, and a desktop token none of the phone\'s', async () => {
    const asPhone = { authorization: `Bearer ${phone.alice as string}` }
    for (const path of ['/agent-work/config', '/agent-work/tunnels', '/agent-work/plugins', '/agent-work/config/system']) {
      assert.equal((await send(port, 'GET', path, asPhone)).status, 403, path)
    }
    // Nor is it a model key.
    assert.equal((await send(port, 'POST', '/agent-work/llm/deepseek/v1/messages', { ...asPhone, 'x-api-key': phone.alice as string, 'content-type': 'application/json' }, '{}')).status, 401)
    const asDevice = { authorization: `Bearer ${device.alice?.token as string}` }
    assert.equal((await send(port, 'GET', '/agent-work/remote/hosts', asDevice)).status, 404)
    assert.equal((await send(port, 'GET', '/agent-work/whoami', asPhone)).status, 200)
  })

  it('turns 手机远程 on once per Mac, outside the member\'s tunnel count', async () => {
    const alice = await store.member('alice')
    const mac = await store.credential(device.alice?.id as string)
    assert.ok(alice !== undefined && mac !== undefined)
    const first = await rt.tunnels.create(alice, mac, { type: 'remote' })
    assert.equal((await rt.tunnels.create(alice, mac, { type: 'remote' })).id, first.id)
    assert.match(first.host ?? '', new RegExp(`^r[0-9a-f]{24}\\.${REMOTE_DOMAIN.replace('.', '\\.')}$`, 'u'))
    await assert.rejects(async () => await rt.tunnels.update(alice, first.id, { localPort: 22 }), /没有可以修改/u)
    await assert.rejects(async () => await rt.tunnels.addDomain({ name: REMOTE_DOMAIN }), /手机远程/u)
    const bob = await store.member('bob')
    const bobMac = await store.credential(device.bob?.id as string)
    assert.ok(bob !== undefined && bobMac !== undefined)
    await rt.tunnels.create(bob, bobMac, { type: 'remote' })
  })

  it('lets frps open a Mac\'s remote proxy only as registered, from that Mac', async () => {
    const alice = (await rt.tunnels.list('alice')).find(t => t.type === 'remote')
    assert.ok(alice !== undefined)
    assert.equal((await openProxy('alice', alice.id, { custom_domains: ['evil.glwork.dev'] })).reject, true)
    assert.equal((await openProxy('alice', alice.id, { http_user: 'u', http_pwd: 'p' })).reject, true)
    assert.equal((await openProxy('alice', alice.id, { proxy_type: 'tcp' })).reject, true)
    // Bob's Mac claiming Alice's remote tunnel.
    assert.equal((await rt.tunnels.frp('NewProxy', { user: { user: 'bob', metas: { token: device.bob?.token } }, proxy_name: `bob.${alice.id}`, proxy_type: 'http', custom_domains: [alice.host] })).reject, true)
    assert.equal((await openProxy('alice', alice.id)).reject, false)
  })

  it('lists the member\'s own Macs to their phone', async () => {
    const reply = await send(port, 'GET', '/agent-work/remote/hosts', { authorization: `Bearer ${phone.alice as string}` })
    const { hosts } = JSON.parse(reply.body) as { hosts: { id: string; label: string; online: boolean }[] }
    assert.deepEqual(hosts.map(h => [h.label, h.online]), [['alice 的 MacBook', true]])
  })

  it('relays a phone\'s request to its own Mac only, without its credential', async () => {
    const alice = (await rt.tunnels.list('alice')).find(t => t.type === 'remote')
    const bob = (await rt.tunnels.list('bob')).find(t => t.type === 'remote')
    assert.ok(alice !== undefined && bob !== undefined)
    const headers = { 'authorization': `Bearer ${phone.alice as string}`, 'content-type': 'application/json', 'cookie': 'x=1' }
    const ok = await send(port, 'POST', `/agent-work/remote/${alice.id}/api/session.list`, headers, '{"type":"client-request"}')
    assert.equal(ok.status, 200)
    assert.equal((JSON.parse(ok.body) as { result: { value: { echoed: string } } }).result.value.echoed, '{"type":"client-request"}')
    assert.deepEqual(seen.at(-1), { host: alice.host, path: '/api/session.list', authorization: undefined, cookie: undefined, body: '{"type":"client-request"}' })
    // Someone else's Mac, an unknown one, a bad method name, the wrong verb, no token.
    assert.equal((await send(port, 'POST', `/agent-work/remote/${bob.id}/api/session.list`, headers, '{}')).status, 404)
    assert.equal((await send(port, 'POST', '/agent-work/remote/tun_nope/api/session.list', headers, '{}')).status, 404)
    assert.equal((await send(port, 'POST', `/agent-work/remote/${alice.id}/api/..%2Fadmin`, headers, '{}')).status, 404)
    assert.equal((await send(port, 'GET', `/agent-work/remote/${alice.id}/api/session.list`, headers)).status, 404)
    assert.equal((await send(port, 'POST', `/agent-work/remote/${alice.id}/api/session.list`, { 'content-type': 'application/json' }, '{}')).status, 401)
    // A desktop token is not a phone.
    assert.equal((await send(port, 'POST', `/agent-work/remote/${alice.id}/api/session.list`, { authorization: `Bearer ${device.alice?.token as string}` }, '{}')).status, 404)
    assert.ok(seen.every(s => s.host === alice.host))
  })

  it('relays the live events WebSocket to the phone\'s own Mac only', async () => {
    const alice = (await rt.tunnels.list('alice')).find(t => t.type === 'remote')
    const bob = (await rt.tunnels.list('bob')).find(t => t.type === 'remote')
    assert.ok(alice !== undefined && bob !== undefined)
    const ok = await upgrade(port, `/agent-work/remote/${alice.id}/api/events.mux`, { Authorization: `Bearer ${phone.alice as string}` })
    assert.match(ok.head, /^HTTP\/1\.1 101/u)
    assert.match(ok.head, new RegExp(`X-Seen-Host: ${alice.host as string}`, 'u'))
    assert.match(ok.head, /X-Seen-Auth: none/u)
    const echoed = new Promise<string>((resolve) => { ok.socket.once('data', (chunk: Buffer) => { resolve(chunk.toString()) }) })
    ok.socket.write('hello mac')
    assert.equal(await echoed, 'hello mac')
    ok.socket.destroy()
    for (const [path, auth, status] of [
      [`/agent-work/remote/${bob.id}/api/events.mux`, phone.alice, 404],
      [`/agent-work/remote/${alice.id}/api/events.mux`, device.alice?.token, 401],
      [`/agent-work/remote/${alice.id}/api/events.mux`, 'awp_forged', 401],
      [`/agent-work/remote/${alice.id}/api/session.list`, phone.alice, 404],
    ] as const) {
      const refused = await upgrade(port, path, { Authorization: `Bearer ${String(auth)}` })
      assert.match(refused.head, new RegExp(`^HTTP/1\\.1 ${String(status)}`, 'u'), path)
      refused.socket.destroy()
    }
    assert.equal((await store.recentAudit()).filter(e => e.action === 'remote-connect').length, 1)
  })

  it('stops relaying when the administrator closes it, the Mac goes away, or the phone is revoked', async () => {
    const alice = (await rt.tunnels.list('alice')).find(t => t.type === 'remote')
    assert.ok(alice !== undefined)
    const path = `/agent-work/remote/${alice.id}/api/session.list`
    const headers = { authorization: `Bearer ${phone.alice as string}` }
    await rt.tunnels.setClosed(alice.id, 'admin')
    assert.equal((await send(port, 'POST', path, headers, '{}')).status, 403)
    assert.equal((await openProxy('alice', alice.id)).reject, true)
    await rt.tunnels.setClosed(alice.id, null)
    await rt.tunnels.frp('CloseProxy', { user: { user: 'alice', metas: { token: device.alice?.token } }, proxy_name: `alice.${alice.id}` })
    const offline = await send(port, 'POST', path, headers, '{}')
    assert.equal(offline.status, 503)
    await openProxy('alice', alice.id)
    await rt.tunnels.setSettings({ remote: false })
    assert.equal((await send(port, 'POST', path, headers, '{}')).status, 403)
    await rt.tunnels.setSettings({ remote: true })
    const id = (await store.listCredentials('alice')).find(c => c.kind === 'phone')?.id as string
    await store.revokeCredential(id)
    assert.equal((await send(port, 'POST', path, headers, '{}')).status, 401)
    // A Mac that signed out drops off the list.
    await store.revokeCredential(device.alice?.id as string)
    const hosts = JSON.parse((await send(port, 'GET', '/agent-work/remote/hosts', { authorization: `Bearer ${phone.bob as string}` })).body) as { hosts: unknown[] }
    assert.equal(hosts.hosts.length, 1)
  })
})
