/**
 * Vendors, the company's API keys and CLI accounts for them, and which
 * member uses which.
 *
 * - A `key` vendor is reached through the model gateway: members call
 *   /agent-work/llm/<vendor>/ with their device token, and the gateway sends
 *   the member's assigned key upstream. Keys never leave the server; they are
 *   sealed at rest and shown to administrators by their last four characters.
 *   One key may serve several members.
 * - An `account` vendor (Codex, Claude…) has company accounts the members sign
 *   in to themselves in the vendor's own flow. Only the account name is kept;
 *   each account belongs to one member at a time.
 * - A `voice` vendor (built in: 千问语音, 火山语音) is a key vendor GL Work for
 *   iOS reaches directly: the company service trades the member's key for a
 *   short-lived vendor token (千问), or hands over the 火山 API Key made for
 *   GL Work (voice.ts). Its models and voices are set under 语音.
 *
 * Enabling a vendor for a member assigns the least-shared active key or a free
 * account; members left without one are served as soon as one is added.
 */
import { Refusal } from './errors.ts'
import type { SecretBox } from './secrets.ts'
import type { Store } from './db.ts'
import type { Sql } from './sql.ts'
import { randomSecret } from './tokens.ts'

export type VendorType = 'api' | 'cli' | 'voice'
export type VendorAuth = 'key' | 'account'
/** Model vendors speak anthropic or openai; voice vendors their own APIs. */
export type Protocol = 'anthropic' | 'openai' | 'dashscope' | 'volcengine'

export interface VendorModel {
  id: string
  name?: string
}

export interface Vendor {
  id: string
  name: string
  type: VendorType
  auth: VendorAuth
  /** Wire protocol of a key vendor's upstream. */
  protocol: Protocol | null
  /** Upstream root the gateway forwards to, e.g. https://dashscope.aliyuncs.com/compatible-mode/v1. */
  baseUrl: string | null
  /** Model list endpoint, when it is not the protocol's own below baseUrl. */
  modelsUrl: string | null
  /** pi-ai `compat` profile for the Host's route (OpenAI-compatible dialects). */
  compat: Record<string, unknown> | null
  /** Models offered to members; the gateway refuses others. */
  models: VendorModel[]
  /** Model ids the upstream listed when last refreshed. */
  catalog: string[]
  catalogAt: number | null
  builtin: boolean
  createdAt: number
}

export interface ApiKey {
  id: string
  vendor: string
  label: string
  last4: string
  /** Shared keys serve several members; a dedicated key serves exactly one. */
  mode: 'shared' | 'dedicated'
  status: 'active' | 'disabled'
  createdAt: number
}

export interface Subscription {
  id: string
  vendor: string
  plan: string
  seats: number
  price: string | null
  cycle: 'monthly' | 'yearly'
  renewsAt: number | null
  /** The member who pays for it. */
  owner: string | null
  note: string | null
  createdAt: number
}

export interface CliAccount {
  id: string
  vendor: string
  subscription: string | null
  account: string
  note: string | null
  createdAt: number
}

/** How a member reaches a vendor. */
export type AssignMode = 'shared' | 'dedicated' | 'account'

export interface Assignment {
  member: string
  vendor: string
  mode: AssignMode
  apiKey: string | null
  cliAccount: string | null
}

interface Choice {
  mode: AssignMode
  apiKey?: string | null
  cliAccount?: string | null
}

export interface PublicEntry {
  key: string
  /** Plain value; secret values only through {@link Vendors.publicValues}. */
  value: string | null
  secret: boolean
  note: string | null
  group: string | null
  /** Reads by members' tools through the API. */
  reads: number
  lastReadAt: number | null
  updatedAt: number
}

const VENDOR_ID = /^[a-z][a-z0-9-]{1,30}$/u
const MODEL_ID = /^[\w.:/@+-]{1,128}$/u
const PUBLIC_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u
const MAX_MODELS = 300
const MAX_VALUE = 4096

interface VendorRow {
  id: string; name: string; type: VendorType; auth: VendorAuth; protocol: Protocol | null; base_url: string | null; models_url: string | null
  compat: string | null; models: string; catalog: string; catalog_at: number | null; builtin: number; created_at: number
}

function toVendor(row: VendorRow): Vendor {
  return {
    id: row.id, name: row.name, type: row.type, auth: row.auth, protocol: row.protocol, baseUrl: row.base_url, modelsUrl: row.models_url,
    compat: row.compat === null ? null : JSON.parse(row.compat) as Record<string, unknown>,
    models: JSON.parse(row.models) as VendorModel[], catalog: JSON.parse(row.catalog) as string[], catalogAt: row.catalog_at,
    builtin: row.builtin === 1, createdAt: row.created_at,
  }
}

function text(value: unknown, field: string, max = 120): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (result === '') throw new Refusal(400, `请填写${field}`)
  if (result.length > max) throw new Refusal(400, `${field}太长（最多 ${String(max)} 个字符）`)
  return result
}

function optionalText(value: unknown, max = 200): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Refusal(400, '备注格式不正确')
  const result = value.trim()
  if (result.length > max) throw new Refusal(400, `内容太长（最多 ${String(max)} 个字符）`)
  return result === '' ? null : result
}

/** An upstream address: https, or http on this machine (local development). */
function upstreamUrl(value: unknown, field: string): string {
  const raw = text(value, field, 300)
  let url: URL
  try { url = new URL(raw) } catch { throw new Refusal(400, `${field}不是有效的网址`) }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Refusal(400, `${field}必须使用 https`)
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new Refusal(400, `${field}不能带账号、查询参数或 #`)
  return url.href.replace(/\/+$/u, '')
}

function compatOf(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const parsed: unknown = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Refusal(400, '兼容参数必须是 JSON 对象')
  const encoded = JSON.stringify(parsed)
  if (encoded.length > 2000) throw new Refusal(400, '兼容参数太长')
  return encoded === '{}' ? null : encoded
}

/**
 * A 火山语音 key: the API Key of 豆包语音's new console (sent as `X-Api-Key`). The old
 * console's "<app id>:<access token>" pair is not one.
 */
export function volcengineApiKey(secret: string): string | undefined {
  return /^\d{4,20}:/u.test(secret) ? undefined : secret
}

export class Vendors {
  private readonly db: Sql
  private readonly box: SecretBox | undefined
  private readonly now: () => number

  constructor(store: Store, box: SecretBox | undefined, now: () => number = Date.now) {
    this.db = store.sql
    this.box = box
    this.now = now
  }

  /** Whether keys and secret values can be stored (AGENT_WORK_SECRET_KEY is set). */
  get canSeal(): boolean { return this.box !== undefined }

  private sealer(): SecretBox {
    if (this.box === undefined) throw new Refusal(503, '服务端没有设置 AGENT_WORK_SECRET_KEY，无法保存或读取密钥')
    return this.box
  }

  /** Writes that rebalance run as one transaction, so no one sees (or races) a half-assigned state. */
  private atomically<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(fn)
  }

  // Vendors

  async listVendors(): Promise<Vendor[]> {
    return (await this.db.query<VendorRow>('select * from vendors order by builtin desc, created_at, seq')).map(toVendor)
  }

  async vendor(id: string): Promise<Vendor | undefined> {
    const row = await this.db.one<VendorRow>('select * from vendors where id = ?', [id])
    return row === undefined ? undefined : toVendor(row)
  }

  async mustVendor(id: string): Promise<Vendor> {
    const found = await this.vendor(id)
    if (found === undefined) throw new Refusal(404, `没有厂商 ${id}`)
    return found
  }

  /** Fields every vendor write validates the same way. */
  private vendorFields(input: Record<string, unknown>, auth: VendorAuth) {
    if (input.type === 'voice') throw new Refusal(400, '语音厂商是内置的，只能改名称')
    const type = input.type
    if (type !== 'api' && type !== 'cli') throw new Refusal(400, '类型只能是 api 或 cli')
    if (auth !== 'key') return { name: text(input.name, '厂商名称', 40), type, protocol: null, baseUrl: null, modelsUrl: null, compat: null }
    const protocol = input.protocol
    if (protocol !== 'anthropic' && protocol !== 'openai') throw new Refusal(400, '请选择接口协议')
    const modelsUrl = input.modelsUrl === undefined || input.modelsUrl === null || input.modelsUrl === '' ? null : upstreamUrl(input.modelsUrl, '模型列表地址')
    return { name: text(input.name, '厂商名称', 40), type, protocol, baseUrl: upstreamUrl(input.baseUrl, '接口地址'), modelsUrl, compat: compatOf(input.compat) }
  }

  async addVendor(input: Record<string, unknown>): Promise<Vendor> {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!VENDOR_ID.test(id)) throw new Refusal(400, '厂商标识只能用小写字母、数字和 -，以字母开头（2–31 个字符）')
    if (await this.vendor(id) !== undefined) throw new Refusal(409, `厂商标识 ${id} 已存在`)
    const auth = input.auth
    if (auth !== 'key' && auth !== 'account') throw new Refusal(400, '登录方式只能是 key 或账号')
    const fields = this.vendorFields(input, auth)
    await this.db.run('insert into vendors (id, name, type, auth, protocol, base_url, models_url, compat, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, fields.name, fields.type, auth, fields.protocol, fields.baseUrl, fields.modelsUrl, fields.compat, this.now()])
    return this.mustVendor(id)
  }

  /** The id and login method stay; changing them would orphan keys, accounts and members' config. */
  async updateVendor(id: string, input: Record<string, unknown>): Promise<Vendor> {
    const vendor = await this.mustVendor(id)
    if (vendor.type === 'voice') {
      await this.db.run('update vendors set name = ? where id = ?', [text(input.name, '厂商名称', 40), id])
      return this.mustVendor(id)
    }
    const fields = this.vendorFields({ type: vendor.type, ...input }, vendor.auth)
    await this.db.run('update vendors set name = ?, type = ?, protocol = ?, base_url = ?, models_url = ?, compat = ? where id = ?',
      [fields.name, fields.type, fields.protocol, fields.baseUrl, fields.modelsUrl, fields.compat, id])
    return this.mustVendor(id)
  }

  async deleteVendor(id: string): Promise<void> {
    if ((await this.mustVendor(id)).type === 'voice') throw new Refusal(409, '语音厂商是内置的，不能删除；不用时在“语音”里关闭')
    const held = await this.db.one<{ n: number }>('select (select count(*) from api_keys where vendor = ?) + (select count(*) from cli_accounts where vendor = ?) as n', [id, id])
    if ((held?.n ?? 0) > 0) throw new Refusal(409, '请先删除这个厂商下的 Key 或账号')
    await this.db.run('delete from vendors where id = ?', [id])
  }

  async setModels(id: string, models: unknown): Promise<Vendor> {
    const vendor = await this.mustVendor(id)
    if (vendor.auth !== 'key') throw new Refusal(400, '账号登录的厂商没有模型配置')
    if (vendor.type === 'voice') throw new Refusal(400, '语音厂商的模型在“语音”里设置')
    if (!Array.isArray(models) || models.length > MAX_MODELS) throw new Refusal(400, `模型列表格式不正确（最多 ${String(MAX_MODELS)} 个）`)
    const seen = new Set<string>()
    const clean: VendorModel[] = []
    for (const entry of models as unknown[]) {
      const raw = typeof entry === 'string' ? { id: entry } : entry as { id?: unknown; name?: unknown }
      const modelId = typeof raw.id === 'string' ? raw.id.trim() : ''
      if (!MODEL_ID.test(modelId)) throw new Refusal(400, `模型 ID 不正确：${modelId.slice(0, 40)}`)
      if (seen.has(modelId)) continue
      seen.add(modelId)
      const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 80) : undefined
      clean.push(name === undefined ? { id: modelId } : { id: modelId, name })
    }
    await this.db.run('update vendors set models = ? where id = ?', [JSON.stringify(clean), id])
    return this.mustVendor(id)
  }

  /**
   * Ask the upstream which models it serves, with one of the vendor's active keys.
   * @returns the vendor with its refreshed catalog.
   */
  async refreshCatalog(id: string, fetchImpl: typeof fetch = fetch): Promise<Vendor> {
    const vendor = await this.mustVendor(id)
    if (vendor.auth !== 'key' || vendor.baseUrl === null) throw new Refusal(400, '账号登录的厂商没有模型列表')
    if (vendor.type === 'voice') throw new Refusal(400, '语音厂商的音色在“语音”里从官方更新')
    const key = (await this.listKeys(id)).find(k => k.status === 'active')
    if (key === undefined) throw new Refusal(409, '请先为这个厂商录入一个可用的 API Key')
    const secret = await this.keySecret(key.id)
    const url = vendor.modelsUrl ?? `${vendor.baseUrl}${vendor.protocol === 'anthropic' ? '/v1/models?limit=1000' : '/models'}`
    let response: Response
    try {
      // Both auth styles: the vendor's models endpoint may follow either protocol (DeepSeek lists OpenAI-style).
      response = await fetchImpl(url, {
        headers: { 'authorization': `Bearer ${secret}`, 'x-api-key': secret, 'anthropic-version': '2023-06-01', 'accept': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new Refusal(502, `无法连接 ${new URL(url).host}`)
    }
    if (!response.ok) throw new Refusal(502, `厂商返回 ${String(response.status)}，请检查 Key 和模型列表地址`)
    const body = await response.json().catch(() => undefined) as { data?: unknown } | undefined
    const ids = (Array.isArray(body?.data) ? body.data : [])
      .map((entry: unknown) => typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined)
      .filter((value): value is string => typeof value === 'string' && MODEL_ID.test(value))
    const catalog = [...new Set(ids)].sort()
    await this.db.run('update vendors set catalog = ?, catalog_at = ? where id = ?', [JSON.stringify(catalog), this.now(), id])
    return this.mustVendor(id)
  }

  // API keys

  async listKeys(vendor?: string): Promise<ApiKey[]> {
    const columns = 'id, vendor, label, last4, mode, status, created_at as "createdAt"'
    return vendor === undefined
      ? this.db.query<ApiKey>(`select ${columns} from api_keys order by vendor, created_at, seq`)
      : this.db.query<ApiKey>(`select ${columns} from api_keys where vendor = ? order by created_at, seq`, [vendor])
  }

  async key(id: string): Promise<ApiKey | undefined> {
    return (await this.listKeys()).find(k => k.id === id)
  }

  /**
   * @param mode - shared keys serve several members; a dedicated key serves one.
   * @param member - for a dedicated key: hand it to this member at once.
   */
  async addKey(vendorId: string, label: unknown, secret: unknown, mode: unknown = 'shared', member: string | null = null): Promise<ApiKey> {
    const vendor = await this.mustVendor(vendorId)
    if (vendor.auth !== 'key') throw new Refusal(400, `${vendor.name} 使用账号登录，请到订阅与账号里添加`)
    if (mode !== 'shared' && mode !== 'dedicated') throw new Refusal(400, 'Key 类型只能是共享或独立')
    // No vendor's key holds whitespace: drop any a paste brought along (line breaks, NBSP, zero-width).
    const plain = typeof secret === 'string' ? secret.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, '') : ''
    if (plain.length === 0) throw new Refusal(400, '请填写 API Key')
    if (plain.length < 8) throw new Refusal(400, `API Key 太短（${String(plain.length)} 个字符），请检查是否复制完整`)
    if (plain.length > 512) throw new Refusal(400, 'API Key 太长（超过 512 个字符），请检查是否多复制了内容')
    if (vendor.protocol === 'volcengine' && volcengineApiKey(plain) === undefined) {
      throw new Refusal(400, '火山语音请填写新版控制台的 API Key（豆包语音 → API Key），不是旧版的 APP ID:Access Token')
    }
    if (member !== null && mode !== 'dedicated') throw new Refusal(400, '只有独立 Key 能直接指定成员')
    const sealed = this.sealer().seal(plain)
    const id = `key_${randomSecret().slice(0, 10)}`
    const name = text(label, 'Key 名称', 40)
    return this.atomically(async () => {
      await this.db.run('insert into api_keys (id, vendor, label, secret, last4, mode, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, vendorId, name, sealed, plain.slice(-4), mode, 'active', this.now()])
      if (member !== null) await this.assign(member, vendorId, { mode: 'dedicated', apiKey: id })
      await this.rebalance()
      return await this.key(id) as ApiKey
    })
  }

  async setKeyStatus(id: string, status: unknown): Promise<ApiKey> {
    if (status !== 'active' && status !== 'disabled') throw new Refusal(400, '状态只能是 active 或 disabled')
    return this.atomically(async () => {
      if (await this.db.run('update api_keys set status = ? where id = ?', [status, id]) === 0) throw new Refusal(404, 'Key 不存在')
      await this.rebalance()
      return await this.key(id) as ApiKey
    })
  }

  async deleteKey(id: string): Promise<ApiKey> {
    return this.atomically(async () => {
      const key = await this.key(id)
      if (key === undefined) throw new Refusal(404, 'Key 不存在')
      await this.db.run('delete from api_keys where id = ?', [id])
      await this.rebalance()
      return key
    })
  }

  /** The plain key, for the gateway and model listing only. */
  async keySecret(id: string): Promise<string> {
    const row = await this.db.one<{ secret: string }>('select secret from api_keys where id = ?', [id])
    if (row === undefined) throw new Refusal(404, 'Key 不存在')
    try { return this.sealer().open(row.secret) } catch (error) {
      if (error instanceof Refusal) throw error
      throw new Refusal(500, 'Key 无法解密：AGENT_WORK_SECRET_KEY 与保存时不同')
    }
  }

  // Subscriptions and their accounts

  async listSubscriptions(): Promise<Subscription[]> {
    return this.db.query<Subscription>(`select id, vendor, plan, seats, price, cycle, renews_at as "renewsAt", owner, note, created_at as "createdAt"
      from subscriptions order by vendor, created_at, seq`)
  }

  async subscription(id: string): Promise<Subscription | undefined> {
    return (await this.listSubscriptions()).find(s => s.id === id)
  }

  private subscriptionFields(input: Record<string, unknown>) {
    const seats = Number(input.seats)
    if (!Number.isInteger(seats) || seats < 1 || seats > 1000) throw new Refusal(400, '席位数要是正整数')
    const cycle = input.cycle ?? 'monthly'
    if (cycle !== 'monthly' && cycle !== 'yearly') throw new Refusal(400, '计费周期只能是按月或按年')
    const renewsAt = input.renewsAt === undefined || input.renewsAt === null || input.renewsAt === '' ? null : Number(input.renewsAt)
    if (renewsAt !== null && !Number.isFinite(renewsAt)) throw new Refusal(400, '续费日期不正确')
    return { plan: text(input.plan, '套餐名称', 60), seats, price: optionalText(input.price, 40), cycle, renewsAt, owner: optionalText(input.owner, 31), note: optionalText(input.note) }
  }

  async addSubscription(input: Record<string, unknown>): Promise<Subscription> {
    const vendor = await this.mustVendor(String(input.vendor ?? ''))
    if (vendor.auth !== 'account') throw new Refusal(400, `${vendor.name} 使用 API Key，没有订阅`)
    const f = this.subscriptionFields(input)
    const id = `sub_${randomSecret().slice(0, 10)}`
    await this.db.run('insert into subscriptions (id, vendor, plan, seats, price, cycle, renews_at, owner, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, vendor.id, f.plan, f.seats, f.price, f.cycle, f.renewsAt, f.owner, f.note, this.now()])
    return await this.subscription(id) as Subscription
  }

  async updateSubscription(id: string, input: Record<string, unknown>): Promise<Subscription> {
    if (await this.subscription(id) === undefined) throw new Refusal(404, '订阅不存在')
    const f = this.subscriptionFields(input)
    await this.db.run('update subscriptions set plan = ?, seats = ?, price = ?, cycle = ?, renews_at = ?, owner = ?, note = ? where id = ?',
      [f.plan, f.seats, f.price, f.cycle, f.renewsAt, f.owner, f.note, id])
    return await this.subscription(id) as Subscription
  }

  /** Accounts stay, without a subscription. */
  async deleteSubscription(id: string): Promise<Subscription> {
    const sub = await this.subscription(id)
    if (sub === undefined) throw new Refusal(404, '订阅不存在')
    await this.db.run('delete from subscriptions where id = ?', [id])
    return sub
  }

  async listAccounts(vendor?: string): Promise<CliAccount[]> {
    const columns = 'id, vendor, subscription, account, note, created_at as "createdAt"'
    return vendor === undefined
      ? this.db.query<CliAccount>(`select ${columns} from cli_accounts order by vendor, account`)
      : this.db.query<CliAccount>(`select ${columns} from cli_accounts where vendor = ? order by account`, [vendor])
  }

  async account(id: string): Promise<CliAccount | undefined> {
    return (await this.listAccounts()).find(a => a.id === id)
  }

  /**
   * @param subscriptionId - the subscription the account belongs to; its vendor is the account's.
   * @param member - hand the account to this member at once; otherwise to the first member waiting.
   */
  async addAccount(vendorOrSubscription: string, account: unknown, note: unknown, member: string | null = null): Promise<CliAccount> {
    const sub = await this.subscription(vendorOrSubscription)
    const vendor = await this.mustVendor(sub?.vendor ?? vendorOrSubscription)
    if (vendor.auth !== 'account') throw new Refusal(400, `${vendor.name} 使用 API Key，请到 API Key 里添加`)
    const name = text(account, '账号', 120)
    if ((await this.listAccounts(vendor.id)).some(a => a.account === name)) throw new Refusal(409, `${vendor.name} 账号 ${name} 已存在`)
    const id = `acct_${randomSecret().slice(0, 10)}`
    const remark = optionalText(note)
    return this.atomically(async () => {
      await this.db.run('insert into cli_accounts (id, vendor, subscription, account, note, created_at) values (?, ?, ?, ?, ?, ?)',
        [id, vendor.id, sub?.id ?? null, name, remark, this.now()])
      if (member !== null) await this.assign(member, vendor.id, { mode: 'account', cliAccount: id })
      await this.rebalance()
      return await this.account(id) as CliAccount
    })
  }

  async deleteAccount(id: string): Promise<CliAccount> {
    return this.atomically(async () => {
      const account = await this.account(id)
      if (account === undefined) throw new Refusal(404, '账号不存在')
      await this.db.run('delete from cli_accounts where id = ?', [id])
      await this.rebalance()
      return account
    })
  }

  /**
   * Take an account back: its member no longer has the vendor (otherwise the
   * next rebalance would hand the same account straight back), and the account
   * goes to the next member waiting for one.
   */
  async releaseAccount(id: string): Promise<string | null> {
    return this.atomically(async () => {
      const holder = (await this.assignments()).find(a => a.cliAccount === id)
      if (holder === undefined) return null
      await this.db.run('delete from member_vendors where member = ? and vendor = ?', [holder.member, holder.vendor])
      await this.rebalance()
      return holder.member
    })
  }

  // Members

  async assignments(member?: string): Promise<Assignment[]> {
    const columns = `member, vendor, coalesce(mode, 'shared') as mode, api_key as "apiKey", cli_account as "cliAccount"`
    return member === undefined
      ? this.db.query<Assignment>(`select ${columns} from member_vendors order by member, vendor`)
      : this.db.query<Assignment>(`select ${columns} from member_vendors where member = ? order by vendor`, [member])
  }

  async assignment(member: string, vendor: string): Promise<Assignment | undefined> {
    return (await this.assignments(member)).find(a => a.vendor === vendor)
  }

  /** Validate one vendor choice for a member: mode, and the named key or account if any. */
  private async choice(member: string, raw: { vendor?: unknown; mode?: unknown; apiKey?: unknown; cliAccount?: unknown }): Promise<[string, Choice]> {
    const vendor = await this.mustVendor(typeof raw.vendor === 'string' ? raw.vendor : '')
    const mode = raw.mode ?? (vendor.auth === 'account' ? 'account' : 'shared')
    if (vendor.auth === 'account' ? mode !== 'account' : mode !== 'shared' && mode !== 'dedicated') {
      throw new Refusal(400, `${vendor.name} 不能用这种分配方式`)
    }
    const choice: Choice = { mode: mode as AssignMode }
    if (raw.apiKey !== undefined && raw.apiKey !== '') {
      const key = raw.apiKey === null ? undefined : await this.key(String(raw.apiKey))
      if (raw.apiKey !== null && (key === undefined || key.vendor !== vendor.id)) throw new Refusal(400, `Key 不属于 ${vendor.name}`)
      if (key !== undefined && key.status !== 'active') throw new Refusal(409, `Key ${key.label} 已停用`)
      if (key !== undefined && key.mode !== mode) throw new Refusal(400, `${key.label} 是${key.mode === 'dedicated' ? '独立' : '共享'} Key，和分配方式不符`)
      const holder = key?.mode === 'dedicated' ? (await this.assignments()).find(a => a.apiKey === key.id && a.member !== member) : undefined
      if (holder !== undefined) throw new Refusal(409, `独立 Key ${key?.label ?? ''} 已分配给 ${holder.member}`)
      choice.apiKey = key?.id ?? null
    }
    if (raw.cliAccount !== undefined && raw.cliAccount !== '') {
      const account = raw.cliAccount === null ? undefined : await this.account(String(raw.cliAccount))
      if (raw.cliAccount !== null && (account === undefined || account.vendor !== vendor.id)) throw new Refusal(400, `账号不属于 ${vendor.name}`)
      const holder = account === undefined ? undefined : (await this.assignments()).find(a => a.cliAccount === account.id && a.member !== member)
      if (holder !== undefined) throw new Refusal(409, `账号 ${account?.account ?? ''} 已分配给 ${holder.member}`)
      choice.cliAccount = account?.id ?? null
    }
    return [vendor.id, choice]
  }

  private async write(member: string, vendor: string, choice: Choice): Promise<void> {
    await this.db.run('insert into member_vendors (member, vendor, mode, created_at) values (?, ?, ?, ?) on conflict do nothing', [member, vendor, choice.mode, this.now()])
    const current = await this.assignment(member, vendor)
    // Switching between shared and dedicated drops the key held under the other mode.
    const keepKey = current !== undefined && current.mode === choice.mode
    await this.db.run('update member_vendors set mode = ?, api_key = ?, cli_account = ? where member = ? and vendor = ?', [
      choice.mode,
      choice.apiKey !== undefined ? choice.apiKey : keepKey ? current.apiKey : null,
      choice.cliAccount !== undefined ? choice.cliAccount : current?.cliAccount ?? null,
      member, vendor,
    ])
  }

  /** Enable one vendor for a member, or change how they reach it. */
  async assign(member: string, vendor: string, raw: { mode?: unknown; apiKey?: unknown; cliAccount?: unknown }): Promise<Assignment> {
    return this.atomically(async () => {
      const [id, choice] = await this.choice(member, { vendor, ...raw })
      await this.write(member, id, choice)
      await this.rebalance()
      return await this.assignment(member, id) as Assignment
    })
  }

  /**
   * Set exactly which vendors a member may use, optionally with the mode and
   * the key or account for each; unnamed ones keep their current one or get one assigned.
   */
  async setMemberVendors(member: string, entries: unknown): Promise<Assignment[]> {
    if (!Array.isArray(entries)) throw new Refusal(400, '厂商列表格式不正确')
    return this.atomically(async () => {
      const wanted = new Map<string, Choice>()
      for (const entry of entries as unknown[]) {
        const [vendor, choice] = await this.choice(member, typeof entry === 'string' ? { vendor: entry } : entry as Record<string, unknown>)
        wanted.set(vendor, choice)
      }
      for (const current of await this.assignments(member)) {
        if (!wanted.has(current.vendor)) await this.db.run('delete from member_vendors where member = ? and vendor = ?', [member, current.vendor])
      }
      for (const [vendor, choice] of wanted) await this.write(member, vendor, choice)
      await this.rebalance()
      return this.assignments(member)
    })
  }

  /**
   * Give every member without a usable key or account one, where one is available:
   * the least-shared active shared key, a dedicated key nobody holds, or a free account.
   */
  async rebalance(): Promise<void> {
    await this.atomically(async () => {
      const keys = (await this.listKeys()).filter(k => k.status === 'active')
      const accounts = await this.listAccounts()
      const rows = await this.assignments()
      const vendors = new Map((await this.listVendors()).map(v => [v.id, v]))
      const load = new Map(keys.map(k => [k.id, rows.filter(a => a.apiKey === k.id).length]))
      const heldAccounts = new Set(rows.map(a => a.cliAccount).filter(id => id !== null))
      const set = async (row: Assignment, column: 'api_key' | 'cli_account', value: string | null) => {
        await this.db.run(`update member_vendors set ${column} = ? where member = ? and vendor = ?`, [value, row.member, row.vendor])
      }
      for (const row of rows) {
        const vendor = vendors.get(row.vendor)
        if (vendor?.auth === 'key') {
          const held = keys.find(k => k.id === row.apiKey)
          if (held !== undefined && held.mode === row.mode) continue
          const pool = keys.filter(k => k.vendor === row.vendor && k.mode === row.mode)
          const pick = row.mode === 'dedicated'
            ? pool.find(k => (load.get(k.id) ?? 0) === 0)
            // The least-shared active key, oldest first on ties.
            : pool.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0]
          if (pick !== undefined) load.set(pick.id, (load.get(pick.id) ?? 0) + 1)
          if ((pick?.id ?? null) !== row.apiKey) await set(row, 'api_key', pick?.id ?? null)
        } else if (vendor?.auth === 'account' && row.cliAccount === null) {
          const free = accounts.find(a => a.vendor === row.vendor && !heldAccounts.has(a.id))
          if (free === undefined) continue
          heldAccounts.add(free.id)
          await set(row, 'cli_account', free.id)
        }
      }
    })
  }

  // System config, for client plugins and members' tools

  async listPublic(): Promise<PublicEntry[]> {
    // SQLite sorted entries without a group first.
    const rows = await this.db.query<{ key: string; value: string; secret: number; note: string | null; group_name: string | null; reads: number; last_read_at: number | null; updated_at: number }>(
      'select key, value, secret, note, group_name, reads, last_read_at, updated_at from public_config order by group_name nulls first, key')
    return rows.map(row => ({
      key: row.key, value: row.secret === 1 ? null : row.value, secret: row.secret === 1, note: row.note, group: row.group_name,
      reads: row.reads, lastReadAt: row.last_read_at, updatedAt: row.updated_at,
    }))
  }

  /**
   * @param value - undefined keeps a secret entry's current value (edit its note or flag without retyping it).
   */
  async setPublic(key: unknown, value: unknown, secret: unknown, note: unknown, group: unknown = undefined): Promise<PublicEntry> {
    const name = typeof key === 'string' ? key.trim() : ''
    if (!PUBLIC_KEY.test(name)) throw new Refusal(400, '配置键只能用字母、数字、_ . -，以字母开头（最长 64 个字符）')
    const isSecret = secret === true
    const current = await this.db.one<{ value: string; secret: number; group_name: string | null }>('select value, secret, group_name from public_config where key = ?', [name])
    let plain: string
    if (value === undefined || value === null) {
      if (current === undefined) throw new Refusal(400, '请填写配置值')
      plain = current.secret === 1 ? this.sealer().open(current.value) : current.value
    } else {
      if (typeof value !== 'string' || value.length > MAX_VALUE) throw new Refusal(400, `配置值最多 ${String(MAX_VALUE)} 个字符`)
      plain = value
    }
    const groupName = group === undefined ? current?.group_name ?? null : optionalText(group, 40)
    const stored = isSecret ? this.sealer().seal(plain) : plain
    await this.db.run(`insert into public_config (key, value, secret, note, group_name, updated_at) values (?, ?, ?, ?, ?, ?)
      on conflict (key) do update set value = excluded.value, secret = excluded.secret, note = excluded.note, group_name = excluded.group_name, updated_at = excluded.updated_at`,
    [name, stored, isSecret ? 1 : 0, optionalText(note), groupName, this.now()])
    return (await this.listPublic()).find(entry => entry.key === name) as PublicEntry
  }

  async deletePublic(key: string): Promise<void> {
    if (await this.db.run('delete from public_config where key = ?', [key]) === 0) throw new Refusal(404, `没有配置 ${key}`)
  }

  /**
   * Every public value in plain text, as signed-in Hosts and members' tools receive them.
   * Unreadable secrets are left out.
   * @param count - record the read (tools reading through the API, not Host syncs).
   */
  async publicValues(only?: string, count = false): Promise<Record<string, string>> {
    const rows = only === undefined
      ? await this.db.query<{ key: string; value: string; secret: number }>('select key, value, secret from public_config order by key')
      : await this.db.query<{ key: string; value: string; secret: number }>('select key, value, secret from public_config where key = ?', [only])
    const values: Record<string, string> = {}
    for (const row of rows) {
      if (row.secret !== 1) values[row.key] = row.value
      else if (this.box !== undefined) {
        try { values[row.key] = this.box.open(row.value) } catch { /* sealed under another master key */ }
      }
    }
    if (count && rows.length > 0) {
      for (const row of rows) await this.db.run('update public_config set reads = reads + 1, last_read_at = ? where key = ?', [this.now(), row.key])
    }
    return values
  }

  /**
   * Bring a key from the environment (DEEPSEEK_API_KEY, the pre-v3 setup) into
   * the vendor store once, and enable DeepSeek for every member as before.
   * @returns whether a key was imported.
   */
  async importLegacyDeepSeek(legacy: { baseUrl: string; apiKey: string } | undefined, members: readonly string[]): Promise<boolean> {
    if (legacy === undefined || this.box === undefined || await this.vendor('deepseek') === undefined || (await this.listKeys('deepseek')).length > 0) return false
    return this.atomically(async () => {
      const fresh = (await this.assignments()).length === 0
      await this.db.run('update vendors set base_url = ? where id = ?', [legacy.baseUrl.replace(/\/+$/u, ''), 'deepseek'])
      await this.addKey('deepseek', '从 .env 导入', legacy.apiKey, 'shared')
      if (fresh) for (const member of members) await this.setMemberVendors(member, ['deepseek'])
      return true
    })
  }
}

