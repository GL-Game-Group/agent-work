/**
 * GET /agent-work/models: the company models GL Work (on Orca) runs its coding CLIs on, for a
 * signed-in desktop only, and only what the member holds an active key for.
 */
import assert from 'node:assert/strict'
import { request as httpRequest, createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import { memoryStore } from './memory.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import type { Actor } from '../src/services.ts'

const SECRET_KEY = Buffer.alloc(32, 5).toString('base64')

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: text }) })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('company models for GL Work', () => {
  const store = memoryStore()
  let rt: Runtime
  let service: Server
  let port = 0
  let admin: Actor
  const token: Record<string, string> = {}
  const models = async (credential: string) => get(port, '/agent-work/models', { authorization: `Bearer ${credential}` })

  before(async () => {
    for (const [name, id] of [['wuming', 1], ['alice', 2], ['bob', 3]] as const) {
      await store.addMember({ name, githubId: id, githubLogin: name, role: name === 'wuming' ? 'admin' : 'member' })
    }
    token.alice = (await store.issueCredential('alice', 'device', 'MacBook', 60_000)).token
    token.bob = (await store.issueCredential('bob', 'device', 'MacBook', 60_000)).token
    token.phone = (await store.issueCredential('alice', 'phone', 'iPhone', 60_000)).token
    const config: GatewayConfig = {
      publicOrigin: 'https://agent.example.com', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false,
      github: { clientId: 'x', clientSecret: 'x', org: '', webUrl: 'http://github.invalid', apiUrl: 'http://github.invalid' }, secretKey: SECRET_KEY,
    }
    rt = await createRuntime(config, { store, authRateLimit: { requests: 1000, windowMs: 60_000 } })
    admin = { member: (await store.member('wuming'))!, ip: null }
    service = createServer((req, res) => { void rt.gateway(req, res) })
    port = await listen(service)
    await rt.admin.addKey(admin, { vendor: 'deepseek', label: '主账号', key: 'sk-deepseek-0123456789' })
    await rt.admin.addKey(admin, { vendor: 'qwen', label: '百炼', key: 'sk-qwen-0123456789' })
    await rt.admin.setModels(admin, 'qwen', [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' }, 'qwen-max'])
    await rt.admin.addKey(admin, { vendor: 'qwen-voice', label: '语音', key: 'sk-voice-0123456789', mode: 'dedicated', member: 'alice' })
    await rt.admin.setMemberVendors(admin, 'alice', ['deepseek', 'qwen', 'codex', { vendor: 'qwen-voice', mode: 'dedicated' }])
  })

  after(() => {
    service.closeAllConnections()
    service.close()
  })

  it('lists the key vendors a member holds, with the gateway to call them at, and no keys', async () => {
    const reply = await models(token.alice ?? '')
    assert.equal(reply.status, 200)
    assert.deepEqual(JSON.parse(reply.body), {
      vendors: [
        {
          vendor: 'deepseek', name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://agent.example.com/agent-work/llm/deepseek',
          models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
        },
        {
          vendor: 'qwen', name: '千问', protocol: 'openai', baseUrl: 'https://agent.example.com/agent-work/llm/qwen',
          models: [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' }, { id: 'qwen-max', name: 'qwen-max' }],
        },
      ],
    }, 'subscription vendors (codex) and voice vendors stay out')
    assert.doesNotMatch(reply.body, /sk-/u)
  })

  it('offers nothing a member was not given, or whose key is switched off', async () => {
    assert.deepEqual(JSON.parse((await models(token.bob ?? '')).body), { vendors: [] })
    const qwenKey = (await rt.admin.keys()).find(k => k.vendor === 'qwen')
    await rt.admin.setKeyStatus(admin, qwenKey?.id ?? '', 'disabled')
    const vendors = (JSON.parse((await models(token.alice ?? '')).body) as { vendors: { vendor: string }[] }).vendors
    assert.deepEqual(vendors.map(v => v.vendor), ['deepseek'])
    await rt.admin.setKeyStatus(admin, qwenKey?.id ?? '', 'active')
  })

  it('answers signed-in desktops only', async () => {
    assert.equal((await get(port, '/agent-work/models')).status, 401)
    assert.equal((await models('forged-token')).status, 401)
    // A phone is refused before it gets here; an internal key is not a desktop either.
    assert.notEqual((await models(token.phone ?? '')).status, 200)
    const issued = await rt.self.issueKey({ member: (await store.member('alice'))!, ip: null }, '脚本')
    assert.equal((await models(issued.token)).status, 403)
    await rt.admin.setStatus(admin, 'alice', 'disabled')
    assert.equal((await models(token.alice ?? '')).status, 401)
  })
})
