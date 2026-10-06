// @ts-check
/**
 * 工作区管理, Host half: workspaces from a local folder or a GitHub repository
 * of the company organization, worktrees ("复制为工作区"), and the GitHub CLI
 * they rely on.
 *
 * Every git and gh command runs through ctx.subprocess on the member's own
 * machine with the member's own GitHub sign-in (gh keeps it in the system
 * keychain); the company service never sees a GitHub token. gh is installed
 * only when the member clicks 安装 (the pinned release in gh-release.json,
 * checked against its sha256, unpacked under $DSH_HOME/agent-work/tools), and
 * git's global configuration changes only through 让 git 使用 GitHub 登录.
 *
 * The client half (client.js) calls /api/agent-work/workspace/*, routes of the
 * Host's client connection: only the signed-in GL Work window reaches them.
 */
import Schema from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { NAME, SEARCH_DEPTH, SEARCH_ROOTS, branchFor, cloneProgress, deviceCode, originOfConfig, refusesInit, repoIdentity, skipsDir, validBranch, worktreeDir } from './git.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/**
 * @typedef {object} Handle - what ctx.subprocess.spawn returns, as used here.
 * @property {NodeJS.ReadableStream | undefined} [stdout]
 * @property {NodeJS.ReadableStream | undefined} [stderr]
 * @property {NodeJS.WritableStream | undefined} [stdin]
 * @property {Promise<{ exitCode: number | null }>} done
 * @property {{ stdout?: { readFrom(offset: number): { text: string } }, stderr?: { readFrom(offset: number): { text: string } } }} collected
 * @property {() => void} terminate
 */
/**
 * @typedef {object} Subprocess
 * @property {(spec: object) => Handle} spawn
 * @property {(command: string) => Promise<string>} resolveExecutable
 */
/**
 * @typedef {object} Workspace
 * @property {string} id
 * @property {string} path
 * @property {string} [title]
 */
/**
 * @typedef {object} Registry
 * @property {(path: string, title?: string) => Promise<Workspace>} create
 * @property {() => Workspace[]} list
 * @property {(id: string) => Promise<boolean>} delete
 */
/**
 * @typedef {object} Job - a clone or worktree creation the page follows.
 * @property {string} id
 * @property {'running' | 'done' | 'failed' | 'cancelled'} state
 * @property {number} percent
 * @property {string} stage
 * @property {string | null} path
 * @property {string | null} error
 * @property {AbortController} controller
 */

export const name = 'agent-work-workspace'
export const inject = ['connection', 'subprocess', 'workspaceRegistry']

export const Config = Schema.object({
  /** The GitHub organization whose repositories members clone. */
  org: Schema.string().default('GL-Game-Group'),
  /** Where clones go: `<root>/<owner>/<repo>`; `~` is the member's home. */
  root: Schema.string().default('~/GLWork'),
  /** gh to run instead of the system's or the installed one (development, tests). */
  ghPath: Schema.string(),
  /**
   * Folders searched for clones made outside GL Work (besides `root`); `~` is the
   * member's home. Unset: the usual code folders in the home directory (git.js SEARCH_ROOTS).
   */
  searchRoots: Schema.array(Schema.string()),
})

const ROUTE = '/api/agent-work/workspace'
const RELEASE = JSON.parse(await readFile(new URL('./gh-release.json', import.meta.url), 'utf8'))
const OUTPUT = 4 * 1024 * 1024

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** A refusal shown to the member as is. */
class Refusal extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 409) { super(message); this.status = status }
}

/**
 * @param {Context} ctx
 * @param {{ org: string, root: string, ghPath?: string, searchRoots?: string[] }} config
 */
export function apply(ctx, config) {
  const subprocess = /** @type {Subprocess} */ (/** @type {unknown} */ (ctx.get('subprocess')))
  const registry = /** @type {Registry} */ (/** @type {unknown} */ (ctx.get('workspaceRegistry')))
  const logger = ctx.logger('agent-work-workspace')
  const home = homedir()
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  const root = resolve(config.root.replace(/^~(?=$|[\\/])/u, home))
  const target = `${process.platform}-${process.arch}`
  const managedGh = join(dshHome, 'agent-work', 'tools', `gh-${RELEASE.version}`, 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh')
  /** @type {Map<string, Job>} */
  const jobs = new Map()
  /** @type {{ state: 'idle' | 'waiting' | 'done' | 'failed', code: string | null, message: string | null, handle: Handle | null }} */
  let login = { state: 'idle', code: null, message: null, handle: null }
  let installing = false

  // Commands

  /**
   * Run a command and collect its output.
   * @param {string} executable @param {readonly string[]} args
   * @param {{ cwd?: string, env?: Record<string, string>, signal?: AbortSignal, stdin?: string }} [options]
   */
  async function run(executable, args, options = {}) {
    const handle = subprocess.spawn({
      argv: [executable, ...args], cwd: options.cwd ?? home, graceMs: 3_000,
      stdio: { stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin }, stdout: { maxBytes: OUTPUT }, stderr: { maxBytes: 64 * 1024 } },
      ...options.signal === undefined ? {} : { signal: options.signal },
      env: { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', LC_ALL: 'C', ...options.env },
    })
    const { exitCode } = await handle.done
    return { exitCode, stdout: handle.collected.stdout?.readFrom(0).text ?? '', stderr: handle.collected.stderr?.readFrom(0).text ?? '' }
  }

  /** @returns {Promise<string | undefined>} */
  async function gitPath() {
    try { return await subprocess.resolveExecutable('git') } catch { return undefined }
  }

  /** gh to use: configured, then the system's (the member's own setup), then the one GL Work installed. */
  async function ghPath() {
    if (config.ghPath) return { path: config.ghPath, source: /** @type {const} */ ('configured') }
    try { return { path: await subprocess.resolveExecutable('gh'), source: /** @type {const} */ ('system') } } catch { /* not on PATH */ }
    return existsSync(managedGh) ? { path: managedGh, source: /** @type {const} */ ('installed') } : undefined
  }

  /** @param {readonly string[]} args @param {{ cwd?: string, signal?: AbortSignal }} [options] */
  async function git(args, options) {
    const executable = await gitPath()
    if (executable === undefined) throw new Refusal('没有找到 Git。macOS 请在终端运行 xcode-select --install；Windows 请安装 Git for Windows')
    return run(executable, args, options)
  }

  /** @param {readonly string[]} args @param {{ cwd?: string, signal?: AbortSignal }} [options] */
  async function gh(args, options) {
    const found = await ghPath()
    if (found === undefined) throw new Refusal('还没有安装 GitHub CLI，请先在“插件”页安装')
    return run(found.path, args, options)
  }

  /**
   * @template {{ exitCode: number | null, stderr: string }} R
   * @param {R} result @param {string} what @returns {R}
   */
  function ok(result, what) {
    if (result.exitCode !== 0) throw new Refusal(`${what}失败：${result.stderr.trim().split('\n').slice(-3).join(' ') || `退出码 ${String(result.exitCode)}`}`)
    return result
  }

  /** The GitHub login gh is signed in as, or null. */
  async function ghLogin() {
    if ((await ghPath()) === undefined) return null
    const result = await gh(['api', 'user', '--jq', '.login']).catch(() => undefined)
    return result?.exitCode === 0 ? result.stdout.trim() || null : null
  }

  // Tools: git and gh

  async function tools() {
    const gitExe = await gitPath()
    const gitVersion = gitExe === undefined ? null : (await run(gitExe, ['--version']).catch(() => undefined))?.stdout.trim() ?? null
    const found = await ghPath()
    const ghVersion = found === undefined ? null : (await run(found.path, ['--version']).catch(() => undefined))?.stdout.split('\n')[0]?.trim() ?? null
    const account = found === undefined ? null : await ghLogin()
    let helper = false
    if (gitExe !== undefined && account !== null) {
      const configured = await run(gitExe, ['config', '--global', '--get-all', 'credential.https://github.com.helper']).catch(() => undefined)
      helper = configured?.exitCode === 0 && /gh(\.exe)?["']? auth git-credential/u.test(configured.stdout)
    }
    return {
      git: { available: gitExe !== undefined, version: gitVersion },
      gh: { available: found !== undefined, source: found?.source ?? null, version: ghVersion, login: account, gitHelper: helper },
      installable: RELEASE.targets[target] !== undefined,
      installing,
      signIn: { state: login.state, code: login.code, message: login.message, url: 'https://github.com/login/device' },
      org: config.org,
      root,
    }
  }

  /** Install the pinned gh: download, check sha256, unpack under $DSH_HOME/agent-work/tools. */
  async function installGh() {
    const entry = RELEASE.targets[target]
    if (entry === undefined) throw new Refusal('这个系统没有可用的 GitHub CLI 安装包')
    if (installing) throw new Refusal('正在安装')
    installing = true
    const scratch = await mkdtemp(join(tmpdir(), 'aw-gh-'))
    try {
      const url = RELEASE.url.replace('{version}', RELEASE.version).replace('{asset}', entry.asset)
      let response
      try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) }) } catch { throw new Refusal('下载失败：连不上 github.com') }
      if (!response.ok) throw new Refusal(`下载失败（${response.status}）`)
      const archive = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(archive).digest('hex') !== entry.sha256) throw new Refusal('下载的安装包和登记的 sha256 不一致，已停止安装')
      const file = join(scratch, entry.asset)
      await writeFile(file, archive)
      // bsdtar (macOS, Windows 10+) and GNU tar (Linux, .tar.gz) unpack these archives.
      ok(await run('tar', ['-xf', file, '-C', scratch], { cwd: scratch }), '解压')
      const unpacked = join(scratch, entry.asset.replace(/\.(zip|tar\.gz)$/u, ''))
      const dest = dirname(dirname(managedGh))
      await rm(dest, { recursive: true, force: true })
      await mkdir(dirname(dest), { recursive: true })
      await rename(unpacked, dest)
      ok(await run(managedGh, ['--version']), '检查 GitHub CLI')
      logger.info('installed gh %s at %s', RELEASE.version, dest)
    } finally {
      installing = false
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** Start `gh auth login --web`; the member enters the code GitHub shows in the browser gh opens. */
  async function startLogin() {
    const found = await ghPath()
    if (found === undefined) throw new Refusal('还没有安装 GitHub CLI')
    if (login.state === 'waiting') return
    if ((await ghLogin()) !== null) throw new Refusal('已经登录 GitHub 了')
    const handle = subprocess.spawn({
      argv: [found.path, 'auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'],
      cwd: home, graceMs: 3_000,
      stdio: { stdin: { data: '\n' }, stdout: 'pipe', stderr: 'pipe' },
      env: { GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
    })
    const current = { state: /** @type {const} */ ('waiting'), code: /** @type {string | null} */ (null), message: null, handle }
    login = current
    let output = ''
    const read = (/** @type {Buffer} */ chunk) => {
      output += String(chunk)
      current.code ??= deviceCode(output) ?? null
    }
    handle.stdout?.on('data', read)
    handle.stderr?.on('data', read)
    void handle.done.then(({ exitCode }) => {
      if (login !== current) return
      login = exitCode === 0
        ? { state: 'done', code: null, message: null, handle: null }
        : { state: 'failed', code: null, message: output.trim().split('\n').slice(-2).join(' ') || '登录没有完成', handle: null }
    })
    for (let i = 0; i < 50 && current.code === null && login === current; i += 1) await new Promise(done => setTimeout(done, 100))
  }

  // Workspaces

  /**
   * What git says about a directory.
   * @param {string} path
   */
  async function info(path) {
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: path }).catch(() => undefined)
    if (top === undefined || top.exitCode !== 0) return { git: false, root: null, mainRoot: null, worktree: false, branch: null, hasCommits: false, origin: null }
    const repoRoot = top.stdout.trim()
    const [common, gitDir, branch, head, origin] = await Promise.all([
      git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot }),
      git(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: repoRoot }),
      git(['branch', '--show-current'], { cwd: repoRoot }),
      git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoRoot }),
      // The configured URL: `remote get-url` applies insteadOf rewrites (mirrors), which would hide the GitHub identity.
      git(['config', '--get', 'remote.origin.url'], { cwd: repoRoot }),
    ])
    const commonDir = common.stdout.trim()
    const worktree = gitDir.stdout.trim() !== commonDir
    return {
      git: true, root: repoRoot, mainRoot: worktree ? dirname(commonDir) : repoRoot, worktree,
      branch: branch.stdout.trim() || null, hasCommits: head.exitCode === 0,
      origin: origin.exitCode === 0 ? repoIdentity(origin.stdout) ?? null : null,
    }
  }

  /** @param {unknown} value */
  async function existingDir(value) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Refusal('路径不正确', 400)
    const path = await realpath(value).catch(() => undefined)
    if (path === undefined || !(await stat(path)).isDirectory()) throw new Refusal('文件夹不存在', 404)
    return path
  }

  /**
   * Clones on this machine by repository identity, found under the usual code folders
   * (SEARCH_ROOTS, GL Work's clone root first), including clones made outside GL Work.
   * A directory with a `.git` folder is a repository (not searched further); worktrees
   * (a `.git` file) belong to theirs. Kept a few minutes: the walk reads many folders.
   * @type {{ at: number, clones: Map<string, string[]> } | null}
   */
  let cloneIndex = null
  /** @type {Promise<Map<string, string[]>> | null} */
  let indexing = null
  const CLONE_INDEX_MS = 5 * 60_000
  /** Bound on folders read per walk, so an enormous Documents folder cannot stall the page. */
  const MAX_FOLDERS = 20_000
  /** @param {{ fresh?: boolean }} [options] - fresh: walk again now (a member picking a repository). */
  function localClones({ fresh = false } = {}) {
    if (!fresh && cloneIndex !== null && Date.now() - cloneIndex.at < CLONE_INDEX_MS) return Promise.resolve(cloneIndex.clones)
    indexing ??= (async () => {
      /** @type {Map<string, string[]>} */
      const clones = new Map()
      const seen = new Set()
      let budget = MAX_FOLDERS
      /** @param {string} dir @param {number} depth */
      const walk = async (dir, depth) => {
        if (budget <= 0 || seen.has(dir)) return
        seen.add(dir)
        budget -= 1
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        const dotGit = entries.find(e => e.name === '.git')
        if (dotGit !== undefined) {
          if (dotGit.isDirectory()) {
            const identity = originOfConfig(await readFile(join(dir, '.git', 'config'), 'utf8').catch(() => ''))
            if (identity !== undefined) clones.set(identity, [...clones.get(identity) ?? [], dir])
          }
          return
        }
        if (depth >= SEARCH_DEPTH) return
        for (const entry of entries) if (entry.isDirectory() && !skipsDir(entry.name)) await walk(join(dir, entry.name), depth + 1)
      }
      const roots = config.searchRoots?.length ? config.searchRoots.map(r => resolve(r.replace(/^~(?=$|[\\/])/u, home))) : SEARCH_ROOTS.map(r => join(home, r))
      for (const name of [root, ...roots]) {
        if (existsSync(name)) await walk(await realpath(name).catch(() => name), 0)
      }
      cloneIndex = { at: Date.now(), clones }
      return clones
    })().finally(() => { indexing = null })
    return indexing
  }

  /**
   * Local repositories of one GitHub repository: workspaces, the clone target, and
   * clones found elsewhere on this machine, by origin.
   * @param {string} identity @param {string} cloneTarget
   */
  async function sameRepository(identity, cloneTarget) {
    const candidates = new Set([...registry.list().map(w => w.path), cloneTarget, ...(await localClones({ fresh: true })).get(identity) ?? []])
    /** @type {Map<string, { mainRoot: string, workspaces: string[] }>} */
    const found = new Map()
    for (const path of candidates) {
      if (!existsSync(path)) continue
      const facts = await info(path).catch(() => undefined)
      if (facts?.git !== true || facts.origin !== identity || facts.mainRoot === null) continue
      const entry = found.get(facts.mainRoot) ?? { mainRoot: facts.mainRoot, workspaces: [] }
      if (registry.list().some(w => w.path === path)) entry.workspaces.push(path)
      found.set(facts.mainRoot, entry)
    }
    return [...found.values()]
  }

  /** @param {string} repo - `owner/name`. */
  function cloneTargetOf(repo) {
    const [owner, repoName] = repo.split('/')
    return join(root, owner ?? '', repoName ?? '')
  }

  /** What creating a workspace for one repository would do. @param {unknown} repo */
  async function plan(repo) {
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Refusal('仓库不正确', 400)
    const cloneTarget = cloneTargetOf(repo)
    const existing = await sameRepository(`github.com/${repo}`.toLowerCase(), cloneTarget)
    const account = await ghLogin()
    const repoName = repo.split('/')[1] ?? repo
    let suggested = `${repoName}-2`
    for (let n = 2; existing.some(e => existsSync(worktreeDir(e.mainRoot, `${repoName}-${n}`))); n += 1) suggested = `${repoName}-${n + 1}`
    return {
      repo, cloneTarget, cloneTargetExists: existsSync(cloneTarget),
      existing: existing.map(e => ({ mainRoot: e.mainRoot, workspaces: e.workspaces })),
      // With a clone here already, a worktree is recommended; a second clone is the last resort.
      mode: existing.length > 0 ? 'worktree' : 'clone',
      name: suggested, branch: branchFor(account, suggested),
    }
  }

  /**
   * Run a long operation as a job the page polls.
   * @param {(job: Job) => Promise<string>} task - resolves to the new workspace directory.
   */
  function startJob(task) {
    const job = /** @type {Job} */ ({ id: randomUUID(), state: 'running', percent: 0, stage: '准备中', path: null, error: null, controller: new AbortController() })
    jobs.set(job.id, job)
    void task(job).then(
      (path) => { job.state = 'done'; job.path = path; job.percent = 100 },
      (error) => {
        job.state = job.controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = error instanceof Error ? error.message : String(error)
      },
    )
    return job
  }

  /**
   * A worktree with a new branch: from the origin's default branch (a repository picked
   * again) or from the source workspace's HEAD (复制为工作区).
   * @param {string} mainRoot @param {string} name @param {string} branch @param {string} base
   * @param {AbortSignal} [signal]
   */
  async function addWorktree(mainRoot, name, branch, base, signal) {
    if (!NAME.test(name)) throw new Refusal('名字只能用字母、数字、中文和 . _ -（最长 63 个字符）', 400)
    if (!validBranch(branch)) throw new Refusal('分支名不正确', 400)
    const dir = worktreeDir(mainRoot, name)
    if (existsSync(dir)) throw new Refusal(`${dir} 已经存在`)
    const taken = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: mainRoot })
    if (taken.exitCode === 0) throw new Refusal(`分支 ${branch} 已经存在，请换一个名字`)
    await mkdir(dirname(dir), { recursive: true })
    ok(await git(['worktree', 'add', '-b', branch, dir, base], { cwd: mainRoot, ...signal === undefined ? {} : { signal } }), '创建工作树')
    return dir
  }

  /** @param {Record<string, unknown>} body */
  function create(body) {
    const repo = typeof body.repo === 'string' ? body.repo : ''
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Refusal('仓库不正确', 400)
    return startJob(async (job) => {
      const signal = job.controller.signal
      // 直接打开已有仓库: the existing clone itself becomes the workspace.
      if (body.mode === 'open') {
        const facts = await info(typeof body.mainRoot === 'string' ? body.mainRoot : '')
        if (facts.origin !== `github.com/${repo}`.toLowerCase() || facts.root === null) throw new Refusal('本地仓库和所选仓库不一致')
        return facts.root
      }
      if (body.mode === 'worktree') {
        const mainRoot = typeof body.mainRoot === 'string' ? body.mainRoot : ''
        const facts = await info(mainRoot)
        if (facts.origin !== `github.com/${repo}`.toLowerCase()) throw new Refusal('本地仓库和所选仓库不一致')
        job.stage = '获取最新代码'
        await git(['fetch', 'origin', '--prune'], { cwd: mainRoot, signal })
        const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: mainRoot })
        const base = head.exitCode === 0 ? head.stdout.trim() : 'HEAD'
        job.stage = '创建工作树'
        job.percent = 60
        return addWorktree(mainRoot, String(body.name ?? ''), String(body.branch ?? ''), base, signal)
      }
      const dest = cloneTargetOf(repo)
      if (existsSync(dest)) throw new Refusal(`${dest} 已经存在`)
      await mkdir(dirname(dest), { recursive: true })
      const found = await ghPath()
      if (found === undefined) throw new Refusal('还没有安装 GitHub CLI')
      job.stage = '克隆'
      const handle = subprocess.spawn({
        argv: [found.path, 'repo', 'clone', repo, dest, '--', '--progress'], cwd: dirname(dest), graceMs: 3_000, signal,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
        env: { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', LC_ALL: 'C' },
      })
      let tail = ''
      handle.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
        tail = (tail + String(chunk)).slice(-4000)
        for (const line of String(chunk).split(/[\r\n]+/u)) {
          const progress = cloneProgress(line)
          if (progress !== undefined) { job.percent = progress.percent; job.stage = progress.stage }
        }
      })
      const { exitCode } = await handle.done
      if (exitCode !== 0 || signal.aborted) {
        await rm(dest, { recursive: true, force: true })
        throw new Refusal(signal.aborted ? '已取消' : `克隆失败：${tail.trim().split(/[\r\n]+/u).slice(-2).join(' ')}`)
      }
      return dest
    })
  }

  /** @param {Record<string, unknown>} body */
  async function local(body) {
    const path = await existingDir(body.path)
    if (body.init === true) {
      if (refusesInit(path, home)) throw new Refusal('不能把用户目录或磁盘根目录初始化为 Git 仓库')
      if (!(await info(path)).git) ok(await git(['init'], { cwd: path }), '初始化 Git 仓库')
    }
    return { path }
  }

  /** 复制为工作区: a worktree of the workspace's repository from its current HEAD. @param {Record<string, unknown>} body */
  async function copy(body) {
    const source = await existingDir(body.path)
    const facts = await info(source)
    if (!facts.git || facts.mainRoot === null || facts.root === null) throw new Refusal('这个工作区还不是 Git 仓库')
    if (!facts.hasCommits) throw new Refusal('仓库还没有任何提交，先提交一次再复制')
    const dir = await addWorktree(facts.mainRoot, String(body.name ?? ''), String(body.branch ?? ''), 'HEAD')
    // The new worktree starts from the source's HEAD, but in the source's own checkout.
    const workspace = await registry.create(dir, String(body.name))
    return { path: dir, workspaceId: workspace.id }
  }

  /** 删除工作树: refuse uncommitted changes unless confirmed, then remove it and its workspace. @param {Record<string, unknown>} body */
  async function removeWorktree(body) {
    const path = await existingDir(body.path)
    const facts = await info(path)
    if (!facts.worktree || facts.mainRoot === null) throw new Refusal('这个工作区不是工作树')
    const status = await git(['status', '--porcelain'], { cwd: path })
    if (status.stdout.trim() !== '' && body.force !== true) return { dirty: true, changes: status.stdout.trim().split('\n').length }
    ok(await git(['worktree', 'remove', ...body.force === true ? ['--force'] : [], path], { cwd: facts.mainRoot }), '删除工作树')
    const workspace = registry.list().find(w => w.path === path)
    if (workspace !== undefined) await registry.delete(workspace.id)
    return { removed: true }
  }

  /** The member's GitHub organization repositories (what gh lets them see). */
  async function repos() {
    const result = ok(await gh(['repo', 'list', config.org, '--limit', '1000', '--json', 'nameWithOwner,description,isPrivate,updatedAt,defaultBranchRef']), '读取仓库列表')
    /** @type {{ nameWithOwner: string, description: string | null, isPrivate: boolean, updatedAt: string, defaultBranchRef: { name: string } | null }[]} */
    const list = JSON.parse(result.stdout)
    const clones = await localClones()
    return list.map(r => ({
      repo: r.nameWithOwner, description: r.description || null, private: r.isPrivate, updatedAt: r.updatedAt, defaultBranch: r.defaultBranchRef?.name ?? null,
      local: existsSync(cloneTargetOf(r.nameWithOwner)) || clones.has(`github.com/${r.nameWithOwner}`.toLowerCase()),
    }))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  // Routes

  const connection = /** @type {{ fetch: { register: (route: { path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }) => () => Promise<void> } }} */ (/** @type {unknown} */ (ctx.get('connection')))
  /** @param {() => Promise<unknown>} handler */
  const guard = handler => handler().then(value => json(value ?? {}), (error) => {
    if (error instanceof Refusal) return json({ error: error.message }, error.status)
    logger.warn('workspace request failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
    return json({ error: '操作失败，请稍后重试' }, 500)
  })
  /** @param {Request} request @returns {Promise<Record<string, unknown>>} */
  const body = async (request) => {
    try { return /** @type {Record<string, unknown>} */ (await request.json()) } catch { throw new Refusal('请求格式不正确', 400) }
  }
  /** @param {Job} job */
  const jobView = job => ({ id: job.id, state: job.state, percent: job.percent, stage: job.stage, path: job.path, error: job.error })
  /** @type {Record<string, (request: Request, url: URL) => Promise<unknown>>} */
  const handlers = {
    'GET tools': () => tools(),
    'POST tools/install-gh': async () => { await installGh(); return tools() },
    'POST tools/gh-login': async () => { await startLogin(); return tools() },
    'POST tools/gh-login/cancel': async () => { login.handle?.terminate(); login = { state: 'idle', code: null, message: null, handle: null }; return tools() },
    'POST tools/gh-setup-git': async () => { ok(await gh(['auth', 'setup-git', '--hostname', 'github.com']), '配置 git'); return tools() },
    'GET repos': () => repos(),
    'POST plan': async request => plan((await body(request)).repo),
    'POST create': async request => jobView(create(await body(request))),
    'GET job': async (_request, url) => {
      const job = jobs.get(url.searchParams.get('id') ?? '')
      if (job === undefined) throw new Refusal('没有这个任务', 404)
      return jobView(job)
    },
    'POST job/cancel': async (request) => {
      const job = jobs.get(String((await body(request)).id ?? ''))
      job?.controller.abort()
      return job === undefined ? {} : jobView(job)
    },
    'POST local': async request => local(await body(request)),
    'GET info': async (_request, url) => info(await existingDir(url.searchParams.get('path'))),
    'POST copy': async request => copy(await body(request)),
    'POST remove-worktree': async request => removeWorktree(await body(request)),
  }
  for (const [key, handler] of Object.entries(handlers)) {
    const [method, path] = key.split(' ')
    ctx.effect(() => connection.fetch.register({
      path: `${ROUTE}/${path}`, methods: [/** @type {string} */ (method)], requestBody: 'buffered',
      fetch: request => guard(() => handler(request, new URL(request.url))),
    }), `agent-work workspace ${key}`)
  }

  ctx.effect(() => () => {
    login.handle?.terminate()
    for (const job of jobs.values()) job.controller.abort()
  }, 'agent-work workspace lifetime')
}
