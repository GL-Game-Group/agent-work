/**
 * frpc's config and log reading. With AGENT_WORK_FRP_DIR (a directory holding
 * frpc), the generated config is also checked by `frpc verify`.
 *
 * Usage: [AGENT_WORK_FRP_DIR=<frp release dir>] node --test plugins/tunnel/test/frpc.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { TOKEN_ENV, frpcConfig, initialState, readLogLine } from '../frpc.js'

const server = { addr: 'frp.example.com', port: 443, protocol: /** @type {const} */ ('wss') }
const web = { id: 'tun_web', type: /** @type {const} */ ('http'), host: 'web-alice.t.example.net', localPort: 5173, protection: /** @type {const} */ ('password'), secretKey: null, allowUsers: null, publicPort: null }
const ssh = { id: 'tun_ssh', type: /** @type {const} */ ('ssh'), host: null, localPort: 22, protection: /** @type {const} */ ('password'), secretKey: 'k"ey\\1', allowUsers: ['bob'], publicPort: 20000 }

describe('frpc config', () => {
  it('runs nothing without tunnels or visitors', () => {
    assert.equal(frpcConfig({ server, member: 'alice', tunnels: [], passwords: {}, visitors: [] }), null)
  })

  it('logs in as the member with the token from the environment, never in the file', () => {
    const config = frpcConfig({ server, member: 'alice', tunnels: [web], passwords: { tun_web: { user: 'guest', password: 'p"w' } }, visitors: [] }) ?? ''
    assert.match(config, /^user = "alice"$/mu)
    assert.match(config, new RegExp(`metadatas.token = "\\{\\{ .Envs.${TOKEN_ENV} \\}\\}"`, 'u'))
    assert.match(config, /transport.protocol = "wss"/u)
    assert.match(config, /transport.heartbeatInterval = 30/u, 'frps calls Ping only on heartbeats')
    assert.match(config, /customDomains = \["web-alice.t.example.net"\]/u)
    assert.match(config, /httpPassword = "p\\"w"/u)
  })

  it('refuses a passworded web tunnel without its password', () => {
    assert.throws(() => frpcConfig({ server, member: 'alice', tunnels: [web], passwords: {}, visitors: [] }), /needs a password/u)
  })

  it('writes SSH tunnels as STCP with their access list, plus the public port, and visitors', () => {
    const config = frpcConfig({ server, member: 'alice', tunnels: [ssh], passwords: {}, visitors: [{ id: 'tun_box', owner: 'bob', secretKey: 'sk', port: 62200 }] }) ?? ''
    assert.match(config, /type = "stcp"\nlocalIP = "127.0.0.1"\nlocalPort = 22\nsecretKey = "k\\"ey\\\\1"\nallowUsers = \["bob"\]/u)
    assert.match(config, /name = "tun_ssh-public"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 22\nremotePort = 20000/u)
    assert.match(config, /\[\[visitors\]\]\nname = "visit-tun_box"\ntype = "stcp"\nserverUser = "bob"\nserverName = "tun_box"/u)
  })

  it('is a config frpc accepts', { skip: process.env.AGENT_WORK_FRP_DIR === undefined ? 'set AGENT_WORK_FRP_DIR' : false }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-frpc-'))
    const file = join(dir, 'frpc.toml')
    writeFileSync(file, frpcConfig({ server, member: 'alice', tunnels: [web, ssh], passwords: { tun_web: { user: 'guest', password: 'pw' } }, visitors: [{ id: 'tun_box', owner: 'bob', secretKey: 'sk', port: 62200 }],
      remote: { id: 'tun_r', host: 'rabc.remote.internal', localPort: 50123, secret: 's3cret' } }) ?? '')
    const out = execFileSync(join(process.env.AGENT_WORK_FRP_DIR ?? '', 'frpc'), ['verify', '-c', file], { env: { ...process.env, [TOKEN_ENV]: 'awd_x' } }).toString()
    assert.match(out, /syntax is ok/u)
  })
})

describe('frpc log', () => {
  // Lines as frpc 0.71 prints them.
  const lines = [
    '2026-10-04 01:09:24.414 [I] [client/service.go:312] try to connect to server...',
    '2026-10-04 01:09:24.439 [I] [client/service.go:332] [643a31968ae943ed] login to server success, get run id [643a31968ae943ed]',
    '2026-10-04 01:09:24.444 [I] [client/control.go:174] [643a31968ae943ed] [alice.tun_web] start proxy success',
    '2026-10-04 01:09:24.445 [W] [client/control.go:172] [643a31968ae943ed] [alice.tun_ssh] start error: 这条隧道属于你的另一台电脑',
    '2026-10-04 06:00:27.135 [I] [visitor/visitor_manager.go:135] [90904cbfd528f8a2] start visitor success',
    '2026-10-04 06:00:27.135 [I] [visitor/visitor_manager.go:186] [90904cbfd528f8a2] visitor added: [visit-tun_box]',
  ]

  it('tracks the connection, each tunnel and each visitor', () => {
    const state = initialState()
    for (const line of lines) readLogLine(state, line)
    assert.equal(state.connection, 'connected')
    assert.deepEqual(state.proxies, { tun_web: { ok: true, message: null }, tun_ssh: { ok: false, message: '这条隧道属于你的另一台电脑' } })
    assert.deepEqual(state.visitors, { tun_box: { ok: true, message: null } })
  })

  it('keeps a visitor listening when the colleague\'s side is missing, with why', () => {
    const state = readLogLine(initialState(), '2026-10-04 06:00:29.133 [W] [visitor/stcp.go:70] [90904cbfd528f8a2] [visit-tun_box] dialRawVisitorConn error: start new visitor connection error: custom listener for [bob.tun_box] doesn\'t exist')
    assert.equal(state.visitors.tun_box?.ok, true)
    assert.match(state.visitors.tun_box?.message ?? '', /doesn't exist/u)
  })

  it('shows why the company service refused the login', () => {
    const state = readLogLine(initialState(), '2026-10-04 01:09:24.439 [W] [client/service.go:335] login to the server failed: GL Work 的登录已失效. With loginFailExit enabled, no additional retries will be attempted')
    assert.equal(state.connection, 'refused')
    assert.match(state.message ?? '', /GL Work 的登录已失效/u)
  })
})
