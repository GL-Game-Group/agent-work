/**
 * 工作区管理 end to end: a real `dsh web` Host with this plugin, real git, and
 * GitHub played by local bare repositories behind a stand-in gh (bin/gh below):
 * `repo list` answers one repository, `repo clone` clones the bare repository
 * and keeps `https://github.com/<owner>/<repo>` as origin (rewritten to the
 * local path for fetches), `api user` answers a login.
 *
 * Usage: AGENT_WORK_DSH=<dir containing node_modules/.bin/dsh> node --test plugins/workspace/test/workspace.e2e.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

const DSH_DIR = process.env.AGENT_WORK_DSH
const PLUGIN = resolve(import.meta.dirname, '..')
const sleep = ms => new Promise((done) => { setTimeout(done, ms) })
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

async function freePort() {
  const probe = createServer()
  await new Promise((done) => { probe.listen(0, '127.0.0.1', done) })
  const { port } = probe.address()
  await new Promise((done) => { probe.close(done) })
  return port
}

describe('工作区管理 in a real Host', { skip: DSH_DIR === undefined ? 'set AGENT_WORK_DSH' : false }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aw-workspace-')))
  const home = join(base, 'dsh-home')
  const remotes = join(base, 'remotes')
  const root = join(base, 'GLWork')
  const fakeHome = join(base, 'home')
  let host, origin, cookie, realGlobal

  async function rpc(method, args = {}) {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    })
    const envelope = await response.json()
    assert.equal(envelope.result?.ok, true, `${method}: ${JSON.stringify(envelope)}`)
    return envelope.result.value
  }
  async function api(path, body, status = 200) {
    const response = await fetch(`${origin}/api/agent-work/workspace/${path}`, body === undefined ? { headers: { cookie } } : {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const value = await response.json()
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`)
    return value
  }
  async function finish(job) {
    for (let i = 0; i < 200 && job.state === 'running'; i += 1) {
      await sleep(100)
      job = await api(`job?id=${job.id}`)
    }
    return job
  }

  before(async () => {
    // GitHub: GL-Game-Group/demo as a bare repository with one commit on main.
    mkdirSync(join(remotes, 'GL-Game-Group'), { recursive: true })
    const bare = join(remotes, 'GL-Game-Group', 'demo.git')
    git(base, 'init', '--bare', '--initial-branch=main', bare)
    const seed = join(base, 'seed')
    git(base, 'clone', bare, seed)
    writeFileSync(join(seed, 'README.md'), '# demo\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-m', 'init')
    git(seed, 'push', 'origin', 'HEAD:main')
    // The stand-in gh.
    mkdirSync(join(base, 'bin'))
    const gh = join(base, 'bin', 'gh')
    writeFileSync(gh, `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "gh version 9.9.9 (stand-in)";;
  "api user") echo alice;;
  "repo list") echo '[{"nameWithOwner":"GL-Game-Group/demo","description":"演示仓库","isPrivate":true,"updatedAt":"2026-10-01T00:00:00Z","defaultBranchRef":{"name":"main"}}]';;
  "repo clone")
    git clone --progress "${remotes}/$3.git" "$4" || exit 1
    git -C "$4" remote set-url origin "https://github.com/$3.git"
    git -C "$4" config "url.${remotes}/.insteadOf" "https://github.com/"
    ;;
  "auth setup-git") [ -n "$GIT_CONFIG_GLOBAL" ] || { echo "refusing: no test GIT_CONFIG_GLOBAL" >&2; exit 3; }; git config --global credential.https://github.com.helper "!gh auth git-credential";;
  *) echo "unexpected: $*" >&2; exit 2;;
esac
`)
    chmodSync(gh, 0o755)

    const dsh = join(DSH_DIR, 'node_modules', '.bin', 'dsh')
    // git's global configuration is the test's own file: the stand-in's setup-git and every read stay inside it.
    // The Host keeps the real home whatever HOME says: searchRoots points the clone search here instead.
    mkdirSync(join(fakeHome, 'Documents'), { recursive: true })
    const env = { ...process.env, DSH_HOME: home, GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), ...GIT_ENV }
    writeFileSync(join(base, 'gitconfig'), '')
    realGlobal = existsSync(join(homedir(), '.gitconfig')) ? readFileSync(join(homedir(), '.gitconfig'), 'utf8') : null
    execFileSync(dsh, ['plugin', '--profile', 'web', 'add', `file:${PLUGIN}`], { env, stdio: 'ignore' })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `- id: agent-work-workspace\n  config:\n    org: GL-Game-Group\n    root: '${root}'\n    ghPath: '${gh}'\n    searchRoots: ['${join(fakeHome, 'Documents')}']\n`)
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    host = spawn(dsh, ['web', '--no-open', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const token = await new Promise((done, fail) => {
      const timer = setTimeout(() => { fail(new Error(`Host did not start:\n${output}`)) }, 60_000)
      const read = (chunk) => { output += chunk; const m = /token=([A-Za-z0-9_-]+)/.exec(output); if (m) { clearTimeout(timer); done(m[1]) } }
      host.stdout.on('data', read)
      host.stderr.on('data', read)
    })
    cookie = (await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0]
  })

  after(() => {
    host?.kill()
    const now = existsSync(join(homedir(), '.gitconfig')) ? readFileSync(join(homedir(), '.gitconfig'), 'utf8') : null
    assert.equal(now, realGlobal, 'the member\'s own ~/.gitconfig is untouched')
    rmSync(base, { recursive: true, force: true })
  })

  it('reports git, gh and the GitHub login', async () => {
    const tools = await api('tools')
    assert.equal(tools.git.available, true)
    assert.deepEqual([tools.gh.available, tools.gh.source, tools.gh.login, tools.gh.gitHelper], [true, 'configured', 'alice', false])
    assert.equal(tools.org, 'GL-Game-Group')
    assert.equal(tools.root, root)
    const configured = await api('tools/gh-setup-git', {})
    assert.equal(configured.gh.gitHelper, true, 'git uses the gh sign-in after the member asks')
    assert.match(readFileSync(join(base, 'gitconfig'), 'utf8'), /gh auth git-credential/u)
  })

  it('lists the organization repositories', async () => {
    assert.deepEqual(await api('repos'), [{ repo: 'GL-Game-Group/demo', description: '演示仓库', private: true, updatedAt: '2026-10-01T00:00:00Z', defaultBranch: 'main', local: false }])
  })

  let clone
  it('clones a repository that is not here yet', async () => {
    const plan = await api('plan', { repo: 'GL-Game-Group/demo' })
    assert.deepEqual([plan.mode, plan.cloneTarget, plan.existing], ['clone', join(root, 'GL-Game-Group', 'demo'), []])
    const job = await finish(await api('create', { repo: 'GL-Game-Group/demo', mode: 'clone' }))
    assert.equal(job.state, 'done', JSON.stringify(job))
    clone = job.path
    assert.equal(git(clone, 'config', '--get', 'remote.origin.url'), 'https://github.com/GL-Game-Group/demo.git')
    // The page then hands the directory to the workspace picker, which registers it.
    const created = await rpc('workspace/create', { request: { path: clone } })
    assert.equal(created.workspace.path, clone)
  })

  it('defaults to a worktree when the repository is already here', async () => {
    const plan = await api('plan', { repo: 'GL-Game-Group/demo' })
    assert.equal(plan.mode, 'worktree')
    assert.deepEqual(plan.existing, [{ mainRoot: clone, workspaces: [clone] }])
    assert.deepEqual([plan.name, plan.branch, plan.cloneTargetExists], ['demo-2', 'alice/demo-2', true])
    const job = await finish(await api('create', { repo: 'GL-Game-Group/demo', mode: 'worktree', mainRoot: clone, name: plan.name, branch: plan.branch }))
    assert.equal(job.state, 'done', JSON.stringify(job))
    assert.equal(job.path, join(root, 'GL-Game-Group', 'demo.worktrees', 'demo-2'))
    assert.equal(git(job.path, 'branch', '--show-current'), 'alice/demo-2')
    assert.match(git(clone, 'worktree', 'list'), /demo\.worktrees\/demo-2/u)
    // A clone where the repository already sits is refused.
    const again = await finish(await api('create', { repo: 'GL-Game-Group/demo', mode: 'clone' }))
    assert.equal(again.state, 'failed')
    assert.match(again.error, /已经存在/u)
  })

  it('finds a clone made outside GL Work and opens it as it is', async () => {
    // Cloned by hand into ~/Documents/work/demo, before GL Work knew about it.
    const outside = join(fakeHome, 'Documents', 'work', 'demo')
    mkdirSync(dirname(outside), { recursive: true })
    git(base, 'clone', join(remotes, 'GL-Game-Group', 'demo.git'), outside)
    git(outside, 'remote', 'set-url', 'origin', 'git@github.com:GL-Game-Group/demo.git')
    // node_modules and hidden folders are not searched.
    mkdirSync(join(fakeHome, 'Documents', 'node_modules', 'demo', '.git'), { recursive: true })
    writeFileSync(join(fakeHome, 'Documents', 'node_modules', 'demo', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/GL-Game-Group/demo.git\n')
    const real = realpathSync(outside)
    const plan = await api('plan', { repo: 'GL-Game-Group/demo' })
    assert.equal(plan.mode, 'worktree')
    assert.deepEqual(plan.existing.map(e => e.mainRoot).sort(), [clone, real].sort())
    const repos = await api('repos')
    assert.equal(repos.find(r => r.repo === 'GL-Game-Group/demo').local, true)
    const job = await finish(await api('create', { repo: 'GL-Game-Group/demo', mode: 'open', mainRoot: real }))
    assert.equal(job.state, 'done', JSON.stringify(job))
    assert.equal(job.path, real)
    // A different repository's folder is refused.
    const wrong = await finish(await api('create', { repo: 'GL-Game-Group/other', mode: 'open', mainRoot: real }))
    assert.equal(wrong.state, 'failed')
    assert.match(wrong.error, /不一致/u)
  })

  it('creates a workspace from a local folder, initializing git only when asked', async () => {
    const notes = join(base, 'notes')
    mkdirSync(notes)
    assert.equal((await api(`info?path=${encodeURIComponent(notes)}`)).git, false)
    await api('local', { path: notes, init: false })
    assert.equal(existsSync(join(notes, '.git')), false)
    await api('local', { path: notes, init: true })
    assert.equal((await api(`info?path=${encodeURIComponent(notes)}`)).git, true)
    assert.match((await api('local', { path: '/', init: true }, 409)).error, /磁盘根目录/u)
    assert.equal((await api('local', { path: join(base, 'nope') }, 404)).error, '文件夹不存在')
  })

  let copy
  it('copies a workspace as a worktree from its current branch, and registers it', async () => {
    const result = await api('copy', { path: clone, name: 'feature', branch: 'alice/feature' })
    copy = result.path
    assert.equal(copy, join(root, 'GL-Game-Group', 'demo.worktrees', 'feature'))
    assert.match(result.workspaceId, /^[0-9a-f-]{36}$/u)
    assert.equal(git(copy, 'branch', '--show-current'), 'alice/feature')
    const facts = await api(`info?path=${encodeURIComponent(copy)}`)
    assert.deepEqual([facts.worktree, facts.mainRoot, facts.origin], [true, clone, 'github.com/gl-game-group/demo'])
    assert.match((await api('copy', { path: clone, name: 'feature', branch: 'alice/other' }, 409)).error, /已经存在/u)
    assert.match((await api('copy', { path: clone, name: 'other', branch: 'alice/feature' }, 409)).error, /分支 alice\/feature 已经存在/u)
    assert.match((await api('copy', { path: clone, name: '../escape', branch: 'x' }, 400)).error, /名字只能/u)
    const empty = join(base, 'empty')
    mkdirSync(empty)
    git(empty, 'init')
    assert.match((await api('copy', { path: empty, name: 'x', branch: 'x' }, 409)).error, /还没有任何提交/u)
  })

  it('removes a worktree only after confirming uncommitted changes', async () => {
    writeFileSync(join(copy, 'draft.txt'), 'wip\n')
    assert.deepEqual(await api('remove-worktree', { path: copy }), { dirty: true, changes: 1 })
    assert.equal(existsSync(copy), true)
    assert.deepEqual(await api('remove-worktree', { path: copy, force: true }), { removed: true })
    assert.equal(existsSync(copy), false)
    assert.equal(git(clone, 'branch', '--list', 'alice/feature'), 'alice/feature', 'the branch stays')
    assert.match((await api('remove-worktree', { path: clone }, 409)).error, /不是工作树/u)
  })
})
