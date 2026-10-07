/** Model gateway and managed config against fake DeepSeek Messages and OpenAI-compatible upstreams. */
import assert from 'node:assert/strict'
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import type { Store } from '../src/db.ts'
import { memoryStore } from './memory.ts'
import { GitHub } from '../src/github.ts'
import { SecretBox } from '../src/secrets.ts'
import { MODEL_KEY_REF, createGateway } from '../src/server.ts'
import { Vendors } from '../src/vendors.ts'

const SECRET_KEY = Buffer.alloc(32, 7).toString('base64')

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => { server.listen(port, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"deepseek-flash","usage":{"input_tokens":120,"cache_read_input_tokens":80,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

const OPENAI_SSE = [
  'data: {"id":"c1","model":"qwen-plus","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n',
  'data: {"id":"c1","model":"qwen-plus","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c1","model":"qwen-plus","choices":[],"usage":{"prompt_tokens":300,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":200}}}\n\n',
  'data: [DONE]\n\n',
]

function openai(request: { stream?: boolean }, res: import('node:http').ServerResponse): void {
  if (request.stream === true) { res.writeHead(200, { 'content-type': 'text/event-stream' }).end(OPENAI_SSE.join('')); return }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c2', model: 'qwen-plus', usage: { prompt_tokens: 50, completion_tokens: 7 } }))
}

describe('model gateway', () => {
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = []
  const upstream = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.url === '/anthropic/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}'); return }
      if (req.url?.startsWith('/compatible-mode/') === true) { openai(JSON.parse(body) as { stream?: boolean }, res); return }
      if (JSON.parse(body).stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'upstream=1' })
        // Split events across chunk boundaries the way a network does.
        const all = SSE.join('')
        for (let i = 0; i < all.length; i += 37) res.write(all.slice(i, i + 37))
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'm2', model: 'deepseek-pro', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3 } }))
    })
  })
  const store = memoryStore()
  const bare = memoryStore()
  const vendors = new Vendors(store, SecretBox.fromEncoded(SECRET_KEY))
  let upstreamOrigin = ''
  let gateway: Server
  let unconfigured: Server
  let port = 0
  let unconfiguredPort = 0
  let device = ''
  let browser = ''

  before(async () => {
    const upstreamPort = await listen(upstream)
    upstreamOrigin = `http://127.0.0.1:${String(upstreamPort)}`
    await store.addMember({ name: 'alice', githubId: 1, githubLogin: 'alice', role: 'member' })
    await store.addMember({ name: 'bob', githubId: 2, githubLogin: 'bob', role: 'member' })
    await bare.addMember({ name: 'alice', githubId: 1, githubLogin: 'alice', role: 'member' })
    device = (await store.issueCredential('alice', 'device', 'test', 60_000)).token
    browser = (await store.issueCredential('alice', 'browser', 'test', 60_000)).token
    const github = { clientId: 'x', clientSecret: 'x', org: '', webUrl: 'http://127.0.0.1:9', apiUrl: 'http://127.0.0.1:9' }
    const base: GatewayConfig = { publicOrigin: 'https://agent.example', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false, github, secretKey: SECRET_KEY }
    // The pre-v3 environment key is imported once, with DeepSeek enabled for the members of the day.
    gateway = createGateway({ config: { ...base, deepseek: { baseUrl: `${upstreamOrigin}/anthropic`, apiKey: 'sk-company' } }, store, github: new GitHub(github) })
    unconfigured = createGateway({ config: base, store: bare, github: new GitHub(github) })
    port = await listen(gateway)
    unconfiguredPort = await listen(unconfigured)
  })

  after(async () => { gateway.close(); unconfigured.close(); upstream.close(); await store.close(); await bare.close() })

  const messages = (body: object, headers: Record<string, string>) =>
    send(port, 'POST', '/agent-work/llm/deepseek/v1/messages?beta=1', { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, JSON.stringify(body))

  it('forwards with the company key and records usage from a JSON response', async () => {
    assert.deepEqual((await vendors.assignments()).map(a => a.member), ['alice', 'bob'], 'imported for every member')
    const reply = await messages({ model: 'deepseek-v4-pro', messages: [] }, { 'x-api-key': device, 'cookie': 'a=b' })
    assert.equal(reply.status, 200)
    assert.equal(JSON.parse(reply.body).id, 'm2')
    const request = seen.at(-1)
    assert.equal(request?.url, '/anthropic/v1/messages?beta=1')
    assert.equal(request?.headers['x-api-key'], 'sk-company')
    assert.equal(request?.headers.authorization, undefined)
    assert.equal(request?.headers.cookie, undefined)
    assert.equal(request?.headers['anthropic-version'], '2023-06-01')
    assert.deepEqual(JSON.parse(request?.body ?? '{}'), { model: 'deepseek-v4-pro', messages: [] })
    assert.equal((await store.usageByKeySince(0))[0]?.requests, 1, 'usage is counted per key too')
    assert.deepEqual(await store.usageSince(0), [{ member: 'alice', requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 3 }])
  })

  it('streams events through unchanged and records their final usage', async () => {
    const reply = await messages({ model: 'deepseek-flash', stream: true, messages: [] }, { 'x-api-key': device })
    assert.equal(reply.body, SSE.join(''))
    assert.equal(reply.headers['set-cookie'], undefined)
    const totals = (await store.usageSince(0))[0]
    assert.deepEqual([totals?.requests, totals?.inputTokens, totals?.outputTokens, totals?.cacheReadTokens], [2, 130, 47, 80])
  })

  it('passes other endpoints without recording usage', async () => {
    const before = (await store.usageSince(0))[0]?.requests
    const reply = await send(port, 'GET', '/agent-work/llm/deepseek/v1/models', { authorization: `Bearer ${device}` })
    assert.equal(reply.status, 200)
    assert.equal((await store.usageSince(0))[0]?.requests, before)
  })

  it('refuses missing, browser and revoked credentials without calling upstream', async () => {
    const calls = seen.length
    assert.equal((await messages({}, {})).status, 401)
    assert.equal((await messages({}, { 'x-api-key': browser })).status, 401, 'browser sessions cannot spend model quota')
    const id = (await store.listCredentials('alice')).find(c => c.kind === 'device')?.id as string
    await store.revokeCredential(id)
    const revoked = await messages({}, { 'x-api-key': device })
    assert.equal(revoked.status, 401)
    assert.equal(JSON.parse(revoked.body).error.type, 'authentication_error')
    assert.equal(seen.length, calls)
    device = (await store.issueCredential('alice', 'device', 'test', 60_000)).token
  })

  it('refuses models the company has not offered without calling upstream', async () => {
    const calls = seen.length
    const reply = await messages({ model: 'deepseek-secret-preview', messages: [] }, { 'x-api-key': device })
    assert.equal(reply.status, 403)
    assert.match(JSON.parse(reply.body).error.message, /deepseek-secret-preview/u)
    assert.equal(seen.length, calls)
  })

  it('refuses members who have no vendor enabled and hands them no model config', async () => {
    const fresh = (await bare.issueCredential('alice', 'device', 'test', 60_000)).token
    assert.equal((await send(unconfiguredPort, 'POST', '/agent-work/llm/deepseek/v1/messages', { 'x-api-key': fresh, 'content-type': 'application/json' }, '{"model":"deepseek-flash"}')).status, 403)
    assert.equal((await send(unconfiguredPort, 'POST', '/agent-work/llm/nobody/v1/messages', { 'x-api-key': fresh }, '{}')).status, 404)
    const empty = JSON.parse((await send(unconfiguredPort, 'GET', '/agent-work/config', { authorization: `Bearer ${fresh}` })).body)
    assert.deepEqual(empty, { version: 2, settings: [], credentials: [], cli: [], accounts: [], public: {} })
  })

  it('serves an OpenAI-compatible vendor with its own key and allowlist', async () => {
    await vendors.updateVendor('qwen', { name: '千问', protocol: 'openai', baseUrl: `${upstreamOrigin}/compatible-mode/v1`, compat: { thinkingFormat: 'qwen' } })
    await vendors.addKey('qwen', 'team', 'sk-qwen-company')
    await vendors.setModels('qwen', [{ id: 'qwen-plus', name: 'Qwen Plus' }, 'qwen-max'])
    await vendors.setMemberVendors('alice', ['deepseek', 'qwen'])
    const chat = (body: object) => send(port, 'POST', '/agent-work/llm/qwen/chat/completions', { 'content-type': 'application/json', authorization: `Bearer ${device}` }, JSON.stringify(body))

    const json = await chat({ model: 'qwen-plus', messages: [] })
    assert.equal(json.status, 200)
    assert.equal(seen.at(-1)?.url, '/compatible-mode/v1/chat/completions')
    assert.equal(seen.at(-1)?.headers.authorization, 'Bearer sk-qwen-company')
    assert.equal(seen.at(-1)?.headers['x-api-key'], undefined)
    const streamed = await chat({ model: 'qwen-plus', stream: true, messages: [] })
    assert.equal(streamed.body, OPENAI_SSE.join(''))
    const rows = await store.sql.query("select model, input_tokens as i, output_tokens as o, cache_read_tokens as c from llm_usage where vendor = 'qwen' order by id")
    assert.deepEqual(rows.map(row => ({ ...row })), [{ model: 'qwen-plus', i: 50, o: 7, c: 0 }, { model: 'qwen-plus', i: 100, o: 9, c: 200 }])

    const refused = await chat({ model: 'qwen-turbo', messages: [] })
    assert.equal(refused.status, 403)
    assert.equal(JSON.parse(refused.body).error.type, 'permission_error', 'OpenAI-shaped error')
    const bob = (await store.issueCredential('bob', 'device', 'test', 60_000)).token
    assert.equal((await send(port, 'POST', '/agent-work/llm/qwen/chat/completions', { 'content-type': 'application/json', authorization: `Bearer ${bob}` }, '{"model":"qwen-plus"}')).status, 403, 'bob has no Qwen')

    const qwenKey = (await vendors.listKeys('qwen'))[0]?.id as string
    await vendors.setKeyStatus(qwenKey, 'disabled')
    assert.equal((await chat({ model: 'qwen-plus', messages: [] })).status, 503, 'no active key left')
    await vendors.setKeyStatus(qwenKey, 'active')
  })

  it('hands each signed-in Host its own vendors, accounts and the public config', async () => {
    await vendors.addAccount('codex', 'team-codex@example.com', null)
    await vendors.setMemberVendors('alice', ['deepseek', 'qwen', 'codex'])
    await vendors.setPublic('oss.bucket', 'gl-work-sg', false, null)
    await vendors.setPublic('oss.accessKeySecret', 'oss-secret', true, null)
    const fresh = (await store.issueCredential('alice', 'device', 'test', 60_000)).token
    assert.equal((await send(port, 'GET', '/agent-work/config')).status, 401)
    const config = JSON.parse((await send(port, 'GET', '/agent-work/config', { authorization: `Bearer ${fresh}` })).body)
    assert.deepEqual(config, {
      version: 2,
      settings: [
        { ns: 'llm-deepseek', path: ['baseURL'], value: 'https://agent.example/agent-work/llm/deepseek' },
        { ns: 'llm-deepseek', path: ['apiKeyEnv'], value: MODEL_KEY_REF },
        { ns: 'llm-deepseek', path: ['models'], value: [
          { inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only', id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ] },
        { ns: 'llm-pi-ai', path: ['providers', 'company-qwen'], value: {
          displayName: '千问', api: 'openai-completions', baseURL: 'https://agent.example/agent-work/llm/qwen', apiKeyEnv: MODEL_KEY_REF,
          models: [{ id: 'qwen-plus', name: 'Qwen Plus' }, { id: 'qwen-max' }], compat: { thinkingFormat: 'qwen' },
        } },
      ],
      credentials: [{ ref: MODEL_KEY_REF, from: 'device-token' }],
      cli: [],
      accounts: [{ vendor: 'codex', name: 'Codex', account: 'team-codex@example.com' }],
      public: { 'oss.accessKeySecret': 'oss-secret', 'oss.bucket': 'gl-work-sg' },
    })
    assert.ok(!JSON.stringify(config).includes('sk-'), 'vendor keys never leave the server')
  })
})
