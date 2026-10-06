// @ts-check
/**
 * frpc's side of a member's tunnels: the config GL Work runs frpc with, and
 * what frpc's log says about each tunnel. No Host services here, so it is
 * tested on its own (test/frpc.test.mjs).
 *
 * The device token never lands in the file: frpc renders its config as a
 * template, and reads it from the environment GL Work starts frpc with.
 */

/** The environment variable frpc reads the device token from. */
export const TOKEN_ENV = 'AGENT_WORK_DEVICE_TOKEN'

/**
 * @typedef {object} Server
 * @property {string} addr
 * @property {number} port
 * @property {'wss' | 'tcp'} protocol
 */
/**
 * @typedef {object} OwnTunnel
 * @property {string} id
 * @property {'http' | 'ssh'} type
 * @property {string | null} host
 * @property {number} localPort
 * @property {'public' | 'password'} protection
 * @property {string | null} secretKey
 * @property {string[] | null} allowUsers
 * @property {number | null} publicPort
 */
/**
 * @typedef {object} Visitor
 * @property {string} id - the shared tunnel.
 * @property {string} owner
 * @property {string} secretKey
 * @property {number} port - where it listens on this machine.
 */

/**
 * @typedef {object} RemoteProxy - 手机远程: this Mac's remote protocol server (remote.js).
 * @property {string} id - the company's `remote` tunnel.
 * @property {string} host - its internal name, which frps routes the relay's requests on.
 * @property {number} localPort
 * @property {string} secret - sent to the local server on every forwarded request.
 */

/** A TOML basic string (JSON's escapes are TOML's, for what JSON.stringify emits). */
const str = (/** @type {string} */ value) => JSON.stringify(value)
const list = (/** @type {string[]} */ values) => `[${values.map(str).join(', ')}]`

/**
 * frpc's config for the tunnels to run here.
 * @param {object} input
 * @param {Server} input.server
 * @param {string} input.member - frp's user: frps checks it is the token's member.
 * @param {OwnTunnel[]} input.tunnels - this device's tunnels the member turned on.
 * @param {Record<string, { user: string, password: string }>} input.passwords - web tunnels' Basic Auth, by tunnel id.
 * @param {Visitor[]} input.visitors - colleagues' SSH tunnels the member connected to.
 * @param {RemoteProxy | null} [input.remote] - 手机远程, when turned on here.
 * @param {string} [input.remoteHeader] - the header carrying its secret.
 * @returns {string | null} the config, or null when nothing should run.
 */
export function frpcConfig({ server, member, tunnels, passwords, visitors, remote = null, remoteHeader = 'x-agent-work-remote' }) {
  if (tunnels.length === 0 && visitors.length === 0 && remote === null) return null
  const lines = [
    `serverAddr = ${str(server.addr)}`,
    `serverPort = ${server.port}`,
    `user = ${str(member)}`,
    // Keep retrying: the network comes and goes, and the company service may refuse for a while.
    'loginFailExit = false',
    `metadatas.token = "{{ .Envs.${TOKEN_ENV} }}"`,
    `transport.protocol = ${str(server.protocol === 'wss' ? 'wss' : 'tcp')}`,
    // frps calls the company service's Ping on each heartbeat: that is how closed tunnels stop
    // and how the console knows they run. With tcpMux frpc sends none unless told to.
    'transport.heartbeatInterval = 30',
    'transport.heartbeatTimeout = 90',
    'log.to = "console"',
    'log.level = "info"',
    'log.disablePrintColor = true',
  ]
  for (const t of tunnels) {
    lines.push('', '[[proxies]]', `name = ${str(t.id)}`)
    if (t.type === 'http') {
      if (t.host === null) throw new Error(`tunnel ${t.id} has no address`)
      // localhost, not 127.0.0.1: dev servers (Vite on recent Node) often listen on ::1 only;
      // frpc tries every address localhost resolves to.
      lines.push('type = "http"', 'localIP = "localhost"', `localPort = ${t.localPort}`, `customDomains = ${list([t.host])}`)
      // A password kept on this machine applies only while the tunnel asks for one.
      const auth = t.protection === 'password' ? passwords[t.id] : undefined
      if (auth !== undefined) lines.push(`httpUser = ${str(auth.user)}`, `httpPassword = ${str(auth.password)}`)
      else if (t.protection === 'password') throw new Error(`tunnel ${t.id} needs a password`)
    } else {
      if (t.secretKey === null) throw new Error(`tunnel ${t.id} has no key`)
      lines.push('type = "stcp"', 'localIP = "127.0.0.1"', `localPort = ${t.localPort}`, `secretKey = ${str(t.secretKey)}`, `allowUsers = ${list(t.allowUsers ?? [])}`)
      if (t.publicPort !== null) {
        lines.push('', '[[proxies]]', `name = ${str(`${t.id}-public`)}`, 'type = "tcp"', 'localIP = "127.0.0.1"', `localPort = ${t.localPort}`, `remotePort = ${t.publicPort}`)
      }
    }
  }
  if (remote !== null) {
    // No Basic Auth: only the company service reaches this name, for a phone signed in as the member.
    lines.push('', '[[proxies]]', `name = ${str(remote.id)}`, 'type = "http"', 'localIP = "127.0.0.1"', `localPort = ${remote.localPort}`,
      `customDomains = ${list([remote.host])}`, `requestHeaders.set.${remoteHeader} = ${str(remote.secret)}`)
  }
  for (const v of visitors) {
    lines.push('', '[[visitors]]', `name = ${str(`visit-${v.id}`)}`, 'type = "stcp"', `serverUser = ${str(v.owner)}`, `serverName = ${str(v.id)}`,
      `secretKey = ${str(v.secretKey)}`, 'bindAddr = "127.0.0.1"', `bindPort = ${v.port}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * @typedef {object} FrpcState
 * @property {'starting' | 'connected' | 'reconnecting' | 'refused'} connection
 * @property {string | null} message - why it is not connected, as frps or the company service said.
 * @property {Record<string, { ok: boolean, message: string | null }>} proxies - by tunnel id (`-public` folded in).
 * @property {Record<string, { ok: boolean, message: string | null }>} visitors - by shared tunnel id.
 */

/** @returns {FrpcState} */
export function initialState() {
  return { connection: 'starting', message: null, proxies: {}, visitors: {} }
}

/**
 * Fold one frpc log line into the state.
 * @param {FrpcState} state
 * @param {string} line
 */
export function readLogLine(state, line) {
  // frpc names proxies `<user>.<name>` in its log.
  const proxy = (/** @type {string} */ name) => name.replace(/^[^.\]]+\./u, '').replace(/-public$/u, '')
  let m
  if (/login to server success/u.test(line)) {
    state.connection = 'connected'
    state.message = null
  } else if ((m = /login to the server failed: (.*)$/u.exec(line))) {
    state.connection = 'refused'
    state.message = m[1]?.trim() ?? null
    state.proxies = {}
  } else if ((m = /(?:connect to server error|try to reconnect|control writer is closing|work connection closed|reconnect to server)[^:]*:?\s*(.*)$/u.exec(line))) {
    if (state.connection === 'connected') state.proxies = {}
    state.connection = 'reconnecting'
    state.message = m[1]?.trim() || null
  } else if ((m = /\[([^\]]+)\] start proxy success/u.exec(line))) {
    state.proxies[proxy(m[1] ?? '')] = { ok: true, message: null }
  } else if ((m = /\[([^\]]+)\] start error: (.*)$/u.exec(line))) {
    state.proxies[proxy(m[1] ?? '')] = { ok: false, message: m[2]?.trim() ?? null }
  } else if ((m = /visitor added: \[visit-([^\]]+)\]/u.exec(line))) {
    state.visitors[m[1] ?? ''] = { ok: true, message: null }
  } else if ((m = /\[visit-([^\]]+)\] \w+ error: (.*)$/u.exec(line))) {
    // Still listening here; the colleague's side is not there (offline, or the tunnel was closed).
    state.visitors[m[1] ?? ''] = { ok: true, message: m[2]?.trim() ?? null }
  }
  return state
}
