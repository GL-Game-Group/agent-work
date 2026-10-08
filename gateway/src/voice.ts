/**
 * Voice for GL Work for iOS: speech recognition and read-aloud by the voice
 * vendors (千问语音 on Alibaba Model Studio, 火山语音 on Volcengine), which
 * the phone reaches directly.
 *
 * The phone asks the company service for what to authenticate with: for
 * 千问语音 a short-lived temporary API key traded here with the member's own
 * key; for 火山语音 the API Key itself (豆包语音's new console has no temporary
 * token for it; the owner chose on 2026-10-08 to hand phones a key made for
 * GL Work alone, see CLAUDE.md). Either way it comes with an expiry the phone
 * asks again after, so a replaced key or a disabled member stops within that
 * time; a disabled member, a revoked phone or a removed assignment gets none.
 * Requests are counted per member and hour. The vendors' voices come from their official voice lists,
 * fetched on demand; administrators choose which ones members see.
 */
import type { Store } from './db.ts'
import type { Sql } from './sql.ts'
import { Refusal } from './errors.ts'
import { volcengineApiKey, type Vendor, type Vendors } from './vendors.ts'

const HOUR_MS = 60 * 60 * 1000
const MODEL_ID = /^[\w.:/@+-]{1,128}$/u
const VOICE_ID = /^[\w.-]{1,128}$/u
/** Official voice lists (server-rendered pages the parsers below read). */
export const VOICE_LIST_URL: Record<string, string> = {
  dashscope: 'https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list',
  volcengine: 'https://www.volcengine.com/api/doc/getDocDetail?LibraryID=6561&DocumentID=1257544&type=online',
}

export interface VoiceVendorSettings {
  /** Offer speech recognition (语音输入) with this vendor. */
  asr: boolean
  asrModel: string
  /** Offer read-aloud (播报) with this vendor. */
  tts: boolean
  ttsModel: string
}

export interface VoiceSettings {
  vendors: Record<string, VoiceVendorSettings>
  /** How long a vendor token the phone gets lives. */
  tokenTtlSeconds: number
  /** Vendor tokens one member may get per hour (all vendors). */
  tokensPerHour: number
}

/** The models each vendor starts with; administrators change them under 语音. */
const DEFAULT_MODELS: Record<string, { asrModel: string; ttsModel: string }> = {
  // Read-aloud over HTTP (multimodal-generation, up to 600 characters a request); recognition realtime.
  dashscope: { asrModel: 'qwen3-asr-flash-realtime', ttsModel: 'qwen3-tts-flash' },
  volcengine: { asrModel: 'volc.seedasr.sauc.duration', ttsModel: 'seed-tts-2.0' },
}
const DEFAULTS = { tokenTtlSeconds: 600, tokensPerHour: 60 }

/**
 * Where a voice stands: `available` on the official list only, `enabled` added and shown to
 * members, `disabled` added but hidden for now.
 */
export type VoiceState = 'available' | 'enabled' | 'disabled'
const VOICE_STATES: readonly VoiceState[] = ['available', 'enabled', 'disabled']

export interface VoiceEntry {
  vendor: string
  id: string
  name: string
  description: string | null
  gender: 'female' | 'male' | null
  languages: string | null
  /** The list it is under on the vendor's page (豆包语音合成模型2.0…). */
  family: string | null
  /** Synthesis models that speak with it. */
  models: string[]
  /** The vendor's own sample, when its list has one. */
  sampleUrl: string | null
  state: VoiceState
}

type ParsedVoice = Omit<VoiceEntry, 'vendor' | 'state'>

/** What the phone authenticates to a voice vendor with. */
export interface VoiceToken {
  vendor: string
  protocol: 'dashscope' | 'volcengine'
  /**
   * `temporary`: a short-lived vendor token (千问: `Authorization: Bearer <token>`).
   * `api-key`: the vendor key itself (火山: `X-Api-Key: <token>` beside `X-Api-Resource-Id`).
   */
  auth: 'temporary' | 'api-key'
  token: string
  /** Always null now (the old Volcengine console's app id); kept for clients that read it. */
  appId: string | null
  /** Ask again after this (ms since epoch). */
  expiresAt: number
}

interface CatalogRow {
  vendor: string; id: string; name: string; description: string | null; gender: 'female' | 'male' | null; languages: string | null
  family: string | null; models: string; sample_url: string | null; state: VoiceState
}

function plainText(html: string): string {
  return html.replace(/<br\s*\/?>/gu, '、').replace(/<[^>]+>/gu, '').replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&')
    .replace(/、{2,}/gu, '、').replace(/\s+/gu, ' ').trim()
}

function genderOf(text: string): 'female' | 'male' | null {
  if (/女|female/iu.test(text)) return 'female'
  if (/男|(?:^|_)male/iu.test(text)) return 'male'
  return null
}

/**
 * The 千问 (Qwen-TTS) voices on Alibaba's voice list page: one table row per
 * voice with its `voice` parameter, name, description, sample and models.
 */
export function parseDashscopeVoices(page: string): ParsedVoice[] {
  // The page carries its content twice, once as escaped JSON; read either.
  const html = page.replace(/\\"/gu, '"').replace(/\\n/gu, '\n')
  const voices = new Map<string, ParsedVoice>()
  const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/gu
  const marks: { at: number; title: string }[] = []
  for (const m of html.matchAll(heading)) marks.push({ at: m.index, title: plainText(m[1] as string) })
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)) {
    const cells = [...(row[1] as string).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gu)].map(c => c[1] as string)
    if (cells.length < 4) continue
    const id = /<code>([^<]+)<\/code>/u.exec(cells[0] as string)?.[1]?.trim()
    if (id === undefined || !VOICE_ID.test(id)) continue
    const detail = cells[1] as string
    const name = /音色名<\/strong>：([^<]+)/u.exec(detail)?.[1]?.trim() ?? id
    const description = /描述<\/strong>：([^<]+)/u.exec(detail)?.[1]?.trim() ?? null
    const sampleUrl = /<audio[^>]*src="(https:\/\/[^"]+)"/u.exec(detail)?.[1] ?? null
    const models = [...(cells[3] as string).matchAll(/qwen[\w.-]*tts[\w.-]*/gu)].map(m => m[0])
    const family = marks.filter(h => h.at < row.index).at(-1)?.title ?? null
    const known = voices.get(id)
    if (known !== undefined) {
      known.models = [...new Set([...known.models, ...models])]
      continue
    }
    voices.set(id, {
      id, name, description, gender: genderOf(description ?? ''), languages: plainText(cells[2] as string) || null,
      family, models: [...new Set(models)], sampleUrl,
    })
  }
  return [...voices.values()]
}

/** The synthesis model (Volcengine's resource id) a 豆包 voice list stands for. */
function volcengineModel(family: string): string | null {
  if (/2\.0/u.test(family)) return 'seed-tts-2.0'
  if (/1\.0/u.test(family)) return 'seed-tts-1.0'
  return null
}

/**
 * The 豆包语音 voices on Volcengine's voice list (its documentation API, as
 * Markdown): every table with a `voice_type` column, under the heading that
 * names its model. Voices of the realtime dialogue models are left out.
 */
export function parseVolcengineVoices(body: string): ParsedVoice[] {
  let markdown: string
  try {
    markdown = String((JSON.parse(body) as { Result?: { MDContent?: unknown } }).Result?.MDContent ?? '')
  } catch {
    return []
  }
  const voices = new Map<string, ParsedVoice>()
  const lines = markdown.split('\n')
  let family = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (/^#{1,3}\s/u.test(line)) {
      const title = line.replace(/^#+\s*/u, '').replace(/[*"“”\\]/gu, '').replace(/\s+/gu, ' ').trim()
      // Sub-headings inside a list (情感参数…) keep the list's model.
      if (/音色列表/u.test(title)) family = title.replace(/\s*音色列表$/u, '')
      continue
    }
    if (!line.startsWith('|') || !(lines[i + 1] ?? '').startsWith('|---')) continue
    const header = line.split('|').map(cell => cell.replace(/\*/gu, '').trim())
    const at = (name: RegExp) => header.findIndex(cell => name.test(cell))
    const idAt = at(/^voice_type$/u)
    const nameAt = at(/音色名称/u)
    const languageAt = at(/^语种/u)
    if (idAt < 0 || nameAt < 0 || family.startsWith('端到端')) continue
    const model = volcengineModel(family)
    for (i += 2; i < lines.length && (lines[i] as string).startsWith('|'); i++) {
      const cells = (lines[i] as string).split('|').map(cell => cell.trim())
      const id = (cells[idAt] ?? '').replace(/\\/gu, '')
      if (!VOICE_ID.test(id) || voices.has(id)) continue
      const name = plainText((cells[nameAt] ?? '').replace(/\\/gu, '')) || id
      voices.set(id, {
        id, name, description: (cells[1] ?? '') === '' ? null : plainText(cells[1] as string), gender: genderOf(id),
        languages: languageAt < 0 ? null : plainText(cells[languageAt] ?? '') || null,
        family: family || null, models: model === null ? [] : [model], sampleUrl: null,
      })
    }
    i -= 1
  }
  return [...voices.values()]
}

/** A voice's sample: the vendor's own recording, or a sentence synthesized with a company key. */
export interface VoiceSample {
  contentType: string
  body: Uint8Array
}

const SAMPLE_CACHE_LIMIT = 300
const MAX_SAMPLE_BYTES = 5 * 1024 * 1024

/**
 * One Volcengine V3 synthesis (HTTP chunked): a JSON object per chunk, audio as base64 in `data`,
 * code 20000000 at the end. @returns the MP3 bytes.
 */
export async function volcengineSynthesize(
  fetchImpl: typeof fetch, base: string, apiKey: string, model: string, speaker: string, text: string,
): Promise<Uint8Array> {
  const response = await fetchImpl(`${base}/api/v3/tts/unidirectional`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {
      'content-type': 'application/json', 'x-api-key': apiKey,
      'x-api-resource-id': model, 'x-api-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({ user: { uid: 'glwork-console' }, req_params: { text, speaker, audio_params: { format: 'mp3', sample_rate: 24000 } } }),
  })
  const raw = await response.text()
  const chunks: Buffer[] = []
  let failure: string | undefined
  // Chunks are JSON objects one after another (usually one per line).
  for (const part of raw.split(/\r?\n|(?<=\})(?=\{)/u)) {
    const line = part.trim()
    if (line === '') continue
    let item: { code?: unknown; message?: unknown; data?: unknown }
    try { item = JSON.parse(line) as typeof item } catch { continue }
    if (typeof item.data === 'string' && item.data !== '') chunks.push(Buffer.from(item.data, 'base64'))
    if (item.code !== 0 && item.code !== 20000000 && item.code !== undefined) failure = `${String(item.code)} ${String(item.message ?? '')}`.trim()
  }
  if (!response.ok || failure !== undefined || chunks.length === 0) {
    throw new Refusal(502, `火山语音合成失败（${failure ?? String(response.status)}），请检查 Key 是否开通了 ${model}`)
  }
  return Buffer.concat(chunks)
}

export class Voice {
  private readonly db: Sql
  private readonly vendors: Vendors
  private readonly now: () => number
  private readonly samples = new Map<string, VoiceSample>()

  constructor(store: Store, vendors: Vendors, now: () => number = Date.now) {
    this.db = store.sql
    this.vendors = vendors
    this.now = now
  }

  /** The built-in voice vendors (千问语音, 火山语音). */
  async voiceVendors(): Promise<Vendor[]> {
    return (await this.vendors.listVendors()).filter(v => v.type === 'voice')
  }

  private async voiceVendor(id: string): Promise<Vendor> {
    const vendor = await this.vendors.vendor(id)
    if (vendor?.type !== 'voice') throw new Refusal(404, `没有语音厂商 ${id}`)
    return vendor
  }

  async settings(): Promise<VoiceSettings> {
    const row = await this.db.one<{ value: string }>(`select value from app_settings where key = 'voice'`)
    const saved = row === undefined ? {} : JSON.parse(row.value) as Partial<VoiceSettings>
    const vendors: Record<string, VoiceVendorSettings> = {}
    for (const vendor of await this.voiceVendors()) {
      const models = DEFAULT_MODELS[vendor.protocol ?? ''] ?? { asrModel: '', ttsModel: '' }
      vendors[vendor.id] = { asr: false, tts: false, ...models, ...saved.vendors?.[vendor.id] }
    }
    return {
      vendors,
      tokenTtlSeconds: saved.tokenTtlSeconds ?? DEFAULTS.tokenTtlSeconds,
      tokensPerHour: saved.tokensPerHour ?? DEFAULTS.tokensPerHour,
    }
  }

  /** @param input - any of the settings; vendors by id, each with any of its fields. */
  async setSettings(input: Record<string, unknown>): Promise<VoiceSettings> {
    const next = await this.settings()
    if (input.vendors !== undefined) {
      if (typeof input.vendors !== 'object' || input.vendors === null) throw new Refusal(400, '语音设置格式不正确')
      for (const [id, raw] of Object.entries(input.vendors as Record<string, unknown>)) {
        const current = next.vendors[id]
        if (current === undefined) throw new Refusal(404, `没有语音厂商 ${id}`)
        const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
        for (const flag of ['asr', 'tts'] as const) {
          if (fields[flag] !== undefined) current[flag] = fields[flag] === true
        }
        for (const field of ['asrModel', 'ttsModel'] as const) {
          if (fields[field] === undefined) continue
          const model = typeof fields[field] === 'string' ? fields[field].trim() : ''
          if (!MODEL_ID.test(model)) throw new Refusal(400, `模型名不正确：${model.slice(0, 40)}`)
          current[field] = model
        }
      }
    }
    if (input.tokenTtlSeconds !== undefined) {
      const ttl = Number(input.tokenTtlSeconds)
      // 1800 s is the longest Alibaba's temporary keys live.
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 1800) throw new Refusal(400, '令牌有效期要在 60–1800 秒之间')
      next.tokenTtlSeconds = ttl
    }
    if (input.tokensPerHour !== undefined) {
      const limit = Number(input.tokensPerHour)
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Refusal(400, '每小时换取次数要在 1–1000 之间')
      next.tokensPerHour = limit
    }
    await this.db.run(`insert into app_settings (key, value) values ('voice', ?) on conflict (key) do update set value = excluded.value`, [JSON.stringify(next)])
    return next
  }

  /** The voices of one vendor, or of all, in the vendor's order. */
  async catalog(vendor?: string): Promise<VoiceEntry[]> {
    const rows = vendor === undefined
      ? await this.db.query<CatalogRow>('select * from voice_catalog order by vendor, position')
      : await this.db.query<CatalogRow>('select * from voice_catalog where vendor = ? order by position', [vendor])
    return rows.map(row => ({
      vendor: row.vendor, id: row.id, name: row.name, description: row.description, gender: row.gender, languages: row.languages,
      family: row.family, models: JSON.parse(row.models) as string[], sampleUrl: row.sample_url, state: row.state,
    }))
  }

  /** When a vendor's voices were last fetched. */
  async catalogAt(vendor: string): Promise<number | null> {
    const row = await this.db.one<{ at: number | null }>('select max(updated_at) as at from voice_catalog where vendor = ?', [vendor])
    return row?.at ?? null
  }

  /**
   * Read a vendor's official voice list again. Voices keep their state; new ones (all of
   * them on the first fetch) are `available` until an administrator adds them.
   * A page the parser cannot read leaves the list as it was.
   */
  async refreshCatalog(id: string, fetchImpl: typeof fetch = fetch): Promise<{ voices: number; added: number }> {
    const vendor = await this.voiceVendor(id)
    const url = VOICE_LIST_URL[vendor.protocol ?? '']
    if (url === undefined) throw new Refusal(400, `${vendor.name} 没有官方音色列表`)
    let body: string
    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (GL Work voice list)', 'accept': 'text/html,application/json' }, signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Refusal(502, `官方音色列表返回 ${String(response.status)}`)
      body = await response.text()
    } catch (error) {
      if (Refusal.is(error)) throw error
      throw new Refusal(502, `无法连接 ${new URL(url).host}`)
    }
    const voices = vendor.protocol === 'dashscope' ? parseDashscopeVoices(body) : parseVolcengineVoices(body)
    if (voices.length === 0) throw new Refusal(502, `没能从 ${vendor.name} 的官方页面读出音色，页面可能改版了；音色列表保持不变`)
    return this.db.transaction(async (tx) => {
      const before = new Map((await this.catalog(id)).map(v => [v.id, v.state]))
      const now = this.now()
      await tx.run('delete from voice_catalog where vendor = ?', [id])
      for (const [position, v] of voices.entries()) {
        const state = before.get(v.id) ?? 'available'
        // `enabled` mirrors the state for an older service (schema step 3).
        await tx.run(`insert into voice_catalog (vendor, id, name, description, gender, languages, family, models, sample_url, state, enabled, position, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, v.id, v.name, v.description, v.gender, v.languages, v.family, JSON.stringify(v.models), v.sampleUrl, state, state === 'enabled' ? 1 : 0, position, now])
      }
      return { voices: voices.length, added: voices.filter(v => !before.has(v.id)).length }
    })
  }

  /**
   * Add a voice (`enabled`), hide it for now (`disabled`) or show it again (`enabled`).
   * A voice once added is not taken back to `available`.
   * @returns the voice as it now stands.
   */
  async setVoiceState(vendor: string, voiceId: unknown, state: unknown): Promise<VoiceEntry> {
    await this.voiceVendor(vendor)
    if (typeof state !== 'string' || !VOICE_STATES.includes(state as VoiceState)) throw new Refusal(400, '音色状态只能是启用或停用')
    const voice = (await this.catalog(vendor)).find(v => v.id === voiceId)
    if (voice === undefined) throw new Refusal(404, `没有音色 ${String(voiceId).slice(0, 60)}`)
    if (state === 'available' && voice.state !== 'available') throw new Refusal(400, '已添加的音色只能启用或停用')
    await this.db.run('update voice_catalog set state = ?, enabled = ? where vendor = ? and id = ?', [state, state === 'enabled' ? 1 : 0, vendor, voice.id])
    return { ...voice, state: state as VoiceState }
  }

  /** The member's usable key for a voice vendor, if any. */
  private async keyFor(member: string, vendor: Vendor): Promise<string | undefined> {
    const assignment = await this.vendors.assignment(member, vendor.id)
    if (assignment?.apiKey === null || assignment?.apiKey === undefined) return undefined
    return (await this.vendors.key(assignment.apiKey))?.status === 'active' ? assignment.apiKey : undefined
  }

  /** What the phone offers this member: the vendors switched on that the member holds a key for, with their voices. */
  async forMember(member: string) {
    const settings = await this.settings()
    const vendors = []
    for (const vendor of await this.voiceVendors()) {
      const s = settings.vendors[vendor.id]
      if (s === undefined || (!s.asr && !s.tts) || await this.keyFor(member, vendor) === undefined) continue
      const voices = (await this.catalog(vendor.id))
        .filter(v => v.state === 'enabled' && (v.models.length === 0 || v.models.includes(s.ttsModel)))
        .map(({ id, name, description, gender, languages, family, sampleUrl }) => ({ id, name, description, gender, languages, family, sampleUrl }))
      vendors.push({
        id: vendor.id, name: vendor.name, protocol: vendor.protocol,
        asr: s.asr ? { model: s.asrModel } : null,
        tts: s.tts ? { model: s.ttsModel, voices } : null,
      })
    }
    return { tokenTtlSeconds: settings.tokenTtlSeconds, vendors }
  }

  /**
   * Trade the member's key for a vendor token the phone uses directly.
   * Refused when the vendor is switched off, the member has no key for it, or
   * the hour's trades are used up.
   */
  /**
   * A voice's sample for the console: the vendor's own recording when its list has one
   * (fetched here, so the console plays it from its own origin), otherwise one sentence
   * synthesized with one of the vendor's active keys. Kept in memory once made.
   */
  async sample(vendorId: string, voiceId: string, fetchImpl: typeof fetch = fetch): Promise<VoiceSample> {
    const key = `${vendorId}/${voiceId}`
    const cached = this.samples.get(key)
    if (cached !== undefined) return cached
    const vendor = await this.voiceVendor(vendorId)
    const voice = (await this.catalog(vendor.id)).find(v => v.id === voiceId)
    if (voice === undefined) throw new Refusal(404, `${vendor.name} 没有音色 ${voiceId}`)
    let sample: VoiceSample
    try {
      if (voice.sampleUrl !== null) {
        const response = await fetchImpl(voice.sampleUrl, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Refusal(502, `官方试听音频返回 ${String(response.status)}`)
        const body = new Uint8Array(await response.arrayBuffer())
        if (body.byteLength > MAX_SAMPLE_BYTES) throw new Refusal(502, '官方试听音频太大')
        sample = { contentType: response.headers.get('content-type')?.startsWith('audio/') === true ? response.headers.get('content-type') as string : 'audio/wav', body }
      } else if (vendor.protocol === 'volcengine') {
        const keyId = (await this.vendors.listKeys(vendor.id)).find(k => k.status === 'active')?.id
        if (keyId === undefined) throw new Refusal(409, `先在“API Key”里给 ${vendor.name} 录入一个 Key，才能现场合成试听`)
        const apiKey = volcengineApiKey(await this.vendors.keySecret(keyId))
        if (apiKey === undefined) throw new Refusal(502, `${vendor.name} 的 Key 是旧版控制台的，请换成新版控制台的 API Key`)
        const model = voice.models[0] ?? (await this.settings()).vendors[vendor.id]?.ttsModel ?? 'seed-tts-2.0'
        const body = await volcengineSynthesize(fetchImpl, vendor.baseUrl ?? '', apiKey, model, voice.id, `你好，我是${voice.name}，很高兴为你朗读 Agent 的回复。`)
        sample = { contentType: 'audio/mpeg', body }
      } else {
        throw new Refusal(404, `${voice.name} 没有官方试听`)
      }
    } catch (error) {
      if (Refusal.is(error)) throw error
      throw new Refusal(502, `无法获取 ${voice.name} 的试听`)
    }
    if (this.samples.size >= SAMPLE_CACHE_LIMIT) this.samples.delete(this.samples.keys().next().value as string)
    this.samples.set(key, sample)
    return sample
  }

  async issueToken(member: string, vendorId: unknown, fetchImpl: typeof fetch = fetch): Promise<VoiceToken> {
    const vendor = await this.voiceVendor(typeof vendorId === 'string' ? vendorId : '')
    const settings = await this.settings()
    const s = settings.vendors[vendor.id]
    if (s === undefined || (!s.asr && !s.tts)) throw new Refusal(403, `${vendor.name} 没有开放`)
    const keyId = await this.keyFor(member, vendor)
    if (keyId === undefined) throw new Refusal(403, `你还没有分配 ${vendor.name} 的 Key，请联系管理员`)
    const now = this.now()
    const recent = await this.db.one<{ n: number }>('select count(*) as n from voice_tokens where member = ? and at > ?', [member, now - HOUR_MS])
    if ((recent?.n ?? 0) >= settings.tokensPerHour) throw new Refusal(429, '语音用得太频繁，请稍后再试')
    const secret = await this.vendors.keySecret(keyId)
    const ttl = settings.tokenTtlSeconds
    const base = vendor.baseUrl ?? ''
    let token: VoiceToken
    try {
      if (vendor.protocol === 'dashscope') {
        const response = await fetchImpl(`${base}/api/v1/tokens?expire_in_seconds=${String(ttl)}`, {
          method: 'POST', headers: { authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Refusal(502, `${vendor.name} 拒绝换取令牌（${String(response.status)}），请检查 Key`)
        const body = await response.json() as { token?: unknown; expires_at?: unknown }
        if (typeof body.token !== 'string') throw new Refusal(502, `${vendor.name} 没有返回令牌`)
        const expiresAt = typeof body.expires_at === 'number' ? body.expires_at * 1000 : now + ttl * 1000
        token = { vendor: vendor.id, protocol: 'dashscope', auth: 'temporary', token: body.token, appId: null, expiresAt }
      } else if (vendor.protocol === 'volcengine') {
        // The key itself, made for GL Work alone; the expiry only sets when the phone asks again.
        const apiKey = volcengineApiKey(secret)
        if (apiKey === undefined) throw new Refusal(502, `${vendor.name} 的 Key 是旧版控制台的，请管理员换成新版控制台的 API Key`)
        token = { vendor: vendor.id, protocol: 'volcengine', auth: 'api-key', token: apiKey, appId: null, expiresAt: now + ttl * 1000 }
      } else {
        throw new Refusal(500, `${vendor.name} 的接口类型不支持语音`)
      }
    } catch (error) {
      if (Refusal.is(error)) throw error
      throw new Refusal(502, `无法连接 ${vendor.name}`)
    }
    await this.db.run('insert into voice_tokens (member, vendor, at) values (?, ?, ?)', [member, vendor.id, now])
    await this.db.run('delete from voice_tokens where at < ?', [now - 24 * HOUR_MS])
    return token
  }

  /** Vendor tokens issued per member and vendor since a time (for the console). */
  async tokensSince(since: number): Promise<{ member: string; vendor: string; count: number }[]> {
    return this.db.query('select member, vendor, count(*) as count from voice_tokens where at > ? group by member, vendor order by member, vendor', [since])
  }
}
