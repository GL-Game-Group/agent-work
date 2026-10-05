/**
 * The company service behind real frps and frpc (opt-in: AGENT_WORK_FRP_DIR
 * names a directory holding both, e.g. an unpacked frp release). Proves what
 * the unit tests assume about frp: the plugin calls' shape, proxy names, and
 * that frps really refuses what the service rejects.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createTcpServer, connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import { Store } from '../src/db.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FRP = process.env.AGENT_WORK_FRP_DIR
const SECRET = 'frp-plugin-secret-0123456789abcdef'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createTcpServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => { resolve(port) }) })
  })
}

function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

/** Run an frp binary; resolves once its log shows `ready`, rejects on `fail` or exit. */
function run(dir: string, binary: 'frps' | 'frpc', config: string, ready: RegExp, fail = /(?!)/u): Promise<{ child: ChildProcess; log: () => string }> {
  const file = join(dir, `${binary}-${String(Math.random()).slice(2)}.toml`)
  writeFileSync(file, config)
  const child = spawn(join(FRP as string, binary), ['-c', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${binary} not ready:\n${log}`)) }, 10_000)
    const seen = (chunk: Buffer) => {
      log += chunk.toString()
      if (ready.test(log)) { clearTimeout(timer); resolve({ child, log: () => log }) }
      else if (fail.test(log)) { clearTimeout(timer); reject(Object.assign(new Error(log), { child })) }
    }
    child.stdout.on('data', seen)
    child.stderr.on('data', seen)
    child.on('exit', () => { clearTimeout(timer); reject(Object.assign(new Error(`${binary} exited:\n${log}`), { child })) })
  })
}

function get(port: number, host: string, auth?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host, ...auth === undefined ? {} : { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } } }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Send a line through a TCP port; what came back, or null when the connection closed without an answer. */
function echo(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write('ping\n') })
    let got = ''
    socket.setTimeout(3000, () => { socket.destroy(); resolve(got === '' ? null : got) })
    socket.on('data', (c) => { got += c.toString(); socket.end(); resolve(got) })
    socket.on('error', () => { resolve(null) })
    socket.on('close', () => { resolve(got === '' ? null : got) })
  })
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('frp end to end', { skip: FRP === undefined ? 'set AGENT_WORK_FRP_DIR to a directory with frps and frpc' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-work-frp-'))
  const store = new Store(':memory:')
  const children: ChildProcess[] = []
  let rt: Runtime
  let gateway: Server
  let web: Server
  let sshd: ReturnType<typeof createTcpServer>
  let bindPort = 0
  let vhostPort = 0
  let webPort = 0
  let sshPort = 0
  const token: Record<string, string> = {}

  const frpc = (user: string, device: string, body: string, ready = /start proxy success|start visitor success/u) =>
    run(dir, 'frpc', `serverAddr = "127.0.0.1"\nserverPort = ${String(bindPort)}\nuser = "${user}"\nloginFailExit = true\nmetadatas.token = "${token[device] as string}"\ntransport.heartbeatInterval = 1\ntransport.heartbeatTimeout = 30\nlog.level = "info"\n${body}`, ready, /login to the server failed|start error/u)
      .then((p) => { children.push(p.child); return p })

  before(async () => {
    store.addMember({ name: 'alice', githubId: 1, githubLogin: 'alice', role: 'admin', tunnels: true, ssh: true })
    store.addMember({ name: 'bob', githubId: 2, githubLogin: 'bob', role: 'member', tunnels: true, ssh: true })
    store.addMember({ name: 'carol', githubId: 3, githubLogin: 'carol', role: 'member', tunnels: true, ssh: true })
    for (const name of ['alice', 'bob', 'carol']) token[name] = store.issueCredential(name, 'device', name, 86_400_000).token
    bindPort = await freePort()
    vhostPort = await freePort()
    const config: GatewayConfig = {
      publicOrigin: 'https://agent.example.com', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false, databasePath: ':memory:',
      github: { clientId: 'x', clientSecret: 'x', org: '', webUrl: 'http://127.0.0.1:9', apiUrl: 'http://127.0.0.1:9' },
      frps: { addr: '127.0.0.1', port: bindPort, protocol: 'tcp', pluginSecret: SECRET, publicIp: null, vhost: { host: '127.0.0.1', port: vhostPort } },
    }
    rt = createRuntime(config, { store })
    rt.tunnels.addDomain({ name: 't.test' })
    rt.tunnels.markDomain('t.test', 'ok', 'ok')
    gateway = createServer((req, res) => { void rt.gateway(req, res) })
    gateway.on('upgrade', (req, socket, head) => { if (!rt.upgrade(req, socket, head)) socket.destroy() })
    const gatewayPort = await listen(gateway)
    web = createServer((_req, res) => { res.end('hello from alice') })
    webPort = await listen(web)
    sshd = createTcpServer((socket) => { socket.on('data', (c) => { socket.end(`echo ${c.toString()}`) }) })
    sshPort = await listen(sshd)
    const frps = await run(dir, 'frps', `bindAddr = "127.0.0.1"\nbindPort = ${String(bindPort)}\nvhostHTTPPort = ${String(vhostPort)}\nallowPorts = [{ start = 20000, end = 20099 }]\n
[[httpPlugins]]\nname = "agent-work"\naddr = "127.0.0.1:${String(gatewayPort)}"\npath = "/agent-work/frp/${SECRET}"\nops = ["Login", "NewProxy", "CloseProxy", "Ping", "NewUserConn"]\n`, /frps started successfully/u)
    children.push(frps.child)
  })

  after(() => {
    for (const child of children) child.kill()
    gateway.close(); web.close(); sshd.close()
  })

  it('refuses frpc logging in with a token that is not its member\'s device', async () => {
    token.stolen = token.alice as string
    await assert.rejects(frpc('bob', 'stolen', ''), /login to the server failed/u)
  })

  it('serves a registered web tunnel behind its password, and refuses an unregistered host', async () => {
    const t = rt.tunnels.create(store.member('alice')!, store.listCredentials('alice')[0]!, { type: 'http', name: 'web', localPort: webPort })
    const client = await frpc('alice', 'alice', `[[proxies]]\nname = "${t.id}"\ntype = "http"\nlocalPort = ${String(webPort)}\ncustomDomains = ["web-alice.t.test"]\nhttpUser = "guest"\nhttpPassword = "pw"\n`)
    assert.equal((await get(vhostPort, 'web-alice.t.test', 'guest:pw')).body, 'hello from alice')
    assert.equal((await get(vhostPort, 'web-alice.t.test')).status, 401)
    assert.equal(rt.tunnels.get(t.id)?.online, true)
    // The same tunnel id claiming another host: frps refuses the proxy.
    const forged = await frpc('alice', 'alice', `[[proxies]]\nname = "${t.id}x"\ntype = "http"\nlocalPort = ${String(webPort)}\ncustomDomains = ["admin.t.test"]\n`, /start error|start proxy success/u)
    assert.match(forged.log(), /公司服务里没有这条隧道|reject/u)
    assert.equal((await get(vhostPort, 'admin.t.test')).status, 404)
    // Heartbeats reach the service.
    const seen = rt.tunnels.get(t.id)?.lastSeenAt ?? 0
    await settle(2500)
    assert.ok((rt.tunnels.get(t.id)?.lastSeenAt ?? 0) > seen, 'Ping updates last seen')
    // Closed by an administrator: frps drops the client on its next heartbeat, frpc logs in again, and the tunnel is refused.
    rt.tunnels.setClosed(t.id, 'alice')
    await settle(3000)
    assert.equal(rt.tunnels.get(t.id)?.online, false, 'frps reported CloseProxy')
    assert.equal((await get(vhostPort, 'web-alice.t.test', 'guest:pw')).status, 404)
    assert.ok(client.log().split('login to server success').length > 2, 'frpc logged in again')
    assert.match(client.log(), /已被关闭|管理员已关闭这条隧道/u)
    // A revoked device cannot come back at all.
    rt.tunnels.setClosed(t.id, null)
    store.revokeCredential(store.listCredentials('alice')[0]!.id)
    await settle(3000)
    assert.equal((await get(vhostPort, 'web-alice.t.test', 'guest:pw')).status, 404)
  })

  it('connects SSH only for the members it allows', async () => {
    token.alice2 = store.issueCredential('alice', 'device', 'alice2', 86_400_000).token
    const device = store.listCredentials('alice').find(c => c.label === 'alice2')!
    const t = rt.tunnels.create(store.member('alice')!, device, { type: 'ssh', name: 'box', localPort: sshPort, sshAccess: ['bob'] })
    const own = rt.tunnels.forMember(store.member('alice')!).tunnels.find(x => x.id === t.id)!
    await frpc('alice', 'alice2', `[[proxies]]\nname = "${t.id}"\ntype = "stcp"\nlocalPort = ${String(sshPort)}\nsecretKey = "${own.secretKey as string}"\nallowUsers = ["bob"]\n`)
    const visitor = async (who: string) => {
      const port = await freePort()
      const key = rt.tunnels.forMember(store.member(who)!).shared.find(s => s.id === t.id)?.secretKey ?? own.secretKey
      await frpc(who, who, `[[visitors]]\nname = "ssh-${who}"\ntype = "stcp"\nserverUser = "alice"\nserverName = "${t.id}"\nsecretKey = "${key as string}"\nbindAddr = "127.0.0.1"\nbindPort = ${String(port)}\n`)
      return port
    }
    assert.equal(await echo(await visitor('bob')), 'echo ping\n')
    assert.equal(await echo(await visitor('carol')), null, 'not on the access list')
  })

  it('relays a signed-in phone to its Mac through frps, which frpc reaches with the Mac\'s secret', async () => {
    token.alice3 = store.issueCredential('alice', 'device', 'alice3', 86_400_000).token
    const device = store.listCredentials('alice').find(c => c.label === 'alice3')!
    const phone = store.issueCredential('alice', 'phone', 'iPhone', 86_400_000).token
    const t = rt.tunnels.create(store.member('alice')!, device, { type: 'remote' })
    // The Mac's remote server (remote.js in GL Work): only what carries frpc's header.
    const seen: string[] = []
    const mac = createServer((req, res) => {
      seen.push(`${String(req.headers['x-agent-work-remote'])} ${String(req.headers.authorization)}`)
      if (req.headers['x-agent-work-remote'] !== 'mac-secret') { res.writeHead(403).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url }))
    })
    mac.on('upgrade', (req, socket) => {
      if (req.headers['x-agent-work-remote'] !== 'mac-secret') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC11B85`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      socket.pipe(socket)
    })
    const macPort = await listen(mac)
    try {
      await frpc('alice', 'alice3', `[[proxies]]\nname = "${t.id}"\ntype = "http"\nlocalIP = "127.0.0.1"\nlocalPort = ${String(macPort)}\ncustomDomains = ["${t.host as string}"]\nrequestHeaders.set.x-agent-work-remote = "mac-secret"\n`)
      const gatewayPort = (gateway.address() as AddressInfo).port
      const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: gatewayPort, method: 'POST', path: `/agent-work/remote/${t.id}/api/session.list`, headers: { 'authorization': `Bearer ${phone}`, 'content-type': 'application/json' } }, (res) => {
          let body = ''
          res.on('data', (c: Buffer) => { body += c.toString() })
          res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
        })
        req.on('error', reject)
        req.end('{}')
      })
      assert.deepEqual([reply.status, JSON.parse(reply.body)], [200, { path: '/api/session.list' }])
      assert.deepEqual(seen, ['mac-secret undefined'], 'the phone\'s token stays at the company service')
      // The live events WebSocket, end to end.
      const socket = connect(gatewayPort, '127.0.0.1')
      socket.write(`GET /agent-work/remote/${t.id}/api/events.mux HTTP/1.1\r\nHost: agent.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${phone}\r\n\r\n`)
      const head = await new Promise<string>((resolve) => { socket.once('data', (c: Buffer) => { resolve(c.toString()) }) })
      assert.match(head, /^HTTP\/1\.1 101/u)
      const back = new Promise<string>((resolve) => { socket.once('data', (c: Buffer) => { resolve(c.toString()) }) })
      socket.write('frame bytes')
      assert.equal(await back, 'frame bytes')
      socket.destroy()
    } finally {
      mac.closeAllConnections()
      mac.close()
    }
  })
})
