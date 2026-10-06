/**
 * Voice for GL Work for iOS: speech recognition and read-aloud by the voice
 * vendors (千问语音 on Alibaba Model Studio, 火山语音 on Volcengine), which
 * the phone reaches directly.
 *
 * The phone never holds a vendor key. It asks the company service for a
 * short-lived vendor token, traded here with the member's own key (the
 * vendor's temporary API key, or Volcengine's STS token); a disabled member,
 * a revoked phone or a removed assignment gets none. Trades are counted per
 * member and hour. The vendors' voices come from their official voice lists,
 * fetched on demand; administrators choose which ones members see.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Store } from './db.ts'
import { Refusal } from './errors.ts'
import { volcengineCredential, type Vendor, type Vendors } from './vendors.ts'

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
  dashscope: { asrModel: 'qwen3-asr-flash-realtime', ttsModel: 'qwen3-tts-flash-realtime' },
  volcengine: { asrModel: 'volc.bigasr.sauc.duration', ttsModel: 'seed-tts-2.0' },
}
const DEFAULTS = { tokenTtlSeconds: 600, tokensPerHour: 60 }

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
  enabled: boolean
}

type ParsedVoice = Omit<VoiceEntry, 'vendor' | 'enabled'>

/** A vendor token for the phone. */
export interface VoiceToken {
  vendor: string
  protocol: 'dashscope' | 'volcengine'
  token: string
  /** Volcengine's app id, which its APIs take beside the token. */
  appId: string | null
  expiresAt: number
}

interface CatalogRow {
  vendor: string; id: string; name: string; description: string | null; gender: 'female' | 'male' | null; languages: string | null
  family: string | null; models: string; sample_url: string | null; enabled: number
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

export class Voice {
  private readonly db: DatabaseSync
  private readonly vendors: Vendors
  private readonly now: () => number

  constructor(store: Store, vendors: Vendors, now: () => number = Date.now) {
    this.db = store.db
    this.vendors = vendors
    this.now = now
  }

  /** The built-in voice vendors (千问语音, 火山语音). */
  voiceVendors(): Vendor[] {
    return this.vendors.listVendors().filter(v => v.type === 'voice')
  }

  private voiceVendor(id: string): Vendor {
    const vendor = this.vendors.vendor(id)
    if (vendor?.type !== 'voice') throw new Refusal(404, `没有语音厂商 ${id}`)
    return vendor
  }

  settings(): VoiceSettings {
    const row = this.db.prepare(`select value from app_settings where key = 'voice'`).get() as { value: string } | undefined
    const saved = row === undefined ? {} : JSON.parse(row.value) as Partial<VoiceSettings>
    const vendors: Record<string, VoiceVendorSettings> = {}
    for (const vendor of this.voiceVendors()) {
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
  setSettings(input: Record<string, unknown>): VoiceSettings {
    const next = this.settings()
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
    this.db.prepare(`insert into app_settings (key, value) values ('voice', ?) on conflict (key) do update set value = excluded.value`).run(JSON.stringify(next))
    return next
  }

  /** The voices of one vendor, or of all, in the vendor's order. */
  catalog(vendor?: string): VoiceEntry[] {
    const rows = (vendor === undefined
      ? this.db.prepare('select * from voice_catalog order by vendor, position').all()
      : this.db.prepare('select * from voice_catalog where vendor = ? order by position').all(vendor)) as unknown as CatalogRow[]
    return rows.map(row => ({
      vendor: row.vendor, id: row.id, name: row.name, description: row.description, gender: row.gender, languages: row.languages,
      family: row.family, models: JSON.parse(row.models) as string[], sampleUrl: row.sample_url, enabled: row.enabled === 1,
    }))
  }

  /** When a vendor's voices were last fetched. */
  catalogAt(vendor: string): number | null {
    const row = this.db.prepare('select max(updated_at) as at from voice_catalog where vendor = ?').get(vendor) as { at: number | null }
    return row.at
  }

  /**
   * Read a vendor's official voice list again. Voices keep whether members see
   * them; the first fetch shows them all, later new ones wait for an administrator.
   * A page the parser cannot read leaves the list as it was.
   */
  async refreshCatalog(id: string, fetchImpl: typeof fetch = fetch): Promise<{ voices: number; added: number }> {
    const vendor = this.voiceVendor(id)
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
    const before = new Map(this.catalog(id).map(v => [v.id, v.enabled]))
    const first = before.size === 0
    const now = this.now()
    this.db.exec('begin')
    try {
      this.db.prepare('delete from voice_catalog where vendor = ?').run(id)
      const insert = this.db.prepare(`insert into voice_catalog (vendor, id, name, description, gender, languages, family, models, sample_url, enabled, position, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      voices.forEach((v, position) => {
        const enabled = before.get(v.id) ?? first
        insert.run(id, v.id, v.name, v.description, v.gender, v.languages, v.family, JSON.stringify(v.models), v.sampleUrl, enabled ? 1 : 0, position, now)
      })
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
    return { voices: voices.length, added: voices.filter(v => !before.has(v.id)).length }
  }

  /** Exactly which of a vendor's voices members see. */
  setEnabledVoices(vendor: string, ids: unknown): number {
    this.voiceVendor(vendor)
    if (!Array.isArray(ids) || ids.some(v => typeof v !== 'string')) throw new Refusal(400, '音色列表格式不正确')
    const wanted = new Set(ids as string[])
    this.db.exec('begin')
    try {
      this.db.prepare('update voice_catalog set enabled = 0 where vendor = ?').run(vendor)
      const enable = this.db.prepare('update voice_catalog set enabled = 1 where vendor = ? and id = ?')
      for (const id of wanted) enable.run(vendor, id)
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
    return this.catalog(vendor).filter(v => v.enabled).length
  }

  /** The member's usable key for a voice vendor, if any. */
  private keyFor(member: string, vendor: Vendor): string | undefined {
    const assignment = this.vendors.assignment(member, vendor.id)
    if (assignment?.apiKey === null || assignment?.apiKey === undefined) return undefined
    return this.vendors.key(assignment.apiKey)?.status === 'active' ? assignment.apiKey : undefined
  }

  /** What the phone offers this member: the vendors switched on that the member holds a key for, with their voices. */
  forMember(member: string) {
    const settings = this.settings()
    const vendors = []
    for (const vendor of this.voiceVendors()) {
      const s = settings.vendors[vendor.id]
      if (s === undefined || (!s.asr && !s.tts) || this.keyFor(member, vendor) === undefined) continue
      const voices = this.catalog(vendor.id)
        .filter(v => v.enabled && (v.models.length === 0 || v.models.includes(s.ttsModel)))
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
  async issueToken(member: string, vendorId: unknown, fetchImpl: typeof fetch = fetch): Promise<VoiceToken> {
    const vendor = this.voiceVendor(typeof vendorId === 'string' ? vendorId : '')
    const settings = this.settings()
    const s = settings.vendors[vendor.id]
    if (s === undefined || (!s.asr && !s.tts)) throw new Refusal(403, `${vendor.name} 没有开放`)
    const keyId = this.keyFor(member, vendor)
    if (keyId === undefined) throw new Refusal(403, `你还没有分配 ${vendor.name} 的 Key，请联系管理员`)
    const now = this.now()
    const recent = this.db.prepare('select count(*) as n from voice_tokens where member = ? and at > ?').get(member, now - HOUR_MS) as { n: number }
    if (recent.n >= settings.tokensPerHour) throw new Refusal(429, '语音用得太频繁，请稍后再试')
    const secret = this.vendors.keySecret(keyId)
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
        token = { vendor: vendor.id, protocol: 'dashscope', token: body.token, appId: null, expiresAt }
      } else if (vendor.protocol === 'volcengine') {
        const credential = volcengineCredential(secret)
        if (credential === undefined) throw new Refusal(502, `${vendor.name} 的 Key 格式不对，请重新录入`)
        const response = await fetchImpl(`${base}/api/v1/sts/token`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'authorization': `Bearer; ${credential.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ appid: credential.appId, duration: ttl }),
        })
        if (!response.ok) throw new Refusal(502, `${vendor.name} 拒绝换取令牌（${String(response.status)}），请检查 Key`)
        const body = await response.json() as { jwt_token?: unknown }
        if (typeof body.jwt_token !== 'string') throw new Refusal(502, `${vendor.name} 没有返回令牌`)
        token = { vendor: vendor.id, protocol: 'volcengine', token: body.jwt_token, appId: credential.appId, expiresAt: now + ttl * 1000 }
      } else {
        throw new Refusal(500, `${vendor.name} 的接口类型不支持语音`)
      }
    } catch (error) {
      if (Refusal.is(error)) throw error
      throw new Refusal(502, `无法连接 ${vendor.name}`)
    }
    this.db.prepare('insert into voice_tokens (member, vendor, at) values (?, ?, ?)').run(member, vendor.id, now)
    this.db.prepare('delete from voice_tokens where at < ?').run(now - 24 * HOUR_MS)
    return token
  }

  /** Vendor tokens issued per member and vendor since a time (for the console). */
  tokensSince(since: number): { member: string; vendor: string; count: number }[] {
    return (this.db.prepare('select member, vendor, count(*) as count from voice_tokens where at > ? group by member, vendor order by member, vendor').all(since) as unknown as
      { member: string; vendor: string; count: number }[]).map(row => ({ ...row }))
  }
}
