/**
 * 内网穿透 end to end: a real `dsh web` Host with the team bundle and this
 * plugin, the company service (gateway/) on loopback with a fake GitHub, a real
 * frps calling the service back, and the frpc this plugin runs. A second member
 * (bob) is a bare frpc with his device token, standing in for his GL Work.
 *
 * Usage: AGENT_WORK_DSH=<dir containing node_modules/.bin/dsh> AGENT_WORK_FRP_DIR=<frp release dir> \
 *   node --test plugins/tunnel/test/tunnel.e2e.mjs
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import WebSocket from 'ws'
import { Store } from '../../../gateway/src/db.ts'
import { GitHub } from '../../../gateway/src/github.ts'
import { createGateway } from '../../../gateway/src/server.ts'
import { Tunnels } from '../../../gateway/src/tunnels.ts'

const DSH_DIR = process.env.AGENT_WORK_DSH
const FRP_DIR = process.env.AGENT_WORK_FRP_DIR
const TEAM_BUNDLE = resolve(import.meta.dirname, '..', '..', 'team-bundle')
const PLUGIN = resolve(import.meta.dirname, '..')
const CLIENT = { version: 'e2e', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }
const SECRET = 'frp-plugin-secret-0123456789abcdef'
const sleep = ms => new Promise((done) => { setTimeout(done, ms) })

function listen(server, port = 0) {
  return new Promise((done) => { server.listen(port, '127.0.0.1', () => { done(server.address().port) }) })
}

async function freePort() {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((done) => { probe.close(done) })
  return port
}

/** GET through frps' vhost port. */
function vhost(port, host, auth) {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host, ...auth ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {} } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { done({ status: res.statusCode, body }) })
    })
    req.on('error', fail)
    req.end()
  })
}

/** A line through a TCP port; what came back, or null. */
function echo(port) {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write('ping\n') })
    let got = ''
    socket.setTimeout(3000, () => { socket.destroy(); done(got || null) })
    socket.on('data', (c) => { got += c; socket.end(); done(got) })
    socket.on('error', () => { done(null) })
    socket.on('close', () => { done(got || null) })
  })
}

/** Start a process and wait for a line in its output. */
function started(command, args, env, ready, label) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const promise = new Promise((done, fail) => {
    const timer = setTimeout(() => { fail(new Error(`${label} did not start:\n${output}`)) }, 60_000)
    const read = (chunk) => {
      output += chunk
      const match = ready.exec(output)
      if (match) { clearTimeout(timer); done(match) }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
  })
  return { child, promise, output: () => output }
}

describe('内网穿透 in a real Host', { skip: DSH_DIR === undefined || FRP_DIR === undefined ? 'set AGENT_WORK_DSH and AGENT_WORK_FRP_DIR' : false }, () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-tunnel-'))
  const store = new Store(':memory:')
  const children = []
  let gateway, github, gatewayOrigin, hostOrigin, cookie, tunnels, vhostPort, webPort, sshPort, host

  async function rpc(method, args = {}) {
    const response = await fetch(`${hostOrigin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: hostOrigin },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    })
    const envelope = await response.json()
    assert.equal(envelope.result?.ok, true, `${method}: ${JSON.stringify(envelope)}`)
    return envelope.result.value
  }

  /** The plugin's own routes, as its page calls them. */
  async function page(refresh = false) {
    const response = await fetch(`${hostOrigin}/api/agent-work/tunnel${refresh ? '?refresh' : ''}`, { headers: { cookie } })
    assert.equal(response.status, 200)
    return response.json()
  }
  async function action(body, status = 200) {
    const response = await fetch(`${hostOrigin}/api/agent-work/tunnel/action`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: hostOrigin }, body: JSON.stringify(body) })
    const value = await response.json()
    assert.equal(response.status, status, JSON.stringify(value))
    return value
  }
  async function until(predicate, label, refresh = false) {
    let last
    for (let i = 0; i < 100; i += 1) {
      last = await page(refresh)
      if (predicate(last)) return last
      await sleep(200)
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`)
  }

  before(async () => {
    github = createServer((req, res) => {
      const url = new URL(req.url, 'http://github.invalid')
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
      if (url.pathname === '/login/oauth/access_token') {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => { send(200, { access_token: `tok-${JSON.parse(body).code}` }) })
        return
      }
      if (url.pathname === '/user' && req.headers.authorization === 'Bearer tok-alice') { send(200, { id: 101, login: 'alice-gh' }); return }
      send(404, {})
    })
    const githubOrigin = `http://127.0.0.1:${await listen(github)}`
    const gatewayPort = await freePort()
    const bindPort = await freePort()
    vhostPort = await freePort()
    gatewayOrigin = `http://127.0.0.1:${gatewayPort}`
    const config = {
      publicOrigin: gatewayOrigin, listenHost: '127.0.0.1', listenPort: gatewayPort, trustProxy: false, databasePath: ':memory:',
      github: { clientId: 'id', clientSecret: 'secret', org: '', webUrl: githubOrigin, apiUrl: githubOrigin },
      frps: { addr: '127.0.0.1', port: bindPort, protocol: 'tcp', pluginSecret: SECRET, publicIp: null, vhost: { host: '127.0.0.1', port: vhostPort } },
    }
    store.addMember({ name: 'alice', githubId: 101, githubLogin: 'alice-gh', role: 'member', tunnels: true, ssh: true })
    store.addMember({ name: 'bob', githubId: 102, githubLogin: 'bob-gh', role: 'member', tunnels: true, ssh: true })
    tunnels = new Tunnels(store, config)
    tunnels.addDomain({ name: 't.test' })
    tunnels.markDomain('t.test', 'ok', 'ok')
    gateway = createGateway({ config, store, github: new GitHub(config.github), authRateLimit: { requests: 1000, windowMs: 60_000 } })
    await listen(gateway, gatewayPort)

    // Alice's local services.
    const web = createServer((_req, res) => { res.end('hello from alice') })
    webPort = await listen(web)
    const sshd = createTcpServer((socket) => { socket.on('data', (c) => { socket.end(`echo ${c}`) }) })
    sshPort = await listen(sshd)
    children.push({ kill: () => { web.close(); sshd.close() } })

    const frpsToml = join(home, 'frps.toml')
    writeFileSync(frpsToml, `bindAddr = "127.0.0.1"\nbindPort = ${bindPort}\nvhostHTTPPort = ${vhostPort}\n
[[httpPlugins]]\nname = "agent-work"\naddr = "127.0.0.1:${gatewayPort}"\npath = "/agent-work/frp/${SECRET}"\nops = ["Login", "NewProxy", "CloseProxy", "Ping", "NewUserConn"]\n`)
    const frps = started(join(FRP_DIR, 'frps'), ['-c', frpsToml], process.env, /frps started successfully/, 'frps')
    children.push(frps.child)
    await frps.promise

    const dsh = join(DSH_DIR, 'node_modules', '.bin', 'dsh')
    const env = { ...process.env, DSH_HOME: home }
    execFileSync(dsh, ['plugin', '--profile', 'web', 'add', `file:${TEAM_BUNDLE}`], { env, stdio: 'ignore' })
    execFileSync(dsh, ['plugin', '--profile', 'web', 'add', `file:${PLUGIN}`], { env, stdio: 'ignore' })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `- id: company-account\n  config:\n    serverOrigin: '${gatewayOrigin}'\n    allowLoopbackHttp: true\n`
      + `- id: agent-work-tunnel\n  config:\n    frpcPath: '${join(FRP_DIR, 'frpc')}'\n    refreshMs: 5000\n`)
    const hostPort = await freePort()
    hostOrigin = `http://127.0.0.1:${hostPort}`
    host = started(dsh, ['web', '--no-open', '--port', String(hostPort)], env, /token=([A-Za-z0-9_-]+)/, 'Host')
    children.push(host.child)
    const [, token] = await host.promise
    const exchange = await fetch(`${hostOrigin}/?token=${token}`, { redirect: 'manual' })
    cookie = exchange.headers.get('set-cookie').split(';')[0]

    // Alice signs in, as in the account e2e.
    await rpc('account/startSignIn', { client: CLIENT, callbackOrigin: hostOrigin, loginSource: 'desktop' })
    let attempt
    for (let i = 0; i < 100 && attempt === undefined; i += 1) {
      const state = await rpc('account/getState')
      if (state.attempt?.phase === 'waiting-browser') attempt = state.attempt
      else await sleep(100)
    }
    const start = await fetch(`${attempt.authorizeUrl}`, { redirect: 'manual' })
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    const callback = await fetch(`${gatewayOrigin}/agent-work/auth/github/callback?code=alice&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    await fetch(new URL(callback.headers.get('location')), { redirect: 'manual' })
    for (let i = 0; i < 100; i += 1) {
      if ((await rpc('account/getState')).status === 'credential-stored') break
      await sleep(100)
    }
  })

  after(() => {
    for (const child of children) child.kill()
    gateway?.close()
    github?.close()
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('shows the member\'s tunnel settings once signed in', async () => {
    const view = await until(v => v.signedIn === true, 'signed in', true)
    assert.equal(view.enabled, true)
    assert.deepEqual(view.domains, [{ name: 't.test', isDefault: true }])
    assert.deepEqual(view.colleagues.map(c => c.name), ['bob'])
    assert.equal(view.frpc.available, true)
    assert.equal(view.frpc.running, false, 'nothing to run yet')
  })

  it('opens a web tunnel behind a password only this machine knows', async () => {
    const created = await action({ op: 'create', type: 'http', name: 'web', localPort: webPort, protection: 'password' })
    const view = await until(v => v.tunnels.find(t => t.id === created.created)?.state === 'on', 'web tunnel on')
    const t = view.tunnels.find(x => x.name === 'web')
    assert.equal(t.host, 'web-alice.t.test')
    assert.equal(t.auth.user, 'guest')
    assert.equal((await vhost(vhostPort, t.host, `${t.auth.user}:${t.auth.password}`)).body, 'hello from alice')
    assert.equal((await vhost(vhostPort, t.host)).status, 401)
    assert.equal((await vhost(vhostPort, t.host, 'guest:wrong')).status, 401)
    // Changing the password restarts frpc with it.
    await action({ op: 'password', id: t.id, user: 'team', password: 'secret-1' })
    await until(v => v.tunnels.find(x => x.id === t.id)?.state === 'on', 'restarted')
    for (let i = 0; i < 50 && (await vhost(vhostPort, t.host, 'team:secret-1')).status !== 200; i += 1) await sleep(200)
    assert.equal((await vhost(vhostPort, t.host, 'team:secret-1')).body, 'hello from alice')
    assert.equal((await vhost(vhostPort, t.host, `guest:${t.auth.password}`)).status, 401)
  })

  it('opens a public web tunnel without a password, and turns the password on and off', async () => {
    const created = await action({ op: 'create', type: 'http', name: 'open', localPort: webPort, protection: 'public' })
    let view = await until(v => v.tunnels.find(t => t.id === created.created)?.state === 'on', 'public tunnel on')
    const t = view.tunnels.find(x => x.id === created.created)
    assert.equal(t.protection, 'public')
    assert.equal(t.auth, null, 'no password shown for a public tunnel')
    assert.equal((await vhost(vhostPort, t.host)).body, 'hello from alice')
    // Password on: frpc restarts with Basic Auth.
    await action({ op: 'update', id: t.id, protection: 'password' })
    view = await until(v => v.tunnels.find(x => x.id === t.id)?.auth !== null && v.tunnels.find(x => x.id === t.id)?.state === 'on', 'password on')
    const auth = view.tunnels.find(x => x.id === t.id).auth
    for (let i = 0; i < 50 && (await vhost(vhostPort, t.host)).status !== 401; i += 1) await sleep(200)
    assert.equal((await vhost(vhostPort, t.host)).status, 401)
    assert.equal((await vhost(vhostPort, t.host, `${auth.user}:${auth.password}`)).body, 'hello from alice')
    // And off again.
    await action({ op: 'update', id: t.id, protection: 'public' })
    for (let i = 0; i < 50 && (await vhost(vhostPort, t.host)).status !== 200; i += 1) await sleep(200)
    assert.equal((await vhost(vhostPort, t.host)).body, 'hello from alice')
    await action({ op: 'delete', id: t.id })
  })

  it('reaches a dev server that listens on IPv6 localhost only (Vite on recent Node)', async () => {
    const v6 = createServer((_req, res) => { res.end('hello over ::1') })
    const port = await new Promise((done) => { v6.listen(0, '::1', () => { done(v6.address().port) }) })
    children.push({ kill: () => { v6.close() } })
    const created = await action({ op: 'create', type: 'http', name: 'vite', localPort: port, protection: 'public' })
    const view = await until(v => v.tunnels.find(t => t.id === created.created)?.state === 'on', 'v6 tunnel on')
    const t = view.tunnels.find(x => x.id === created.created)
    let reply = { status: 0, body: '' }
    for (let i = 0; i < 25 && reply.body !== 'hello over ::1'; i += 1) { reply = await vhost(vhostPort, t.host); if (reply.body !== 'hello over ::1') await sleep(200) }
    assert.equal(reply.body, 'hello over ::1')
    await action({ op: 'delete', id: t.id })
  })

  it('shares SSH both ways: bob reaches alice, alice reaches bob', async () => {
    const created = await action({ op: 'create', type: 'ssh', name: 'box', localPort: sshPort, sshAccess: ['bob'] })
    await until(v => v.tunnels.find(t => t.id === created.created)?.state === 'on', 'ssh tunnel on')
    // Bob's GL Work: a visitor to alice's box, and his own box shared with alice.
    const bob = store.member('bob')
    const bobDevice = store.issueCredential('bob', 'device', 'bob-mac', 86_400_000)
    const bobSshd = createTcpServer((socket) => { socket.on('data', (c) => { socket.end(`bob ${c}`) }) })
    const bobSshPort = await listen(bobSshd)
    children.push({ kill: () => { bobSshd.close() } })
    const bobBox = tunnels.create(bob, bobDevice.credential, { type: 'ssh', name: 'bobbox', localPort: bobSshPort, sshAccess: ['alice'] })
    const view = tunnels.forMember(bob, bobDevice.credential.id)
    const own = view.tunnels.find(t => t.id === bobBox.id)
    const shared = view.shared.find(s => s.owner === 'alice')
    const visitPort = await freePort()
    const toml = join(home, 'bob.toml')
    writeFileSync(toml, `serverAddr = "127.0.0.1"\nserverPort = ${tunnels.server.port}\nuser = "bob"\nmetadatas.token = "${bobDevice.token}"\ntransport.heartbeatInterval = 30\n
[[proxies]]\nname = "${bobBox.id}"\ntype = "stcp"\nlocalPort = ${bobSshPort}\nsecretKey = "${own.secretKey}"\nallowUsers = ["alice"]\n
[[visitors]]\nname = "v"\ntype = "stcp"\nserverUser = "alice"\nserverName = "${shared.id}"\nsecretKey = "${shared.secretKey}"\nbindAddr = "127.0.0.1"\nbindPort = ${visitPort}\n`)
    const bobFrpc = started(join(FRP_DIR, 'frpc'), ['-c', toml], process.env, /start visitor success/, 'bob frpc')
    children.push(bobFrpc.child)
    await bobFrpc.promise
    for (let i = 0; i < 30 && !bobFrpc.output().includes('start proxy success'); i += 1) await sleep(200)
    assert.equal(await echo(visitPort), 'echo ping\n', 'bob reaches alice\'s box')

    // Alice connects to bob's box from her GL Work.
    const listed = await until(v => v.shared.some(s => s.owner === 'bob' && s.online), 'bob\'s box listed', true)
    const box = listed.shared.find(s => s.owner === 'bob')
    const { port } = await action({ op: 'connect', id: box.id })
    assert.ok(port >= 62200)
    await until(v => v.shared.find(s => s.id === box.id)?.ready === true, 'visitor ready')
    assert.equal(await echo(port), 'bob ping\n', 'alice reaches bob\'s box')
    await action({ op: 'disconnect', id: box.id })
    await until(v => v.shared.find(s => s.id === box.id)?.port === null, 'disconnected')
  })

  it('stops what an administrator closes, and shows why', async () => {
    const t = (await page()).tunnels.find(x => x.name === 'web')
    tunnels.setClosed(t.id, 'admin')
    // frps drops alice's frpc at its next heartbeat (30 s); the page knows at once from the company service.
    const view = await until(v => v.tunnels.find(x => x.id === t.id)?.state === 'closed', 'closed', true)
    assert.equal(view.tunnels.find(x => x.id === t.id).message, '管理员已关闭这条隧道')
    for (let i = 0; i < 50 && (await vhost(vhostPort, t.host, 'team:secret-1')).status === 200; i += 1) await sleep(200)
    assert.equal((await vhost(vhostPort, t.host, 'team:secret-1')).status, 404, 'no longer served: GL Work restarted frpc without it')
  })

  it('refuses tunnels the member may not open', async () => {
    store.setTunnelGrants('alice', { ssh: false })
    await page(true)
    const refused = await action({ op: 'create', type: 'ssh', name: 'nope', localPort: 22, sshAccess: 'all' }, 403)
    assert.match(refused.error, /还没有开通 SSH/u)
    store.setTunnelGrants('alice', { ssh: true })
  })

  it('stops frpc when the last tunnel is turned off', async () => {
    const view = await page(true)
    for (const t of view.tunnels.filter(x => x.running)) await action({ op: 'stop', id: t.id })
    await until(v => v.frpc.running === false, 'frpc stopped')
    const box = view.tunnels.find(x => x.name === 'box')
    await action({ op: 'delete', id: box.id })
    assert.equal(tunnels.get(box.id), undefined)
  })

  it('lets alice\'s phone use this Host through the company relay (手机远程)', async () => {
    await action({ op: 'remote-on' })
    const view = await until(v => v.phone?.state === 'on', '手机远程 on')
    assert.equal(view.tunnels.some(t => t.type === 'remote'), false, 'not listed among tunnels')
    const phone = store.issueCredential('alice', 'phone', 'iPhone', 86_400_000).token
    const asPhone = { authorization: `Bearer ${phone}` }
    const { hosts } = await (await fetch(`${gatewayOrigin}/agent-work/remote/hosts`, { headers: asPhone })).json()
    assert.equal(hosts.length, 1)
    assert.equal(hosts[0].online, true)
    const remoteRpc = async (method, payload = {}) => {
      const response = await fetch(`${gatewayOrigin}/agent-work/remote/${hosts[0].id}/api/${method}`, {
        method: 'POST', headers: { ...asPhone, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', method, rpcId: crypto.randomUUID(), payload }),
      })
      assert.equal(response.status, 200, method)
      const body = await response.json()
      assert.equal(body.result?.ok, true, `${method}: ${JSON.stringify(body)}`)
      return body.result.value
    }
    assert.match((await remoteRpc('host.describe')).version, /^GL Work /u)
    assert.ok(Array.isArray((await remoteRpc('session.list')).items))
    assert.ok(Array.isArray((await remoteRpc('workspace.list')).items))
    // The live events stream opens both Host streams (control, $events) and stays up.
    const socket = new WebSocket(`${gatewayOrigin.replace('http', 'ws')}/agent-work/remote/${hosts[0].id}/api/events.mux`, { headers: asPhone })
    const closed = new Promise(done => socket.on('close', code => done(code)))
    await new Promise((done, fail) => { socket.on('open', done); socket.on('error', fail) })
    const frames = []
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    const early = await Promise.race([closed, sleep(1000).then(() => 'open')])
    assert.equal(early, 'open', `events.mux closed with ${String(early)}`)
    // A session started and prompted from the phone: its events arrive live, and its history reads back.
    const { sessionId } = await remoteRpc('session.create', { cwd: home })
    await remoteRpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'hello from the phone' }] })
    for (let i = 0; i < 50 && !frames.some(f => f.payload.sessionId === sessionId && f.payload.type === 'session/event'); i += 1) await sleep(100)
    assert.ok(frames.some(f => f.payload.sessionId === sessionId && f.payload.type === 'session/event'), `no live events: ${JSON.stringify(frames.map(f => f.payload.type))}`)
    const history = await remoteRpc('session.history', { sessionId, maxMessages: 10 })
    assert.match(JSON.stringify(history.events), /hello from the phone/u)
    const models = await remoteRpc('session.models', { sessionId })
    assert.ok(Array.isArray(models.groups))
    // The modes the phone names sessions' modes with.
    const { presets } = await remoteRpc('agentPresets/list')
    assert.ok(presets.some(p => p.isDefault), JSON.stringify(presets))
    // Picking a mode: a new session takes it before its first message; a started one keeps its own.
    const other = presets.find(p => !p.isDefault) ?? presets[0]
    const blank = (await remoteRpc('session.create', { cwd: home })).sessionId
    assert.equal(await remoteRpc('agentPresets/select', { args: { agentId: blank, agentPreset: other.id } }), other.id)
    const refused = await (await fetch(`${gatewayOrigin}/agent-work/remote/${hosts[0].id}/api/agentPresets/select`, {
      method: 'POST', headers: { ...asPhone, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'agentPresets/select', rpcId: crypto.randomUUID(), payload: { args: { agentId: sessionId, agentPreset: other.id } } }),
    })).json()
    assert.equal(refused.result?.ok, false, JSON.stringify(refused))
    // @-mentions in the phone's composer.
    assert.ok(Array.isArray(await remoteRpc('fileReferences/list', { args: { agentId: sessionId, query: '' } })))
    assert.ok(Array.isArray(await remoteRpc('sessionReferenceResolver/candidates', { args: { agentId: sessionId, query: '' } })))
    socket.close()
    // The company loses this device's remote tunnel (as after signing in again, a new device):
    // GL Work, still set to 手机远程 here, registers it again by itself.
    store.db.prepare("delete from tunnels where id = ?").run(hosts[0].id)
    const back = await until(v => v.phone?.state === 'on', '手机远程 back', true)
    assert.equal(back.phone.enabled, true)
    const again = (await (await fetch(`${gatewayOrigin}/agent-work/remote/hosts`, { headers: asPhone })).json()).hosts
    assert.equal(again.length, 1)
    assert.notEqual(again[0].id, hosts[0].id, 'a new registration')
    hosts[0] = again[0]
    // Turned off: the Mac drops off the relay.
    await action({ op: 'remote-off' })
    await until(v => v.phone?.state === 'off', '手机远程 off')
    let status = 200
    for (let i = 0; i < 50 && status === 200; i += 1) {
      status = (await fetch(`${gatewayOrigin}/agent-work/remote/${hosts[0].id}/api/session.list`, { method: 'POST', headers: asPhone, body: '{}' })).status
      if (status === 200) await sleep(200)
    }
    assert.equal(status, 503)
  })

  it('takes frpc down with GL Work', async () => {
    const web = (await page()).tunnels.find(x => x.name === 'web')
    tunnels.setClosed(web.id, null)
    await page(true)
    await action({ op: 'start', id: web.id })
    await until(v => v.tunnels.find(x => x.id === web.id)?.state === 'on', 'on again')
    const frpcRunning = () => spawnSync('pgrep', ['-f', join(home, 'agent-work', 'tunnel', 'frpc.toml')]).status === 0
    assert.equal(frpcRunning(), true)
    host.child.kill('SIGTERM')
    for (let i = 0; i < 50 && frpcRunning(); i += 1) await sleep(200)
    assert.equal(frpcRunning(), false, 'frpc exited with the Host')
  })
})
