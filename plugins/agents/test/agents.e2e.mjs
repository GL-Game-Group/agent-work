/**
 * 命令行 Agent end to end: a real `dsh web` Host with this plugin and stand-in
 * CLIs (configured paths), so nothing touches the member's own installs.
 *
 * Usage: AGENT_WORK_DSH=<dir containing node_modules/.bin/dsh> node --test plugins/agents/test/agents.e2e.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

const DSH_DIR = process.env.AGENT_WORK_DSH
const PLUGIN = resolve(import.meta.dirname, '..')

async function freePort() {
  const probe = createServer()
  await new Promise((done) => { probe.listen(0, '127.0.0.1', done) })
  const { port } = probe.address()
  await new Promise((done) => { probe.close(done) })
  return port
}

describe('命令行 Agent in a real Host', { skip: DSH_DIR === undefined ? 'set AGENT_WORK_DSH' : false }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aw-agents-')))
  const home = join(base, 'dsh-home')
  let host, origin, cookie

  async function api(path, body, status = 200) {
    const response = await fetch(`${origin}/api/agent-work/agents/${path}`, body === undefined ? { headers: { cookie } } : {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const value = await response.json()
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`)
    return value
  }

  before(async () => {
    const bin = join(base, 'bin')
    mkdirSync(bin)
    const stand = (file, script) => { writeFileSync(join(bin, file), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, file), 0o755) }
    stand('claude', `case "$1 $2" in
  "--version "*) echo "2.1.285 (Claude Code)";;
  "auth status") echo '{"loggedIn": false, "authMethod": "none"}';;
  "auth login") echo "Opening https://claude.ai/oauth/authorize?code=stand-in"; sleep 1;;
esac`)
    stand('codex', `case "$1 $2" in
  "--version "*) echo "codex-cli 0.160.0";;
  "login status") echo "Logged in using ChatGPT";;
esac`)
    const dsh = join(DSH_DIR, 'node_modules', '.bin', 'dsh')
    const env = { ...process.env, DSH_HOME: home }
    execFileSync(dsh, ['plugin', '--profile', 'web', 'add', `file:${PLUGIN}`], { env, stdio: 'ignore' })
    // Qoder points at a path that does not exist: "not installed", whatever the machine has.
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `- id: agent-work-agents\n  config:\n    paths:\n      claude: '${join(bin, 'claude')}'\n      codex: '${join(bin, 'codex')}'\n      qoder: '${join(bin, 'missing-qodercli')}'\n`)
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
    rmSync(base, { recursive: true, force: true })
  })

  it('detects each CLI with its version and sign-in', async () => {
    const { clis } = await api('clis')
    const byId = Object.fromEntries(clis.map(c => [c.id, c]))
    assert.deepEqual([byId.claude.version, byId.claude.signedIn], ['2.1.285', false])
    assert.deepEqual([byId.codex.version, byId.codex.signedIn], ['0.160.0', true])
    assert.deepEqual([byId.qoder.path, byId.qoder.version, byId.qoder.installable], [null, null, true])
    assert.deepEqual(clis.map(c => c.accounts), [[], [], []], 'not signed in to a company service here')
  })

  it('starts the CLI\'s own sign-in and hands its address to the page', async () => {
    const started = await api('login', { id: 'claude' })
    assert.equal(started.url, 'https://claude.ai/oauth/authorize?code=stand-in')
    await new Promise(done => setTimeout(done, 1500))
    const { clis } = await api('clis')
    assert.equal(clis.find(c => c.id === 'claude').signIn.state, 'done')
  })

  it('refuses what it does not know', async () => {
    assert.equal((await api('install', { id: 'cursor' }, 400)).error, '不认识的命令行')
    assert.equal((await api('login', { id: 'qoder' }, 409)).error, '还没有安装 Qoder CLI')
  })
})
