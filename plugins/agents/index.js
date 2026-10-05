// @ts-check
/**
 * 命令行 Agent, Host half: Claude Code, Codex and Qoder CLI on the member's
 * machine — whether each is installed and signed in, installing one when the
 * member clicks 安装, and starting its own sign-in.
 *
 * Installing runs the vendor's official installer (Claude Code, Qoder CLI) or
 * puts the pinned official Codex binary, checked against its sha256, in
 * ~/.local/bin; nothing edits the member's shell configuration. Sign-in is the
 * CLI's own flow in the member's browser: GL Work never reads or keeps the
 * member's subscription credentials. The company service's assigned accounts
 * (names only) are shown so members know which account to sign in with.
 *
 * The page (client.js, on Settings → Models) calls /api/agent-work/agents/*,
 * routes of the Host's client connection.
 */
import Schema from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIS, SCRIPTS, parseSignedIn, parseVersion, signInUrl } from './cli.js'
import { CliAdapter, PROVIDERS } from './adapter.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('./cli.js').CliSpec} CliSpec */
/**
 * @typedef {object} Handle
 * @property {NodeJS.ReadableStream | undefined} [stdout]
 * @property {NodeJS.ReadableStream | undefined} [stderr]
 * @property {Promise<{ exitCode: number | null }>} done
 * @property {{ stdout?: { readFrom(offset: number): { text: string } }, stderr?: { readFrom(offset: number): { text: string } } }} collected
 * @property {() => void} terminate
 */
/**
 * @typedef {object} Subprocess
 * @property {(spec: object) => Handle} spawn
 * @property {(command: string) => Promise<string>} resolveExecutable
 */

export const name = 'agent-work-agents'
export const inject = ['connection', 'subprocess', 'llm', 'workspaceRegistry']

export const Config = Schema.object({
  /** Executables to use instead of detection (development, tests): `{ claude: '/path/to/claude' }`. */
  paths: Schema.dict(Schema.string()).default({}),
})

const ROUTE = '/api/agent-work/agents'
const RELEASE = JSON.parse(await readFile(new URL('./cli-release.json', import.meta.url), 'utf8'))

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

class Refusal extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 409) { super(message); this.status = status }
}

/**
 * @param {Context} ctx
 * @param {{ paths: Record<string, string> }} config
 */
export function apply(ctx, config) {
  const subprocess = /** @type {Subprocess} */ (/** @type {unknown} */ (ctx.get('subprocess')))
  const logger = ctx.logger('agent-work-agents')
  const home = homedir()
  const target = `${process.platform}-${process.arch}`
  const localBin = join(home, '.local', 'bin')
  /** @type {Map<string, { id: string, cli: string, state: 'running' | 'done' | 'failed', log: string, error: string | null }>} */
  const jobs = new Map()
  /** @type {Map<string, { state: 'waiting' | 'done' | 'failed', url: string | null, output: string, handle: Handle }>} */
  const logins = new Map()

  /**
   * @param {string} executable @param {readonly string[]} args
   * @param {{ cwd?: string, timeoutMs?: number }} [options]
   */
  async function run(executable, args, options = {}) {
    const handle = subprocess.spawn({
      argv: [executable, ...args], cwd: options.cwd ?? home, graceMs: 2_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      env: { NO_COLOR: '1', CI: '1' },
    })
    const { exitCode } = await handle.done
    return { exitCode, stdout: handle.collected.stdout?.readFrom(0).text ?? '', stderr: handle.collected.stderr?.readFrom(0).text ?? '' }
  }

  /** Where a CLI is: configured, on PATH, or where its official installer puts it. @param {CliSpec} cli */
  async function locate(cli) {
    if (config.paths[cli.id]) return existsSync(config.paths[cli.id]) ? config.paths[cli.id] : undefined
    try { return await subprocess.resolveExecutable(cli.command) } catch { /* not on PATH */ }
    return cli.candidates(home, process.platform).find(path => existsSync(path))
  }

  /** The company's assigned subscription accounts (names only), when signed in to the company. */
  async function assigned() {
    const account = /** @type {{ companyServer?: () => string, companyToken?: () => Promise<string | undefined> } | undefined} */ (/** @type {unknown} */ (ctx.get('deepseekAccount')))
    const token = await account?.companyToken?.().catch(() => undefined)
    const server = account?.companyServer?.()
    if (token === undefined || server === undefined) return []
    try {
      const response = await fetch(new URL('/agent-work/config', server), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return []
      const body = /** @type {{ accounts?: { vendor: string, name: string, account: string }[] }} */ (await response.json())
      return body.accounts ?? []
    } catch { return [] }
  }

  /** Every CLI's state. */
  async function list() {
    const accounts = await assigned()
    const rows = await Promise.all(CLIS.map(async (cli) => {
      const path = await locate(cli)
      const version = path === undefined ? null : parseVersion((await run(path, ['--version']).catch(() => ({ stdout: '' }))).stdout)
      const signedIn = path === undefined || cli.status === null ? null
        : await run(path, cli.status).then(r => parseSignedIn(cli.id, r), () => null)
      const login = logins.get(cli.id)
      const job = [...jobs.values()].reverse().find(j => j.cli === cli.id)
      return {
        id: cli.id, name: cli.name, command: cli.command, path: path ?? null, version, signedIn,
        installable: cli.install === 'release' ? RELEASE.codex.targets[target] !== undefined
          : process.platform === 'win32' ? SCRIPTS[/** @type {'claude' | 'qoder'} */ (cli.id)].windows !== null : true,
        install: job === undefined ? null : { id: job.id, state: job.state, error: job.error },
        signIn: login === undefined ? null : { state: login.state, url: login.url },
        accounts: accounts.filter(a => a.vendor === cli.id).map(a => a.account),
      }
    }))
    return { clis: rows, localBin }
  }

  /** @param {string} url */
  async function download(url) {
    let response
    try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) }) } catch { throw new Refusal(`下载失败：连不上 ${new URL(url).host}`) }
    if (!response.ok) throw new Refusal(`下载失败（${response.status}）`)
    return Buffer.from(await response.arrayBuffer())
  }

  /** Install one CLI; the job's log is what the installer printed. @param {CliSpec} cli */
  function install(cli) {
    const running = [...jobs.values()].find(j => j.state === 'running')
    if (running !== undefined) throw new Refusal('正在安装另一个命令行，请稍候')
    const job = { id: randomUUID(), cli: cli.id, state: /** @type {'running' | 'done' | 'failed'} */ ('running'), log: '', error: /** @type {string | null} */ (null) }
    jobs.set(job.id, job)
    void (async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'aw-cli-'))
      try {
        if (cli.install === 'release') {
          const entry = RELEASE.codex.targets[target]
          if (entry === undefined) throw new Refusal('这个系统没有可用的安装包')
          const url = RELEASE.codex.url.replace('{version}', RELEASE.codex.version).replace('{asset}', entry.asset)
          job.log = `下载 ${url}\n`
          const archive = await download(url)
          if (createHash('sha256').update(archive).digest('hex') !== entry.sha256) throw new Refusal('下载的安装包和登记的 sha256 不一致，已停止安装')
          const file = join(scratch, entry.asset)
          await writeFile(file, archive)
          const unpacked = await run('tar', ['-xf', file, '-C', scratch], { cwd: scratch, timeoutMs: 120_000 })
          if (unpacked.exitCode !== 0) throw new Refusal(`解压失败：${unpacked.stderr.trim()}`)
          await mkdir(localBin, { recursive: true })
          const dest = join(localBin, process.platform === 'win32' ? 'codex.exe' : 'codex')
          await copyFile(join(scratch, entry.binary), dest)
          await chmod(dest, 0o755)
          job.log += `已安装到 ${dest}\n`
        } else {
          const script = SCRIPTS[/** @type {'claude' | 'qoder'} */ (cli.id)]
          const windows = process.platform === 'win32'
          const url = windows ? script.windows : script.posix
          if (url === null) throw new Refusal('这个系统暂时不支持一键安装')
          job.log = `运行官方安装脚本 ${url}\n`
          const file = join(scratch, windows ? 'install.ps1' : 'install.sh')
          await writeFile(file, await download(url))
          const argv = windows ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...script.args] : ['bash', file, ...script.args]
          const handle = subprocess.spawn({
            argv, cwd: home, graceMs: 3_000, signal: AbortSignal.timeout(900_000),
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
            // The installers place the CLI under HOME: the same home this plugin looks in.
            env: { NO_COLOR: '1', CI: '1', HOME: home, USERPROFILE: home },
          })
          const append = (/** @type {Buffer} */ chunk) => { job.log = (job.log + String(chunk)).slice(-20_000) }
          handle.stdout?.on('data', append)
          handle.stderr?.on('data', append)
          const { exitCode } = await handle.done
          if (exitCode !== 0) throw new Refusal(`安装脚本失败（退出码 ${String(exitCode)}）：${job.log.trim().split('\n').slice(-2).join(' ')}`)
        }
        if ((await locate(cli)) === undefined) throw new Refusal('安装完成，但没有找到程序，请查看安装日志')
        job.state = 'done'
        logger.info('installed %s', cli.id)
      } catch (error) {
        job.state = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        logger.warn('installing %s failed: %s', cli.id, job.error)
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })()
    return job
  }

  /** Start the CLI's own sign-in; the page shows the address it prints. @param {CliSpec} cli */
  async function startLogin(cli) {
    const path = await locate(cli)
    if (path === undefined) throw new Refusal(`还没有安装 ${cli.name}`)
    const current = logins.get(cli.id)
    if (current?.state === 'waiting') return
    const handle = subprocess.spawn({
      argv: [path, ...cli.login], cwd: home, graceMs: 2_000, signal: AbortSignal.timeout(900_000),
      stdio: { stdin: { data: '\n' }, stdout: 'pipe', stderr: 'pipe' },
      env: { NO_COLOR: '1', HOME: home, USERPROFILE: home },
    })
    const login = { state: /** @type {'waiting' | 'done' | 'failed'} */ ('waiting'), url: /** @type {string | null} */ (null), output: '', handle }
    logins.set(cli.id, login)
    const read = (/** @type {Buffer} */ chunk) => {
      login.output = (login.output + String(chunk)).slice(-10_000)
      login.url ??= signInUrl(login.output)
    }
    handle.stdout?.on('data', read)
    handle.stderr?.on('data', read)
    void handle.done.then(({ exitCode }) => { if (logins.get(cli.id) === login) login.state = exitCode === 0 ? 'done' : 'failed' })
    for (let i = 0; i < 50 && login.url === null && login.state === 'waiting'; i += 1) await new Promise(done => setTimeout(done, 100))
  }

  /** @param {unknown} id */
  function cliOf(id) {
    const cli = CLIS.find(c => c.id === id)
    if (cli === undefined) throw new Refusal('不认识的命令行', 400)
    return cli
  }

  const connection = /** @type {{ fetch: { register: (route: { path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }) => () => Promise<void> } }} */ (/** @type {unknown} */ (ctx.get('connection')))
  /** @param {() => Promise<unknown>} handler */
  const guard = handler => handler().then(value => json(value ?? {}), (error) => {
    if (error instanceof Refusal) return json({ error: error.message }, error.status)
    logger.warn('agents request failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
    return json({ error: '操作失败，请稍后重试' }, 500)
  })
  /** @param {Request} request @returns {Promise<Record<string, unknown>>} */
  const body = async (request) => {
    try { return /** @type {Record<string, unknown>} */ (await request.json()) } catch { throw new Refusal('请求格式不正确', 400) }
  }
  /** @type {Record<string, (request: Request, url: URL) => Promise<unknown>>} */
  const handlers = {
    'GET clis': () => list(),
    'POST install': async (request) => {
      const job = install(cliOf((await body(request)).id))
      return { id: job.id, state: job.state }
    },
    'GET install/status': async (_request, url) => {
      const job = jobs.get(url.searchParams.get('id') ?? '')
      if (job === undefined) throw new Refusal('没有这个安装任务', 404)
      return job
    },
    'POST login': async (request) => {
      const cli = cliOf((await body(request)).id)
      await startLogin(cli)
      const login = logins.get(cli.id)
      return { state: login?.state ?? 'failed', url: login?.url ?? null, output: login?.output.slice(-2000) ?? '' }
    },
    'POST login/cancel': async (request) => {
      const cli = cliOf((await body(request)).id)
      logins.get(cli.id)?.handle.terminate()
      logins.delete(cli.id)
      return {}
    },
  }
  for (const [key, handler] of Object.entries(handlers)) {
    const [method, path] = key.split(' ')
    ctx.effect(() => connection.fetch.register({
      path: `${ROUTE}/${path}`, methods: [/** @type {string} */ (method)], requestBody: 'buffered',
      fetch: request => guard(() => handler(request, new URL(request.url))),
    }), `agent-work agents ${key}`)
  }
  ctx.effect(() => () => { for (const login of logins.values()) login.handle.terminate() }, 'agent-work agents lifetime')

  // 直连模式: the CLIs as models.
  const registry = /** @type {{ list(): { path: string, sessionIds: readonly string[] }[] }} */ (/** @type {unknown} */ (ctx.get('workspaceRegistry')))
  const llm = /** @type {{ registerAdapter(providers: string[], adapter: unknown): () => void }} */ (/** @type {unknown} */ (ctx.get('llm')))
  const sessionsFile = join(process.env.DSH_HOME || join(home, '.dsh'), 'agent-work', 'cli-sessions.json')
  /** @type {Record<string, string>} */
  let sessions = {}
  void readFile(sessionsFile, 'utf8').then((text) => { sessions = { ...JSON.parse(text), ...sessions } }, () => {})
  let saving = Promise.resolve()
  const adapter = new CliAdapter({
    spawn: ({ argv, cwd }) => subprocess.spawn({
      argv, cwd, graceMs: 3_000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      env: { HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    }),
    locate: id => locate(cliOf(id)),
    cwdOf: sessionId => registry.list().find(w => w.sessionIds.includes(sessionId))?.path ?? home,
    sessions: {
      get: sessionId => sessions[sessionId],
      set: (sessionId, cliSession) => {
        if (sessions[sessionId] === cliSession) return
        sessions[sessionId] = cliSession
        saving = saving.then(async () => {
          await mkdir(join(sessionsFile, '..'), { recursive: true })
          await writeFile(sessionsFile, JSON.stringify(sessions, null, 2))
        }).catch(error => logger.warn('could not save CLI sessions: %s', String(error)))
      },
    },
    logger,
  })
  ctx.effect(() => llm.registerAdapter(Object.keys(PROVIDERS), adapter), 'agent-work: command-line agents as models')
  // Slash commands of 直连 sessions; they never become model messages.
  ctx.inject(['commands'], (scope) => {
    const commands = /** @type {{ register(command: { name: string, description: string, input?: { hint: string }, handler: (invocation: { agent: { sessionId: string }, rawInput: string }) => Promise<{ kind: 'success' | 'error', text: string }> }): () => void }} */ (/** @type {unknown} */ (scope.get('commands')))
    /** @param {() => Promise<string>} run */
    const answer = run => run().then(text => ({ kind: /** @type {const} */ ('success'), text }), error => ({ kind: /** @type {const} */ ('error'), text: error instanceof Error ? error.message : String(error) }))
    scope.effect(() => commands.register({
      name: 'clear', description: '直连模式：开一个新的命令行会话（之前的上下文不再带入）',
      handler: ({ agent }) => answer(async () => { adapter.reset(agent.sessionId); return '已开启新的命令行会话，下一条消息从头开始。' }),
    }), 'agent-work: /clear')
    scope.effect(() => commands.register({
      name: 'compact', description: '直连模式：让命令行压缩它自己的上下文',
      handler: ({ agent }) => answer(() => adapter.raw(agent.sessionId, '/compact')),
    }), 'agent-work: /compact')
    scope.effect(() => commands.register({
      name: 'cli', description: '直连模式：把内容原样交给命令行（可用来调用命令行自带的命令）', input: { hint: '<内容>' },
      handler: ({ agent, rawInput }) => answer(async () => {
        if (rawInput.trim() === '') throw new Error('用法：/cli <内容>')
        return adapter.raw(agent.sessionId, rawInput.trim())
      }),
    }), 'agent-work: /cli')
  })
  ctx.effect(() => {
    const timer = setInterval(() => { adapter.sweep(30 * 60_000) }, 60_000)
    return () => { clearInterval(timer); adapter.dispose() }
  }, 'agent-work: command-line agent processes')
}
