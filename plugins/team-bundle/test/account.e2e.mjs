/**
 * Company account end to end: a real `dsh web` Host with this bundle, the real
 * company service (gateway/) on loopback, and a fake GitHub. Drives the same
 * `account/*` RPCs the desktop welcome window and Settings use.
 *
 * Usage: AGENT_WORK_DSH=<dir containing node_modules/.bin/dsh> node --test plugins/team-bundle/test/account.e2e.mjs
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Store } from '../../../gateway/src/db.ts'
import { openPglite } from '../../../gateway/src/sql.ts'
import { GitHub } from '../../../gateway/src/github.ts'
import { PluginCatalog, packTarball, readPackage, sampleBundle } from '../../../gateway/src/plugins.ts'
import { SecretBox } from '../../../gateway/src/secrets.ts'
import { createGateway } from '../../../gateway/src/server.ts'
import { Vendors } from '../../../gateway/src/vendors.ts'

const DSH_DIR = process.env.AGENT_WORK_DSH
const BUNDLE = resolve(import.meta.dirname, '..')
const CLIENT = { version: 'e2e', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }

function listen(server, port = 0) {
  return new Promise((done) => { server.listen(port, '127.0.0.1', () => { done(server.address().port) }) })
}

async function freePort() {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((done) => { probe.close(done) })
  return port
}

const SECRET_KEY = Buffer.alloc(32, 1).toString('base64')
const sleep = ms => new Promise((done) => { setTimeout(done, ms) })

describe('company account in a real Host', { skip: DSH_DIR === undefined ? 'set AGENT_WORK_DSH' : false }, () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-e2e-'))
  /** @type {Store} */
  let store
  let gateway, github, host, gatewayOrigin, hostOrigin, cookie

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

  async function until(predicate, label) {
    for (let i = 0; i < 100; i += 1) {
      const state = await rpc('account/getState')
      if (predicate(state)) return state
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  /** Walk the browser through the company service and GitHub back to the Host, as a member would. */
  async function approveInBrowser(authorizeUrl, githubUser) {
    const start = await fetch(`${authorizeUrl}&theme=dark`, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    const callback = await fetch(`${gatewayOrigin}/agent-work/auth/github/callback?code=${githubUser}&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    if (callback.status !== 303) return callback
    const loopback = new URL(callback.headers.get('location'))
    assert.equal(loopback.origin, hostOrigin)
    return fetch(loopback, { redirect: 'manual' })
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
      const users = { alice: { id: 101, login: 'alice-gh' }, mallory: { id: 666, login: 'mallory' } }
      const user = users[req.headers.authorization?.replace('Bearer tok-', '') ?? '']
      if (url.pathname === '/user') { if (user) send(200, user); else send(401, {}); return }
      send(404, {})
    })
    const githubOrigin = `http://127.0.0.1:${await listen(github)}`
    const gatewayPort = await freePort()
    gatewayOrigin = `http://127.0.0.1:${gatewayPort}`
    const config = {
      publicOrigin: gatewayOrigin, listenHost: '127.0.0.1', listenPort: gatewayPort, trustProxy: false, dataDir: null,
      github: { clientId: 'id', clientSecret: 'secret', org: '', webUrl: githubOrigin, apiUrl: githubOrigin },
      // The upstream is never called here; the imported key only turns DeepSeek on for alice.
      secretKey: SECRET_KEY,
      deepseek: { baseUrl: 'http://127.0.0.1:9/anthropic', apiKey: 'sk-company' },
    }
    store = await Store.open(await openPglite())
    await store.addMember({ name: 'alice', githubId: 101, githubLogin: 'alice-gh', role: 'member' })
    gateway = createGateway({ config, store, github: new GitHub(config.github), authRateLimit: { requests: 1000, windowMs: 60_000 } })
    await listen(gateway, gatewayPort)

    const dsh = join(DSH_DIR, 'node_modules', '.bin', 'dsh')
    const env = { ...process.env, DSH_HOME: home }
    execFileSync(dsh, ['plugin', '--profile', 'web', 'add', `file:${BUNDLE}`], { env, stdio: 'ignore' })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `- id: company-account\n  config:\n    serverOrigin: '${gatewayOrigin}'\n    allowLoopbackHttp: true\n`
      + '- id: company-config-sync\n  config:\n    intervalMs: 1000\n')
    const hostPort = await freePort()
    hostOrigin = `http://127.0.0.1:${hostPort}`
    host = spawn(dsh, ['web', '--no-open', '--port', String(hostPort)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const token = await new Promise((done, fail) => {
      const timer = setTimeout(() => { fail(new Error(`Host did not start:\n${output}`)) }, 60_000)
      const read = (chunk) => {
        output += chunk
        const match = /token=([A-Za-z0-9_-]+)/.exec(output)
        if (match) { clearTimeout(timer); done(match[1]) }
      }
      host.stdout.on('data', read)
      host.stderr.on('data', read)
    })
    const exchange = await fetch(`${hostOrigin}/?token=${token}`, { redirect: 'manual' })
    cookie = exchange.headers.get('set-cookie').split(';')[0]
  })

  after(async () => {
    host?.kill()
    gateway?.close()
    github?.close()
    await store?.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('starts signed out, with company links', async () => {
    const state = await rpc('account/getState')
    assert.equal(state.status, 'signed-out')
    assert.equal(state.links.usageUrl, `${gatewayOrigin}/agent-work/account`)
    assert.equal(await rpc('account/getProfile', { client: CLIENT }), null)
  })

  it('signs in through the browser and the loopback callback', async () => {
    await rpc('account/startSignIn', { client: CLIENT, callbackOrigin: hostOrigin, loginSource: 'desktop' })
    const waiting = await until(s => s.attempt?.phase === 'waiting-browser', 'waiting-browser')
    assert.ok(waiting.attempt.authorizeUrl.startsWith(`${gatewayOrigin}/agent-work/auth/desktop/start?`))
    const done = await approveInBrowser(waiting.attempt.authorizeUrl, 'alice')
    assert.equal(done.status, 302)
    assert.equal(done.headers.get('location'), `${gatewayOrigin}/agent-work/auth/desktop/done`)
    const signedIn = await until(s => s.status === 'credential-stored', 'credential-stored')
    assert.equal(signedIn.attempt.phase, 'succeeded')

    const profile = await rpc('account/getProfile', { client: CLIENT })
    assert.deepEqual(profile, { status: 'ready', value: { id: 'alice', name: 'alice', contact: 'GitHub @alice-gh', avatarUrl: 'https://avatars.githubusercontent.com/u/101' } })
    assert.deepEqual(await rpc('account/getBalance', { client: CLIENT }), { status: 'ready', value: [], bonusWallets: [] })
    assert.equal((await store.listCredentials('alice')).filter(c => c.kind === 'device').length, 1)
  })

  async function deepseekSettings() {
    const described = await rpc('settings/describe')
    return described.namespaces.find(ns => ns.ns === 'llm-deepseek')
  }
  async function modelKeyConfigured() {
    return (await rpc('credentials/describe', { refs: ['AGENT_WORK_MODEL_KEY'] })).AGENT_WORK_MODEL_KEY.configured
  }

  it('applies the company model config after sign-in', async () => {
    for (let i = 0; i < 50; i += 1) {
      if ((await deepseekSettings())?.value?.baseURL === `${gatewayOrigin}/agent-work/llm/deepseek` && await modelKeyConfigured()) break
      await sleep(200)
    }
    const settings = await deepseekSettings()
    assert.equal(settings.value.baseURL, `${gatewayOrigin}/agent-work/llm/deepseek`)
    assert.equal(settings.value.apiKeyEnv, 'AGENT_WORK_MODEL_KEY')
    assert.equal(await modelKeyConfigured(), true)
  })

  it('keeps a member\'s own change through later syncs', async () => {
    const before = await deepseekSettings()
    await rpc('settings/mutate', { ns: 'llm-deepseek', ops: [{ op: 'set', path: ['baseURL'], value: 'https://member.example/anthropic' }], expectedRevision: before.revision })
    await sleep(2500)
    assert.equal((await deepseekSettings()).value.baseURL, 'https://member.example/anthropic')
    assert.equal((await deepseekSettings()).value.apiKeyEnv, 'AGENT_WORK_MODEL_KEY', 'the paths the member left alone stay managed')
  })

  it('lists the company plugins with what this profile has installed, and reports it', async () => {
    const catalog = new PluginCatalog(store)
    const pack = (name, version) => readPackage(packTarball(sampleBundle(name, version)))
    const meta = { permissions: ['读取系统配置'], preinstalled: false, status: 'published' }
    // This bundle is itself in the catalog (installed); a second one is not installed.
    await catalog.save(pack('@agent-work/dsh-team-bundle', '0.2.0'), 'https://oss.example/team.tgz', { ...meta, displayName: '团队插件', preinstalled: true })
    await catalog.save(pack('@agent-work/dsh-feishu', '0.3.0'), 'https://oss.example/feishu.tgz', { ...meta, displayName: '飞书通知' })
    await catalog.save(pack('@agent-work/dsh-hidden', '1.0.0'), 'https://oss.example/hidden.tgz', { ...meta, displayName: '未上架', status: 'hidden' })
    const response = await fetch(`${hostOrigin}/api/agent-work/company-plugins`, { headers: { cookie } })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.signedIn, true)
    assert.deepEqual(body.plugins.map(p => [p.name, p.installedVersion]), [['@agent-work/dsh-team-bundle', '0.1.0'], ['@agent-work/dsh-feishu', null]])
    assert.equal(body.plugins[1].integrity, readPackage(packTarball(sampleBundle('@agent-work/dsh-feishu', '0.3.0'))).integrity)
    let reported = []
    for (let i = 0; i < 20 && reported.length === 0; i += 1) { await sleep(100); reported = await catalog.installs() }
    assert.deepEqual(reported.map(r => [r.plugin, r.version]), [['@agent-work/dsh-team-bundle', '0.1.0']], 'the console learns what runs here')
    assert.equal((await fetch(`${hostOrigin}/api/agent-work/company-plugins`)).status, 401, 'only the signed-in window')
  })

  it('installs a published plugin after checking its sha512, and refuses anything else', async () => {
    const catalog = new PluginCatalog(store)
    const bundle = (name, version, extra = {}) => packTarball(sampleBundle(name, version, extra))
    const hello = bundle('@agent-work/dsh-hello', '1.0.0')
    const files = {
      '/hello.tgz': hello,
      '/tampered.tgz': bundle('@agent-work/dsh-tampered', '1.0.0', { description: 'not what was registered' }),
      '/scripts.tgz': bundle('@agent-work/dsh-scripts', '1.0.0', { scripts: { postinstall: 'node -e "process.exit(0)"' } }),
    }
    const oss = createServer((req, res) => { const body = files[req.url]; if (body) res.writeHead(200).end(body); else res.writeHead(404).end() })
    const ossOrigin = `http://127.0.0.1:${await listen(oss)}`
    try {
      const meta = { displayName: 'x', permissions: [], preinstalled: false, status: 'published' }
      await catalog.save(readPackage(hello), `${ossOrigin}/hello.tgz`, { ...meta, displayName: '你好' })
      // Registered with one package's sha512, served another.
      await catalog.save({ ...readPackage(bundle('@agent-work/dsh-tampered', '1.0.0')) }, `${ossOrigin}/tampered.tgz`, meta)
      // The service refuses install scripts at registration; registered behind its back, the Plugin Manager must stop it too.
      const scripts = files['/scripts.tgz']
      await catalog.save({ name: '@agent-work/dsh-scripts', version: '1.0.0', description: null, size: scripts.length, dependencies: 0,
        integrity: `sha512-${createHash('sha512').update(scripts).digest('base64')}` }, `${ossOrigin}/scripts.tgz`, meta)
      const install = name => fetch(`${hostOrigin}/api/agent-work/company-plugins/install`, {
        method: 'POST', headers: { cookie, origin: hostOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      })

      const done = await install('@agent-work/dsh-hello')
      const result = await done.json()
      assert.equal(done.status, 200, JSON.stringify(result))
      assert.equal(result.version, '1.0.0')
      const listed = await (await fetch(`${hostOrigin}/api/agent-work/company-plugins`, { headers: { cookie } })).json()
      assert.equal(listed.plugins.find(p => p.name === '@agent-work/dsh-hello').installedVersion, '1.0.0')
      let reported = []
      for (let i = 0; i < 20 && !reported.includes('@agent-work/dsh-hello'); i += 1) { await sleep(100); reported = (await catalog.installs()).map(r => r.plugin) }
      assert.ok(reported.includes('@agent-work/dsh-hello'), 'reported to the console')

      const tampered = await install('@agent-work/dsh-tampered')
      assert.equal(tampered.status, 409)
      assert.match((await tampered.json()).error, /sha512/u)
      assert.equal((await install('@agent-work/dsh-hidden')).status, 409, 'not published')
      assert.match((await (await install('@agent-work/dsh-team-bundle')).json()).error, /随 GL Work/u, 'preinstalled ones update with GL Work')
      const refusedScripts = await install('@agent-work/dsh-scripts')
      assert.equal(refusedScripts.status, 409, 'install scripts stop the installation')
      assert.equal((await fetch(`${hostOrigin}/api/agent-work/company-plugins/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'only the signed-in window')
    } finally {
      oss.close()
    }
  })

  it('applies an OpenAI-compatible vendor as a pi-ai route, and the offered DeepSeek models', async () => {
    const vendors = new Vendors(store, SecretBox.fromEncoded(SECRET_KEY))
    await vendors.addKey('qwen', 'team', 'sk-qwen-company')
    await vendors.setModels('qwen', [{ id: 'qwen-plus', name: 'Qwen Plus' }, 'qwen3-coder-plus'])
    await vendors.setMemberVendors('alice', ['deepseek', 'qwen'])
    const route = async () => (await rpc('settings/describe')).namespaces.find(ns => ns.ns === 'llm-pi-ai')?.value?.providers?.['company-qwen']
    for (let i = 0; i < 25 && await route() === undefined; i += 1) await sleep(200)
    const qwen = await route()
    assert.equal(qwen?.baseURL, `${gatewayOrigin}/agent-work/llm/qwen`)
    assert.equal(qwen?.api, 'openai-completions')
    assert.equal(qwen?.apiKeyEnv, 'AGENT_WORK_MODEL_KEY')
    assert.deepEqual(qwen?.models.map(m => m.id), ['qwen-plus', 'qwen3-coder-plus'])
    assert.equal(qwen?.compat?.thinkingFormat, 'qwen')
    assert.deepEqual((await deepseekSettings()).value.models.map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro'])

    await vendors.setMemberVendors('alice', ['deepseek'])
    for (let i = 0; i < 25 && await route() !== undefined; i += 1) await sleep(200)
    assert.equal(await route(), undefined, 'a vendor taken away is removed again')
  })

  it('signs out locally and revokes the device on the service', async () => {
    assert.equal((await rpc('account/signOut', { client: CLIENT })).status, 'signed-out')
    for (let i = 0; i < 50 && (await store.listCredentials('alice')).length > 0; i += 1) await sleep(100)
    assert.equal((await store.listCredentials('alice')).length, 0)
    for (let i = 0; i < 25 && await modelKeyConfigured(); i += 1) await sleep(200)
    assert.equal(await modelKeyConfigured(), false, 'the device token no longer sits in the model key')
  })

  it('forgets a token the service revoked', async () => {
    await rpc('account/startSignIn', { client: CLIENT, callbackOrigin: hostOrigin, loginSource: 'desktop' })
    const waiting = await until(s => s.attempt?.phase === 'waiting-browser', 'waiting-browser')
    await approveInBrowser(waiting.attempt.authorizeUrl, 'alice')
    await until(s => s.status === 'credential-stored', 'credential-stored')
    for (const credential of await store.listCredentials('alice')) await store.revokeCredential(credential.id)
    assert.deepEqual(await rpc('account/getProfile', { client: CLIENT }), { status: 'failed' })
    assert.equal((await rpc('account/getState')).status, 'signed-out')
  })

  it('reports a refused GitHub account as a failed attempt', async () => {
    await rpc('account/startSignIn', { client: CLIENT, callbackOrigin: hostOrigin, loginSource: 'desktop' })
    const waiting = await until(s => s.attempt?.phase === 'waiting-browser', 'waiting-browser')
    const refused = await approveInBrowser(waiting.attempt.authorizeUrl, 'mallory')
    assert.equal(refused.status, 403, 'the service refuses before the browser returns to the Host')
    const cancelled = await rpc('account/cancelSignIn', { attemptId: waiting.attempt.id })
    assert.equal(cancelled.attempt.phase, 'cancelled')
    assert.equal(cancelled.status, 'signed-out')
  })

  it('rejects a forged callback', async () => {
    await rpc('account/startSignIn', { client: CLIENT, callbackOrigin: hostOrigin, loginSource: 'desktop' })
    const waiting = await until(s => s.attempt?.phase === 'waiting-browser', 'waiting-browser')
    assert.equal((await fetch(`${hostOrigin}/oauth/callback?code=x&state=forged`)).status, 400)
    await rpc('account/cancelSignIn', { attemptId: waiting.attempt.id })
  })

  /** The server setting as the welcome window changes it: settings/mutate on the company-account entry. */
  async function setServer(ops) {
    const described = await rpc('settings/describe')
    const entry = described.namespaces.find(ns => ns.ns === 'company-account')
    assert.ok(entry, 'company-account exposes its live server setting')
    return fetch(`${hostOrigin}/api/settings/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: hostOrigin },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'settings/mutate', payload: { args: { ns: 'company-account', ops, expectedRevision: entry.revision } } }),
    }).then(r => r.json())
  }

  it('switches servers from the server setting, forgetting the old server\'s sign-in', async () => {
    await rpc('account/startSignIn', { client: CLIENT, callbackOrigin: hostOrigin, loginSource: 'desktop' })
    const waiting = await until(s => s.attempt?.phase === 'waiting-browser', 'waiting-browser')
    await approveInBrowser(waiting.attempt.authorizeUrl, 'alice')
    await until(s => s.status === 'credential-stored', 'credential-stored')
    const other = `http://127.0.0.1:${await freePort()}`
    assert.equal((await setServer([{ op: 'set', path: ['serverOrigin'], value: other }])).result?.ok, true)
    const switched = await until(s => s.links?.usageUrl === `${other}/agent-work/account`, 'links follow the new server')
    assert.equal(switched.status, 'signed-out', 'the old server\'s grant is gone')
    assert.match(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), new RegExp(other.replaceAll('.', '\\.')), 'saved in the member\'s profile')
    // Not an origin: refused by the setting itself, the server stays.
    assert.notEqual((await setServer([{ op: 'set', path: ['serverOrigin'], value: 'ftp://evil.example/x' }])).result?.ok, true)
    assert.equal((await rpc('account/getState')).links.usageUrl, `${other}/agent-work/account`)
    // Back to the company service; signing in works again.
    await setServer([{ op: 'set', path: ['serverOrigin'], value: gatewayOrigin }])
    await until(s => s.links?.usageUrl === `${gatewayOrigin}/agent-work/account`, 'back to the company service')
    await rpc('account/startSignIn', { client: CLIENT, callbackOrigin: hostOrigin, loginSource: 'desktop' })
    const again = await until(s => s.attempt?.phase === 'waiting-browser', 'waiting-browser again')
    assert.ok(again.attempt.authorizeUrl.startsWith(`${gatewayOrigin}/agent-work/auth/desktop/start?`))
    await approveInBrowser(again.attempt.authorizeUrl, 'alice')
    await until(s => s.status === 'credential-stored', 'signed in again')
  })
})
