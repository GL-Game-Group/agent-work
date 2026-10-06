// @ts-check
/**
 * 内网穿透, Host half: the member's tunnels from the company service, and the
 * frpc that runs the ones on this machine.
 *
 * The company service decides what may run (frps asks it about every login,
 * tunnel and heartbeat); here GL Work only starts frpc with what the member
 * turned on, from this device, signed in with its device token. What the
 * member chooses locally lives in $DSH_HOME/agent-work/tunnel/local.json:
 * which tunnels run, web tunnels' passwords (never sent to the company), and
 * the local ports of colleagues' SSH tunnels they connected to.
 *
 * The page (client.js) reaches it at /api/agent-work/tunnel[/action], routes of
 * the Host's client connection: only the signed-in GL Work window may call them.
 *
 * 手机远程 rides the same frpc: turned on, this Mac serves the remote protocol
 * on a loopback port (remote.js) and frpc publishes it under the company's
 * internal name for this device, which only the company service's relay
 * reaches, for the member's own signed-in phone.
 */
import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { TOKEN_ENV, frpcConfig, initialState, readLogLine } from './frpc.js'
import { REMOTE_HEADER, startRemoteServer } from './remote.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('./frpc.js').FrpcState} FrpcState */
/**
 * @typedef {object} Remote - GET /agent-work/tunnels
 * @property {string} member
 * @property {string | null} device
 * @property {{ addr: string, port: number, protocol: 'wss' | 'tcp' } | null} server
 * @property {{ enabled: boolean, allowPublic: boolean, perMember: number, ssh: boolean, publicTcp: boolean, remote?: boolean }} settings
 * @property {{ tunnels: boolean, ssh: boolean }} grants
 * @property {{ name: string, isDefault: boolean }[]} domains
 * @property {RemoteTunnel[]} tunnels
 * @property {{ id: string, owner: string, name: string, online: boolean, secretKey: string }[]} shared
 * @property {{ name: string, displayName: string }[]} colleagues
 */
/**
 * @typedef {object} RemoteTunnel
 * @property {string} id
 * @property {string} device
 * @property {'http' | 'ssh' | 'remote'} type
 * @property {string} name
 * @property {string | null} domain
 * @property {string | null} host
 * @property {number} localPort
 * @property {'public' | 'password'} protection
 * @property {'all' | string[] | null} sshAccess
 * @property {number | null} publicPort
 * @property {string | null} closedBy
 * @property {boolean} online
 * @property {string | null} secretKey
 * @property {string[] | null} allowUsers
 */
/**
 * @typedef {object} Local
 * @property {string[]} running
 * @property {Record<string, { user: string, password: string }>} passwords
 * @property {Record<string, number>} visitors
 * @property {{ enabled: boolean, secret: string }} [remote] - 手机远程 on this Mac, and what frpc proves itself with.
 */
/**
 * @typedef {object} Handle - what ctx.subprocess.spawn returns, as used here.
 * @property {NodeJS.ReadableStream} stdout
 * @property {Promise<unknown>} done
 * @property {() => void} terminate
 * @property {() => Promise<unknown>} waitForExit
 */

export const name = 'agent-work-tunnel'
export const inject = ['deepseekAccount', 'connection', 'subprocess', 'typertGateway', 'sessions']

export const Config = Schema.object({
  /** frpc to run; by default the one shipped in bin/<platform>-<arch>/. */
  frpcPath: Schema.string(),
  /** How often to re-read the tunnels from the company service. */
  refreshMs: Schema.number().min(5_000).max(3_600_000).default(60_000),
})

const ROUTE = '/api/agent-work/tunnel'
/** Shown to the phone as the Mac's version. */
const VERSION = /** @type {{ version: string }} */ (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))).version
const VISITOR_PORTS = 62200
const LOG_LINES = 200

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** A refusal shown to the member as is. */
class Refusal extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 409) { super(message); this.status = status }
}

/** The frpc shipped with this plugin for this platform (scripts/fetch-frpc.mjs puts it there), if present. */
function shippedFrpc() {
  // In the desktop app this module is read from app.asar, while bin/ ships unpacked beside it
  // (patches/0008): an executable inside the archive cannot be started.
  const dir = import.meta.dirname.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  const file = join(dir, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'frpc.exe' : 'frpc')
  return existsSync(file) ? file : undefined
}

/** @param {number} port */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(port, '127.0.0.1', () => { probe.close(() => { resolve(true) }) })
  })
}

/**
 * @param {Context} ctx
 * @param {{ frpcPath?: string, refreshMs: number }} config
 */
export function apply(ctx, config) {
  const account = /** @type {{ companyServer?: () => string, companyToken?: () => Promise<string | undefined> }} */ (/** @type {unknown} */ (ctx.get('deepseekAccount')))
  const subprocess = /** @type {{ spawn: (spec: object) => Handle }} */ (/** @type {unknown} */ (ctx.get('subprocess')))
  const logger = ctx.logger('agent-work-tunnel')
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'agent-work', 'tunnel')
  const frpcPath = config.frpcPath || shippedFrpc()

  /** @type {Local} */
  let local = { running: [], passwords: {}, visitors: {} }
  /** 手机远程's local server while it is on. */
  /** @type {{ port: number, secret: string, close: () => Promise<void> } | null} */
  let remoteServer = null
  /** @type {string | null} */
  let remoteServerError = null
  /** @type {Remote | null} */
  let remote = null
  /** @type {string | null} */
  let remoteError = null
  /** @type {{ handle: Handle, config: string, state: FrpcState, stopping: boolean } | null} */
  let frpc = null
  /** @type {string[]} */
  const log = []
  /** Why frpc could not be started, shown on the page until it starts. */
  /** @type {string | null} */
  let startError = null
  let restartDelay = 2_000
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let restartTimer
  let disposed = false
  /** One change at a time. */
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()
  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  const serial = (task) => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  async function loadLocal() {
    try {
      const value = JSON.parse(await readFile(join(dir, 'local.json'), 'utf8'))
      local = {
        running: Array.isArray(value.running) ? value.running : [], passwords: value.passwords ?? {}, visitors: value.visitors ?? {},
        ...typeof value.remote?.secret === 'string' ? { remote: { enabled: value.remote.enabled === true, secret: value.remote.secret } } : {},
      }
    } catch { /* first run */ }
  }

  async function saveLocal() {
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'local.json')
    await writeFile(`${file}.tmp`, JSON.stringify(local, null, 2), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }

  /** The company service, signed in; undefined when signed out. */
  async function company() {
    const token = await account.companyToken?.()
    const server = account.companyServer?.()
    if (token === undefined || server === undefined) return undefined
    return { server, token }
  }

  /**
   * Call the company service's tunnel API.
   * @param {string} method @param {string} path @param {unknown} [body]
   */
  async function call(method, path, body) {
    const service = await company()
    if (service === undefined) throw new Refusal('请先登录公司账号', 401)
    let response
    try {
      response = await fetch(new URL(path, service.server), {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${service.token}`, ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
    } catch { throw new Refusal('暂时连不上公司服务', 503) }
    if (response.status === 204) return undefined
    const value = /** @type {Record<string, unknown>} */ (await response.json().catch(() => ({})))
    if (!response.ok) throw new Refusal(typeof value.error === 'string' && value.error !== 'unauthenticated' ? value.error : `公司服务返回 ${response.status}`, response.status)
    return value
  }

  /** Re-read the tunnels, then bring frpc in line. */
  async function refresh() {
    try {
      remote = /** @type {Remote} */ (/** @type {unknown} */ (await call('GET', '/agent-work/tunnels')))
      remoteError = null
      // 手机远程 is on here, but this device has no remote tunnel at the company: signed in
      // again (a new device), or deleted there. Register this device (idempotent at the company).
      if (local.remote?.enabled === true && remote.server !== null && remote.settings.enabled && remote.settings.remote !== false && phoneTunnel() === undefined) {
        await call('POST', '/agent-work/tunnels', { type: 'remote' })
        remote = /** @type {Remote} */ (/** @type {unknown} */ (await call('GET', '/agent-work/tunnels')))
        logger.info('registered 手机远程 for this device')
      }
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error)
      if (error instanceof Refusal && error.status === 401) remote = null
    }
    await reconcile()
  }

  /** What frpc should run now, from the company's view and the member's choices. */
  function desired() {
    if (remote === null || remote.server === null || !remote.settings.enabled || frpcPath === undefined) return null
    const mine = remote.tunnels.filter(t => t.type !== 'remote' && t.device === remote?.device && t.closedBy === null && local.running.includes(t.id))
      .filter(t => (t.type === 'http' ? remote?.grants.tunnels : remote?.grants.ssh && remote.settings.ssh))
      .filter(t => t.type === 'ssh' || t.protection === 'public' || local.passwords[t.id] !== undefined)
    const visitors = remote.shared.filter(s => local.visitors[s.id] !== undefined)
      .map(s => ({ id: s.id, owner: s.owner, secretKey: s.secretKey, port: /** @type {number} */ (local.visitors[s.id]) }))
    const phone = phoneTunnel()
    const remoteProxy = phone !== undefined && phone.host !== null && remoteServer !== null && remote.settings.remote !== false && phone.closedBy === null
      ? { id: phone.id, host: phone.host, localPort: remoteServer.port, secret: remoteServer.secret }
      : null
    return frpcConfig({ server: remote.server, member: remote.member, tunnels: /** @type {import('./frpc.js').OwnTunnel[]} */ (mine), passwords: local.passwords, visitors, remote: remoteProxy, remoteHeader: REMOTE_HEADER })
  }

  /** This Mac's 手机远程 tunnel at the company, once turned on. */
  function phoneTunnel() {
    return remote?.tunnels.find(t => t.type === 'remote' && t.device === remote?.device)
  }

  /** Run 手机远程's local server exactly while it should be reachable. */
  async function reconcileRemoteServer() {
    const wanted = !disposed && local.remote?.enabled === true && remote !== null && remote.settings.enabled && remote.settings.remote !== false
      && phoneTunnel() !== undefined && frpcPath !== undefined
    if (wanted && remoteServer !== null && remoteServer.secret === local.remote?.secret) return
    if (remoteServer !== null) {
      const running = remoteServer
      remoteServer = null
      await running.close().catch(() => undefined)
    }
    if (!wanted || local.remote === undefined) return
    try {
      const gateway = /** @type {import('./remote.js').Gateway} */ (/** @type {unknown} */ (ctx.get('typertGateway')))
      const shared = /** @type {{ createSharedFetchHandler: (prefix: string) => { fetch: (request: Request) => Promise<Response> } }} */ (/** @type {unknown} */ (ctx.get('connection'))).createSharedFetchHandler('/api')
      const sessions = /** @type {{ list?: () => unknown[] } | undefined} */ (/** @type {unknown} */ (ctx.get('sessions')))
      const secret = local.remote.secret
      const started = await startRemoteServer({
        gateway, secret, logger,
        sharedFetch: request => shared.fetch(request),
        onSessionEvent: listener => /** @type {any} */ (ctx).on('session/event', listener),
        host: { version: `GL Work ${VERSION}`, attachedSessions: () => sessions?.list?.().length ?? 0 },
      })
      remoteServer = { ...started, secret }
      remoteServerError = null
    } catch (error) {
      remoteServerError = `手机远程启动失败：${error instanceof Error ? error.message : String(error)}`
      logger.warn(remoteServerError)
    }
  }

  async function stop() {
    clearTimeout(restartTimer)
    if (frpc === null) return
    const running = frpc
    frpc = null
    running.stopping = true
    running.handle.terminate()
    await running.handle.waitForExit().catch(() => undefined)
  }

  /** Start, restart or stop frpc so it runs exactly the desired config. */
  async function reconcile() {
    await reconcileRemoteServer()
    const wanted = disposed ? null : desired()
    if (wanted === (frpc?.config ?? null)) return
    await stop()
    if (wanted === null) return
    const service = await company()
    if (service === undefined) return
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'frpc.toml')
    await writeFile(file, wanted, { mode: 0o600 })
    await chmod(file, 0o600)
    /** @type {Handle} */
    let handle
    try {
      handle = subprocess.spawn({
        argv: [/** @type {string} */ (frpcPath), '-c', file], cwd: dir, graceMs: 3_000,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        env: { [TOKEN_ENV]: service.token },
      })
    } catch (error) {
      startError = `frpc 启动失败：${error instanceof Error ? error.message : String(error)}`
      logger.warn('%s (%s)', startError, frpcPath)
      log.push(`[GL Work] ${startError}`)
      return
    }
    startError = null
    const current = { handle, config: wanted, state: initialState(), stopping: false }
    frpc = current
    logger.info('frpc started')
    const lines = createInterface({ input: /** @type {NodeJS.ReadableStream} */ (handle.stdout) })
    lines.on('line', (line) => {
      log.push(line)
      if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES)
      readLogLine(current.state, line)
      if (current.state.connection === 'connected') restartDelay = 2_000
    })
    const stderr = /** @type {NodeJS.ReadableStream | undefined} */ (/** @type {{ stderr?: NodeJS.ReadableStream }} */ (handle).stderr)
    stderr?.on('data', (chunk) => { log.push(String(chunk).trimEnd()) })
    const exited = () => {
      if (current.stopping || frpc !== current) return
      frpc = null
      logger.warn('frpc exited; restarting in %d ms', restartDelay)
      log.push(`[GL Work] frpc 已退出，${Math.round(restartDelay / 1000)} 秒后重启`)
      restartTimer = setTimeout(() => { serial(reconcile).catch(() => { /* logged by reconcile */ }) }, restartDelay)
      restartDelay = Math.min(restartDelay * 2, 60_000)
    }
    handle.done.then(exited, exited)
  }

  /** The page's view. */
  function view() {
    const state = frpc?.state ?? null
    const statusOf = (/** @type {RemoteTunnel} */ t) => {
      if (t.closedBy !== null) return { state: 'closed', message: '管理员已关闭这条隧道' }
      if (remote !== null && t.device !== remote.device) return { state: 'elsewhere', message: '这条隧道属于你的另一台电脑' }
      if (!local.running.includes(t.id)) return { state: 'off', message: null }
      if (t.type === 'http' && t.protection === 'password' && local.passwords[t.id] === undefined) return { state: 'error', message: '在这台电脑上还没有设置访问密码' }
      if (frpc === null && startError !== null) return { state: 'error', message: startError }
      const proxy = state?.proxies[t.id]
      if (proxy?.ok === false) return { state: 'error', message: proxy.message }
      if (state?.connection === 'refused' || state?.connection === 'reconnecting') return { state: 'error', message: state.message }
      return { state: proxy?.ok ? 'on' : 'starting', message: null }
    }
    return {
      signedIn: remote !== null,
      error: remoteError,
      frpc: frpcPath === undefined ? { available: false } : { available: true, running: frpc !== null, connection: state?.connection ?? null, message: state?.message ?? startError },
      ...remote === null ? {} : {
        enabled: remote.server !== null && remote.settings.enabled,
        settings: remote.settings,
        grants: remote.grants,
        domains: remote.domains,
        colleagues: remote.colleagues,
        phone: phoneView(state),
        tunnels: remote.tunnels.filter(t => t.type !== 'remote').map(t => ({
          id: t.id, type: t.type, name: t.name, domain: t.domain, host: t.host, localPort: t.localPort, protection: t.protection,
          sshAccess: t.sshAccess, publicPort: t.publicPort, closedBy: t.closedBy, online: t.online,
          here: t.device === remote?.device, running: local.running.includes(t.id),
          auth: t.protection === 'password' ? local.passwords[t.id] ?? null : null, ...statusOf(t),
        })),
        shared: remote.shared.map(s => ({
          id: s.id, owner: s.owner, name: s.name, online: s.online, port: local.visitors[s.id] ?? null,
          ready: state?.visitors[s.id]?.ok === true, message: state?.visitors[s.id]?.message ?? null,
        })),
      },
    }
  }

  /**
   * 手机远程's card.
   * @param {FrpcState | null} state
   */
  function phoneView(state) {
    const allowed = remote !== null && remote.settings.remote !== false
    const enabled = local.remote?.enabled === true
    const tunnel = phoneTunnel()
    /** @param {string} s @param {string | null} [message] */
    const as = (s, message = null) => ({ allowed, enabled, state: s, message })
    if (!allowed) return as('off', '管理员没有开启手机远程')
    if (!enabled) return as('off')
    if (tunnel === undefined) return as('starting')
    if (tunnel.closedBy !== null) return as('closed', '管理员已关闭这台电脑的手机远程')
    if (remoteServerError !== null) return as('error', remoteServerError)
    if (frpc === null && startError !== null) return as('error', startError)
    const proxy = state?.proxies[tunnel.id]
    if (proxy?.ok === false) return as('error', proxy.message)
    if (state?.connection === 'refused' || state?.connection === 'reconnecting') return as('error', state.message)
    return as(proxy?.ok ? 'on' : 'starting')
  }

  /** @returns {{ user: string, password: string }} */
  const newPassword = () => ({ user: 'guest', password: randomBytes(9).toString('base64url') })

  /** @param {string} id */
  function own(id) {
    const tunnel = remote?.tunnels.find(t => t.id === id)
    if (tunnel === undefined) throw new Refusal('没有这条隧道', 404)
    return tunnel
  }

  /** @param {Record<string, unknown>} body */
  async function act(body) {
    const id = typeof body.id === 'string' ? body.id : ''
    switch (body.op) {
      case 'create': {
        const input = { type: body.type, name: body.name, localPort: body.localPort, domain: body.domain, protection: body.protection, sshAccess: body.sshAccess, publicPort: body.publicPort === true }
        const created = /** @type {{ id: string, type: string, protection: string }} */ (await call('POST', '/agent-work/tunnels', input))
        if (created.type === 'http' && created.protection === 'password') local.passwords[created.id] = newPassword()
        local.running.push(created.id)
        await saveLocal()
        return { created: created.id }
      }
      case 'update': {
        own(id)
        const input = Object.fromEntries(['localPort', 'protection', 'sshAccess'].filter(k => body[k] !== undefined).map(k => [k, body[k]]))
        await call('PATCH', `/agent-work/tunnels/${encodeURIComponent(id)}`, input)
        // Turned to "password": one for this machine, unless it kept one from before.
        if (body.protection === 'password' && local.passwords[id] === undefined) {
          local.passwords[id] = newPassword()
          await saveLocal()
        }
        return {}
      }
      case 'delete': {
        own(id)
        await call('DELETE', `/agent-work/tunnels/${encodeURIComponent(id)}`)
        local.running = local.running.filter(x => x !== id)
        delete local.passwords[id]
        await saveLocal()
        return {}
      }
      case 'start': case 'stop': {
        const tunnel = own(id)
        if (body.op === 'start' && remote !== null && tunnel.device !== remote.device) throw new Refusal('这条隧道属于你的另一台电脑，只能在那台电脑上打开')
        local.running = local.running.filter(x => x !== id)
        if (body.op === 'start') {
          local.running.push(id)
          if (tunnel.type === 'http' && tunnel.protection === 'password' && local.passwords[id] === undefined) local.passwords[id] = newPassword()
        }
        await saveLocal()
        return {}
      }
      case 'password': {
        const tunnel = own(id)
        if (tunnel.type !== 'http') throw new Refusal('只有网页隧道有访问密码')
        const user = typeof body.user === 'string' ? body.user.trim() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        if (!/^[A-Za-z0-9._-]{1,32}$/u.test(user)) throw new Refusal('用户名只能用字母、数字和 . _ -（最长 32 个字符）', 400)
        if (password.length < 6 || password.length > 64) throw new Refusal('密码要 6 到 64 个字符', 400)
        local.passwords[id] = { user, password }
        await saveLocal()
        return {}
      }
      case 'connect': {
        const shared = remote?.shared.find(s => s.id === id)
        if (shared === undefined) throw new Refusal('同事没有把这条隧道分享给你', 404)
        if (local.visitors[id] === undefined) {
          const taken = new Set(Object.values(local.visitors))
          let port = VISITOR_PORTS
          while (taken.has(port) || !(await portFree(port))) port += 1
          local.visitors[id] = port
          await saveLocal()
        }
        return { port: local.visitors[id] }
      }
      case 'remote-on': {
        if (remote !== null && remote.settings.remote === false) throw new Refusal('管理员没有开启手机远程')
        await call('POST', '/agent-work/tunnels', { type: 'remote' })
        local.remote = { enabled: true, secret: local.remote?.secret ?? randomBytes(24).toString('base64url') }
        await saveLocal()
        return {}
      }
      case 'remote-off': {
        if (local.remote !== undefined) local.remote.enabled = false
        await saveLocal()
        return {}
      }
      case 'disconnect': {
        delete local.visitors[id]
        await saveLocal()
        return {}
      }
      default: throw new Refusal('不认识的操作', 400)
    }
  }

  const connection = /** @type {{ fetch: { register: (route: { path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }) => () => Promise<void> } }} */ (/** @type {unknown} */ (ctx.get('connection')))
  /** @param {() => Promise<Response>} handler */
  const guard = handler => handler().catch((error) => {
    if (error instanceof Refusal) return json({ error: error.message }, error.status)
    logger.warn('tunnel request failed: %s', error instanceof Error ? error.message : String(error))
    return json({ error: '操作失败，请稍后重试' }, 500)
  })
  ctx.effect(() => connection.fetch.register({
    path: ROUTE, methods: ['GET'], requestBody: 'buffered',
    fetch: request => guard(async () => {
      if (new URL(request.url).searchParams.has('refresh')) await serial(refresh)
      return json(view())
    }),
  }), 'agent-work tunnel route')
  ctx.effect(() => connection.fetch.register({
    path: `${ROUTE}/action`, methods: ['POST'], requestBody: 'buffered',
    fetch: request => guard(async () => {
      /** @type {Record<string, unknown>} */
      let body
      try { body = /** @type {Record<string, unknown>} */ (await request.json()) } catch { return json({ error: '请求格式不正确' }, 400) }
      if (body.op === 'log') return json({ log })
      const result = await serial(async () => {
        if (remote === null) await refresh()
        const value = await act(body)
        await refresh()
        return value
      })
      return json({ ...result, ...view() })
    }),
  }), 'agent-work tunnel action route')

  ctx.effect(() => {
    const background = (/** @type {() => Promise<void>} */ task) => serial(task).catch((error) => {
      logger.warn('tunnel refresh failed: %s', error instanceof Error ? error.message : String(error))
    })
    void background(async () => { await loadLocal(); await refresh() })
    const timer = setInterval(() => { void background(refresh) }, config.refreshMs)
    return async () => {
      disposed = true
      clearInterval(timer)
      await serial(async () => { await stop(); await reconcileRemoteServer() })
    }
  }, 'agent-work tunnel frpc')

  if (frpcPath !== undefined && !existsSync(frpcPath)) logger.warn('frpc not found at %s', frpcPath)
}
