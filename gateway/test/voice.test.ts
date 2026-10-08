/**
 * 语音 for GL Work for iOS: the voice vendors, their official voice lists,
 * and the short-lived vendor tokens a phone trades its member's key for —
 * against stand-ins for the vendors' pages and token endpoints.
 */
import assert from 'node:assert/strict'
import { request as httpRequest, createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import type { Store } from '../src/db.ts'
import { memoryStore } from './memory.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import type { Actor } from '../src/services.ts'
import { parseDashscopeVoices, parseVolcengineVoices } from '../src/voice.ts'

const SECRET_KEY = Buffer.alloc(32, 9).toString('base64')

/** Two voices as Alibaba's voice list page has them (the escaped JSON copy). */
function dashscopePage(voices: string[]): string {
  const rows = voices.map(id => `<tr><td style=\\"vertical-align:top\\"><p><code>${id}</code></p></td><td><p><strong>音色名</strong>：${id}名</p><p><strong>描述</strong>：温柔（${id === 'Ethan' ? '男性' : '女性'}）</p><audio src=\\"https://help-static-aliyun-doc.aliyuncs.com/${id}.wav\\" controls=\\"\\"></audio></td><td><p>中文（普通话）、英语</p></td><td><ul><li><strong>Qwen3-TTS-Flash-Realtime</strong>：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27</li><li><strong>Qwen3-TTS-Flash</strong>：qwen3-tts-flash</li></ul></td></tr>`)
  return `<script>window.__ICE_PAGE_PROPS__={"content":"<h2 id=\\"a\\">Qwen-TTS实时语音合成音色列表</h2><table><tbody>${rows.join('')}</tbody></table>"}</script>`
}

const VOLCENGINE_PAGE = JSON.stringify({
  Result: {
    MDContent: [
      '# 在线音色列表',
      '##  **"豆包语音合成模型2.0、** S2S\\-O2.0 **" 音色列表**',
      '|**场景** |**音色名称** |**voice_type** |**语种/方言** |**支持能力** |',
      '|---|---|---|---|---|',
      '|通用场景 |Vivi 2.0 |zh_female_vv_uranus_bigtts |中文 |指令遵循 |',
      '|通用场景 |云舟 2.0 |zh_male_m191_uranus_bigtts |中文 |指令遵循 |',
      '## "端到端实时语音大模型 S2S\\-O版本 "音色列表',
      '|**场景** |**音色名称** |**voice_type** |**语种** |',
      '|---|---|---|---|',
      '|通用 |对话音色 |zh_female_s2s_only |中文 |',
      '##  **"豆包语音合成模型1.0" 音色列表**',
      '### **情感参数（emotion）：** ',
      '|**场景** |**音色名称** |**voice_type** |**语种** |',
      '|---|---|---|---|',
      '|有声阅读 |反卷青年 |zh_male_fanjuanqingnian_mars_bigtts |中文 |',
    ].join('\n'),
  },
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: text }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('voice lists', () => {
  it('reads Alibaba voices with their samples, gender and models', async () => {
    const voices = parseDashscopeVoices(dashscopePage(['Cherry', 'Ethan']))
    assert.deepEqual(voices.map(v => [v.id, v.name, v.gender]), [['Cherry', 'Cherry名', 'female'], ['Ethan', 'Ethan名', 'male']])
    assert.equal(voices[0]?.sampleUrl, 'https://help-static-aliyun-doc.aliyuncs.com/Cherry.wav')
    assert.deepEqual(voices[0]?.models, ['qwen3-tts-flash-realtime', 'qwen3-tts-flash-realtime-2025-11-27', 'qwen3-tts-flash'])
    assert.equal(voices[0]?.family, 'Qwen-TTS实时语音合成音色列表')
  })

  it('reads Volcengine voices by model, without the dialogue models', async () => {
    const voices = parseVolcengineVoices(VOLCENGINE_PAGE)
    assert.deepEqual(voices.map(v => [v.id, v.models[0], v.gender]), [
      ['zh_female_vv_uranus_bigtts', 'seed-tts-2.0', 'female'],
      ['zh_male_m191_uranus_bigtts', 'seed-tts-2.0', 'male'],
      ['zh_male_fanjuanqingnian_mars_bigtts', 'seed-tts-1.0', 'male'],
    ])
    assert.equal(voices[2]?.family, '豆包语音合成模型1.0')
  })

  it('reads nothing from a page it does not know', async () => {
    assert.deepEqual(parseDashscopeVoices('<html>改版了</html>'), [])
    assert.deepEqual(parseVolcengineVoices('not json'), [])
  })
})

describe('语音 for phones', () => {
  const store = memoryStore()
  let rt: Runtime
  let service: Server
  let port = 0
  let admin: Actor
  let page = dashscopePage(['Cherry', 'Ethan'])
  /** What the vendors were asked. */
  const asked: { url: string; authorization: string | null; apiKey: string | null; appId: string | null; body: string | null }[] = []
  let vendorDown = false
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    asked.push({ url, authorization: headers.get('authorization'), apiKey: headers.get('x-api-key'), appId: headers.get('x-api-app-id'), body: typeof init?.body === 'string' ? init.body : null })
    if (url.startsWith('https://help.aliyun.com/')) return new Response(page, { status: 200 })
    if (url.startsWith('https://www.volcengine.com/api/doc/')) return new Response(VOLCENGINE_PAGE, { status: 200 })
    if (vendorDown) throw new TypeError('fetch failed')
    if (url.startsWith('https://dashscope.aliyuncs.com/api/v1/tokens')) {
      if (headers.get('authorization') !== 'Bearer sk-qwen-alice-0001') return new Response('{}', { status: 401 })
      return Response.json({ token: 'st-temporary', expires_at: 2_000_000_000 })
    }
    if (url.startsWith('https://help-static-aliyun-doc.aliyuncs.com/')) return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/x-wav' } })
    if (url === 'https://openspeech.bytedance.com/api/v3/tts/unidirectional') {
      if (headers.get('x-api-key') !== 'volc-api-key-0001') return Response.json({ code: 45000010, message: 'invalid auth' }, { status: 401 })
      const body = JSON.parse(String(init?.body)) as { req_params: { speaker: string } }
      if (body.req_params.speaker === 'zh_male_m191_uranus_bigtts') return Response.json({ code: 45000000, message: 'speaker not granted' }, { status: 400 })
      // Two audio chunks, then the end, as Volcengine streams them.
      return new Response([{ code: 0, message: '', data: Buffer.from('ID3').toString('base64') }, { code: 0, message: '', data: Buffer.from('mp3').toString('base64') }, { code: 20000000, message: 'ok', data: null }]
        .map(c => JSON.stringify(c)).join('\n'))
    }
    return new Response('not found', { status: 404 })
  }
  const phone: Record<string, string> = {}
  let device = ''
  const asPhone = (who: string) => ({ authorization: `Bearer ${phone[who] ?? ''}`, 'content-type': 'application/json' })
  const token = (who: string, vendor: string) => send(port, 'POST', '/agent-work/phone/voice/token', asPhone(who), JSON.stringify({ vendor }))

  before(async () => {
    for (const [name, id] of [['wuming', 1], ['alice', 2], ['bob', 3]] as const) {
      await store.addMember({ name, githubId: id, githubLogin: name, role: name === 'wuming' ? 'admin' : 'member' })
    }
    phone.alice = (await store.issueCredential('alice', 'phone', 'iPhone', 60_000)).token
    phone.bob = (await store.issueCredential('bob', 'phone', 'iPhone', 60_000)).token
    device = (await store.issueCredential('alice', 'device', 'MacBook', 60_000)).token
    const config: GatewayConfig = {
      publicOrigin: 'https://agent.example.com', listenHost: '127.0.0.1', listenPort: 0, trustProxy: false,
      github: { clientId: 'x', clientSecret: 'x', org: '', webUrl: 'http://github.invalid', apiUrl: 'http://github.invalid' }, secretKey: SECRET_KEY,
    }
    rt = await createRuntime(config, { store, fetch: fakeFetch, authRateLimit: { requests: 1000, windowMs: 60_000 } })
    admin = { member: (await store.member('wuming'))!, ip: null }
    service = createServer((req, res) => { void rt.gateway(req, res) })
    port = await listen(service)
  })

  after(async () => {
    service.closeAllConnections()
    service.close()
  })

  it('has the two voice vendors built in, kept out of the model gateway and the Hosts\' config', async () => {
    const voice = await rt.admin.voice()
    assert.deepEqual(voice.vendors.map(v => [v.id, v.protocol]), [['qwen-voice', 'dashscope'], ['volc-voice', 'volcengine']])
    await assert.rejects(async () => await rt.admin.deleteVendor(admin, 'qwen-voice'), /内置/u)
    await assert.rejects(async () => await rt.admin.setModels(admin, 'qwen-voice', ['x']), /语音/u)
    await assert.rejects(async () => await rt.admin.addVendor(admin, { id: 'my-voice', name: 'x', type: 'voice', auth: 'key' }), /内置/u)
    await rt.admin.addKey(admin, { vendor: 'qwen-voice', label: 'alice 语音', key: 'sk-qwen-alice-0001', mode: 'dedicated', member: 'alice' })
    // A Host's device token reaches neither the vendor through the model gateway nor its key through the config.
    const llm = await send(port, 'POST', '/agent-work/llm/qwen-voice/v1/chat/completions', { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, '{}')
    assert.equal(llm.status, 404)
    const config = await send(port, 'GET', '/agent-work/config', { authorization: `Bearer ${device}` })
    assert.doesNotMatch(config.body, /qwen-voice/u)
  })

  it('takes a Volcengine key only as the new console\'s API Key', async () => {
    // The old console's app id and access token are refused, with where to find the right key.
    await assert.rejects(async () => await rt.admin.addKey(admin, { vendor: 'volc-voice', label: 'x', key: '6123456789:volc-access-token-0001', mode: 'dedicated' }), /新版控制台的 API Key/u)
    await assert.rejects(async () => await rt.admin.addKey(admin, { vendor: 'volc-voice', label: 'x', key: 'two words', mode: 'dedicated' }), /完整的 API Key/u)
    await rt.admin.addKey(admin, { vendor: 'volc-voice', label: 'alice 火山', key: 'volc-api-key-0001', mode: 'dedicated', member: 'alice' })
  })

  it('fetches the official voice lists; later new voices wait for an administrator; a changed page changes nothing', async () => {
    assert.deepEqual(await rt.admin.refreshVoices(admin, 'qwen-voice'), { voices: 2, added: 2 })
    assert.deepEqual((await rt.admin.voice()).voices.filter(v => v.vendor === 'qwen-voice').map(v => [v.id, v.enabled]), [['Cherry', true], ['Ethan', true]])
    await rt.admin.setEnabledVoices(admin, 'qwen-voice', ['Cherry'])
    page = dashscopePage(['Cherry', 'Ethan', 'Serena'])
    assert.deepEqual(await rt.admin.refreshVoices(admin, 'qwen-voice'), { voices: 3, added: 1 })
    assert.deepEqual((await rt.admin.voice()).voices.filter(v => v.vendor === 'qwen-voice').map(v => [v.id, v.enabled]), [['Cherry', true], ['Ethan', false], ['Serena', false]])
    page = '<html>改版了</html>'
    await assert.rejects(rt.admin.refreshVoices(admin, 'qwen-voice'), /改版/u)
    assert.equal((await rt.admin.voice()).voices.filter(v => v.vendor === 'qwen-voice').length, 3)
    await rt.admin.refreshVoices(admin, 'volc-voice')
    assert.equal((await rt.admin.voice()).voices.filter(v => v.vendor === 'volc-voice').length, 3)
  })

  it('plays samples for the console: the official one, or a sentence synthesized with a company key', async () => {
    const official = await rt.admin.voiceSample('qwen-voice', 'Cherry')
    assert.deepEqual([official.contentType, [...official.body]], ['audio/x-wav', [82, 73, 70, 70]])
    asked.length = 0
    const synthesized = await rt.admin.voiceSample('volc-voice', 'zh_male_fanjuanqingnian_mars_bigtts')
    assert.deepEqual([synthesized.contentType, Buffer.from(synthesized.body).toString()], ['audio/mpeg', 'ID3mp3'])
    const call = asked.at(-1)
    assert.equal(call?.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
    // The new console's header alone: no app id.
    assert.deepEqual([call?.apiKey, call?.appId], ['volc-api-key-0001', null])
    assert.match(call?.body ?? '', /"speaker":"zh_male_fanjuanqingnian_mars_bigtts"/u)
    // Made once, then kept.
    await rt.admin.voiceSample('volc-voice', 'zh_male_fanjuanqingnian_mars_bigtts')
    assert.equal(asked.filter(a => a.url.includes('/api/v3/tts/')).length, 1)
    await assert.rejects(rt.admin.voiceSample('volc-voice', 'zh_male_m191_uranus_bigtts'), /45000000 speaker not granted/u)
    await assert.rejects(rt.admin.voiceSample('volc-voice', 'nobody'), /没有音色/u)
    await assert.rejects(rt.admin.voiceSample('deepseek', 'Cherry'), /没有语音厂商/u)
  })

  it('validates the settings', async () => {
    await assert.rejects(async () => await rt.admin.setVoiceSettings(admin, { tokenTtlSeconds: 3600 }), /60–1800/u)
    await assert.rejects(async () => await rt.admin.setVoiceSettings(admin, { tokensPerHour: 0 }), /1–1000/u)
    await assert.rejects(async () => await rt.admin.setVoiceSettings(admin, { vendors: { 'qwen-voice': { ttsModel: 'bad model' } } }), /模型名/u)
    await assert.rejects(async () => await rt.admin.setVoiceSettings(admin, { vendors: { deepseek: { tts: true } } }), /没有语音厂商/u)
  })

  it('offers a phone only what is switched on and what its member holds a key for', async () => {
    const off = JSON.parse((await send(port, 'GET', '/agent-work/phone/voice', asPhone('alice'))).body) as { vendors: unknown[] }
    assert.deepEqual(off.vendors, [])
    await rt.admin.setVoiceSettings(admin, { vendors: { 'qwen-voice': { tts: true, asr: true }, 'volc-voice': { tts: true, ttsModel: 'seed-tts-1.0' } } })
    const on = JSON.parse((await send(port, 'GET', '/agent-work/phone/voice', asPhone('alice'))).body) as
      { vendors: { id: string; asr: { model: string } | null; tts: { model: string; voices: { id: string; sampleUrl: string | null }[] } | null }[] }
    assert.deepEqual(on.vendors.map(v => [v.id, v.asr?.model ?? null, v.tts?.voices.map(x => x.id)]), [
      ['qwen-voice', 'qwen3-asr-flash-realtime', ['Cherry']],
      // Only the voices of the synthesis model chosen.
      ['volc-voice', null, ['zh_male_fanjuanqingnian_mars_bigtts']],
    ])
    assert.match(on.vendors[0]?.tts?.voices[0]?.sampleUrl ?? '', /Cherry\.wav$/u)
    // Bob holds no key: nothing to offer, no token.
    const bob = JSON.parse((await send(port, 'GET', '/agent-work/phone/voice', asPhone('bob'))).body) as { vendors: unknown[] }
    assert.deepEqual(bob.vendors, [])
    assert.equal((await token('bob', 'qwen-voice')).status, 403)
  })

  it('trades 千问\'s key for a temporary token; hands out 火山\'s API Key, to be asked for again after the expiry', async () => {
    asked.length = 0
    await rt.admin.setVoiceSettings(admin, { tokenTtlSeconds: 300 })
    const qwen = await token('alice', 'qwen-voice')
    assert.equal(qwen.status, 200)
    assert.deepEqual(JSON.parse(qwen.body), { vendor: 'qwen-voice', protocol: 'dashscope', auth: 'temporary', token: 'st-temporary', appId: null, expiresAt: 2_000_000_000_000 })
    assert.equal(asked.at(-1)?.url, 'https://dashscope.aliyuncs.com/api/v1/tokens?expire_in_seconds=300')
    assert.doesNotMatch(qwen.body, /sk-qwen-alice/u)
    const before = Date.now()
    const volc = await token('alice', 'volc-voice')
    assert.equal(volc.status, 200)
    const body = JSON.parse(volc.body) as { vendor: string; protocol: string; auth: string; token: string; appId: null; expiresAt: number }
    assert.deepEqual([body.vendor, body.protocol, body.auth, body.token, body.appId], ['volc-voice', 'volcengine', 'api-key', 'volc-api-key-0001', null])
    assert.ok(body.expiresAt >= before + 300_000 && body.expiresAt <= Date.now() + 300_000, 'the configured validity')
    // Volcengine is not asked: there is nothing to trade.
    assert.equal(asked.filter(a => a.url.startsWith('https://openspeech.bytedance.com/')).length, 0)
  })

  it('refuses tokens to the wrong credentials, switched-off vendors and unknown vendors', async () => {
    assert.equal((await send(port, 'POST', '/agent-work/phone/voice/token', { 'content-type': 'application/json' }, '{"vendor":"qwen-voice"}')).status, 401)
    assert.equal((await send(port, 'POST', '/agent-work/phone/voice/token', { authorization: 'Bearer forged-token', 'content-type': 'application/json' }, '{"vendor":"qwen-voice"}')).status, 401)
    // A Host's device token is not a phone's.
    assert.equal((await send(port, 'POST', '/agent-work/phone/voice/token', { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, '{"vendor":"qwen-voice"}')).status, 404)
    // A model vendor is not a voice vendor, even with a key.
    assert.equal((await token('alice', 'deepseek')).status, 404)
    assert.equal((await token('alice', 'nobody')).status, 404)
    await rt.admin.setVoiceSettings(admin, { vendors: { 'volc-voice': { tts: false } } })
    assert.equal((await token('alice', 'volc-voice')).status, 403)
  })

  it('stops tokens when the key goes, the vendor fails or the hour is used up', async () => {
    vendorDown = true
    assert.equal((await token('alice', 'qwen-voice')).status, 502)
    vendorDown = false
    await rt.admin.setVoiceSettings(admin, { tokensPerHour: 2 })
    assert.equal((await token('alice', 'qwen-voice')).status, 429, 'two trades this hour already')
    await rt.admin.setVoiceSettings(admin, { tokensPerHour: 60 })
    const key = (await rt.admin.keys()).find(k => k.vendor === 'qwen-voice')
    await rt.admin.setKeyStatus(admin, key?.id ?? '', 'disabled')
    assert.equal((await token('alice', 'qwen-voice')).status, 403)
    await rt.admin.setKeyStatus(admin, key?.id ?? '', 'active')
    assert.equal((await token('alice', 'qwen-voice')).status, 200)
    // 火山's key handed out as is still stops with its key.
    await rt.admin.setVoiceSettings(admin, { vendors: { 'volc-voice': { tts: true } } })
    const volcKey = (await rt.admin.keys()).find(k => k.vendor === 'volc-voice')
    await rt.admin.setKeyStatus(admin, volcKey?.id ?? '', 'disabled')
    assert.equal((await token('alice', 'volc-voice')).status, 403)
    await rt.admin.setKeyStatus(admin, volcKey?.id ?? '', 'active')
    assert.equal((await token('alice', 'volc-voice')).status, 200)
  })

  it('cuts off a disabled member and a revoked phone', async () => {
    const own = (await store.listCredentials()).find(c => c.member === 'alice' && c.kind === 'phone')
    await store.revokeCredential(own?.id ?? '')
    for (const vendor of ['qwen-voice', 'volc-voice']) assert.equal((await token('alice', vendor)).status, 401, vendor)
    phone.alice = (await store.issueCredential('alice', 'phone', 'iPhone', 60_000)).token
    assert.equal((await token('alice', 'qwen-voice')).status, 200)
    await rt.admin.setStatus(admin, 'alice', 'disabled')
    for (const vendor of ['qwen-voice', 'volc-voice']) assert.equal((await token('alice', vendor)).status, 401, vendor)
  })

  it('records the console\'s changes in the audit log', async () => {
    const actions = new Set((await store.recentAudit(200)).map(e => e.action))
    for (const action of ['voice-settings', 'voice-catalog', 'voice-voices']) assert.ok(actions.has(action), action)
    assert.deepEqual((await rt.admin.voice()).tokens.map(t => [t.member, t.vendor]), [['alice', 'qwen-voice'], ['alice', 'volc-voice']])
  })
})
