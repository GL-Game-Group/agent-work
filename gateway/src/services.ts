/**
 * What the web console does, independent of how it is asked: the admin
 * console's operations for administrators, and the self-service ones for any
 * member. Each operation validates its input, applies the rules (an active
 * administrator always remains, a dedicated key serves one member…) and
 * writes the audit log. Callers authenticate and check the role first.
 */
import type { GatewayConfig } from './config.ts'
import { assertMemberName, type Member, type Role, type Store, type Team } from './db.ts'
import { Refusal } from './errors.ts'
import type { GitHub } from './github.ts'
import { fetchPackage, packageUrl, PluginCatalog, type PluginPackage } from './plugins.ts'
import { Tunnels, type TunnelSettings } from './tunnels.ts'
import type { Vendors } from './vendors.ts'
import { Voice, type VoiceSettings } from './voice.ts'

const DAY_MS = 24 * 60 * 60 * 1000
export const USAGE_WINDOWS = [1, 7, 30, 90] as const
const TEAMS = new Set(['dev', 'product', 'qa'])
/** Internal keys live until revoked; the expiry only bounds a forgotten one. */
const INTERNAL_KEY_TTL_MS = 3 * 365 * DAY_MS
const MAX_INTERNAL_KEYS = 20

/** Who acts, and from where (for the audit log). */
export interface Actor {
  member: Member
  ip: string | null
}

export interface ServiceDeps {
  config: GatewayConfig
  store: Store
  github: GitHub
  vendors: Vendors
  plugins?: PluginCatalog
  tunnels?: Tunnels
  voice?: Voice
  /** Downloads plugin packages and voice lists; injectable for tests. */
  fetch?: typeof fetch
  now?: () => number
}

/** Plugin descriptions people read before installing. */
function pluginMeta(input: Record<string, unknown>) {
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  if (displayName === '' || displayName.length > 30) throw new Refusal(400, '请填写插件名称（最多 30 个字符）')
  const raw = Array.isArray(input.permissions) ? input.permissions : typeof input.permissions === 'string' ? input.permissions.split('\n') : []
  const permissions = raw.map(p => String(p).trim()).filter(p => p !== '')
  if (permissions.length > 10 || permissions.some(p => p.length > 80)) throw new Refusal(400, '权限说明最多 10 条，每条最多 80 个字符')
  return { displayName, permissions, preinstalled: input.preinstalled === true }
}

function team(value: unknown): Team | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !TEAMS.has(value)) throw new Refusal(400, '职能只能是开发、产品或测试')
  return value as Team
}

function displayName(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.trim().length > 20) throw new Refusal(400, '姓名最多 20 个字符')
  return value.trim() || fallback
}

function role(value: unknown): Role {
  if (value !== 'admin' && value !== 'member') throw new Refusal(400, '角色只能是管理员或成员')
  return value
}

async function optionalMember(store: Store, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null
  const name = String(value)
  if (await store.member(name) === undefined) throw new Refusal(404, `没有成员 ${name}`)
  return name
}

/** A freshly issued internal key; the token is shown this once. */
export interface IssuedKey {
  id: string
  label: string
  token: string
  createdAt: number
}

async function issueInternalKey(store: Store, member: string, label: unknown): Promise<IssuedKey> {
  const name = typeof label === 'string' ? label.trim() : ''
  if (name === '' || name.length > 40) throw new Refusal(400, '请填写用途（最多 40 个字符）')
  // Counted and issued in one transaction, so concurrent requests cannot pass the limit together.
  return store.sql.transaction(async () => {
    if ((await store.listCredentials(member)).filter(c => c.kind === 'key').length >= MAX_INTERNAL_KEYS) throw new Refusal(409, '内部 Key 太多了，先吊销不用的')
    const { credential, token } = await store.issueCredential(member, 'key', name, INTERNAL_KEY_TTL_MS)
    return { id: credential.id, label: credential.label, token, createdAt: credential.createdAt }
  })
}

function deviceView(c: { id: string; member: string; kind: string; label: string; createdAt: number; lastUsedAt: number | null; expiresAt: number; lastIp: string | null }) {
  return { id: c.id, member: c.member, kind: c.kind, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, expiresAt: c.expiresAt, lastIp: c.lastIp }
}

export type DeviceView = ReturnType<typeof deviceView>

export class AdminService {
  private readonly config: GatewayConfig
  private readonly store: Store
  private readonly github: GitHub
  private readonly vendors: Vendors
  private readonly catalog: PluginCatalog
  private readonly tunnelStore: Tunnels
  private readonly voiceStore: Voice
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(deps: ServiceDeps) {
    this.config = deps.config
    this.store = deps.store
    this.github = deps.github
    this.vendors = deps.vendors
    this.catalog = deps.plugins ?? new PluginCatalog(deps.store, deps.now)
    this.tunnelStore = deps.tunnels ?? new Tunnels(deps.store, deps.config, deps.now)
    this.voiceStore = deps.voice ?? new Voice(deps.store, deps.vendors, deps.now)
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  private async audit(actor: Actor, action: string, target: string | null, detail: string | null = null): Promise<void> {
    await this.store.audit({ actor: actor.member.name, action, target, detail, ip: actor.ip })
  }

  /** An operation and its audit entry as one transaction (the rules read state, then write it). */
  private atomically<T>(fn: () => Promise<T>): Promise<T> {
    return this.store.sql.transaction(fn)
  }

  private async member(name: string): Promise<Member> {
    const found = await this.store.member(name)
    if (found === undefined) throw new Refusal(404, `没有成员 ${name}`)
    return found
  }

  /** Refuse changes that would leave no active administrator, or lock the caller out. */
  private async keepAnAdmin(actor: Actor, target: Member, after: { role?: Role; status?: 'active' | 'disabled'; deleted?: boolean }): Promise<void> {
    const losesAdmin = target.role === 'admin' && target.status === 'active'
      && (after.deleted === true || after.role === 'member' || after.status === 'disabled')
    if (!losesAdmin) return
    if (target.name === actor.member.name) throw new Refusal(409, '不能停用、降级或删除自己的管理员账号')
    if ((await this.store.listMembers()).filter(m => m.role === 'admin' && m.status === 'active').length <= 1) throw new Refusal(409, '至少需要保留一个有效的管理员')
  }

  // Overview and records

  async overview() {
    const week = await this.store.usageSince(this.now() - 7 * DAY_MS)
    return {
      productName: this.config.productName ?? 'GL Work',
      publicOrigin: this.config.publicOrigin,
      githubOrg: this.config.github.org || null,
      secretKey: this.vendors.canSeal,
      usage7d: {
        requests: week.reduce((sum, row) => sum + row.requests, 0),
        tokens: week.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0),
      },
      daily: await this.store.dailyVendorUsageSince(this.now() - 14 * DAY_MS),
    }
  }

  async usage(days: number) {
    if (!(USAGE_WINDOWS as readonly number[]).includes(days)) throw new Refusal(400, '只支持 1、7、30、90 天')
    const since = this.now() - days * DAY_MS
    const totals = new Map((await this.store.usageSince(since)).map(row => [row.member, row]))
    const daily = await this.store.dailyVendorUsageSince(since)
    const members = (await this.store.listMembers()).map(m => ({
      member: m.name, displayName: m.displayName,
      requests: totals.get(m.name)?.requests ?? 0,
      inputTokens: totals.get(m.name)?.inputTokens ?? 0,
      outputTokens: totals.get(m.name)?.outputTokens ?? 0,
      cacheReadTokens: totals.get(m.name)?.cacheReadTokens ?? 0,
    }))
    const byVendor = await this.store.memberVendorUsageSince(since)
    const keys = []
    for (const k of await this.keys()) keys.push({ id: k.id, vendor: k.vendor, label: k.label, last4: k.last4, ...await this.store.keyUsageSince(k.id, since) })
    return { days, daily, members, byVendor, keys }
  }

  async auditLog(limit = 200) {
    return this.store.recentAudit(Math.min(Math.max(limit, 1), 1000))
  }

  // Members

  async members() {
    const credentials = new Map((await this.store.credentialSummary()).map(row => [row.member, row]))
    const usage = new Map((await this.store.usageSince(this.now() - 30 * DAY_MS)).map(row => [row.member, row]))
    const assignments = await this.vendors.assignments()
    return (await this.store.listMembers()).map(m => ({
      ...m,
      devices: credentials.get(m.name)?.devices ?? 0,
      lastUsedAt: credentials.get(m.name)?.lastUsedAt ?? null,
      tokens30d: (usage.get(m.name)?.inputTokens ?? 0) + (usage.get(m.name)?.outputTokens ?? 0),
      vendors: assignments.filter(a => a.member === m.name).map(({ vendor, mode, apiKey, cliAccount }) => ({ vendor, mode, apiKey, cliAccount })),
    }))
  }

  /**
   * @param input.vendors - vendor ids, or `{vendor, mode}` to choose shared or dedicated keys.
   */
  async addMember(actor: Actor, input: Record<string, unknown>): Promise<Member> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    try { assertMemberName(name) } catch { throw new Refusal(400, '成员名只能用小写字母、数字和 -，并以字母开头（最长 31 个字符）') }
    const login = typeof input.github === 'string' ? input.github.trim().replace(/^@/u, '') : ''
    if (login === '' || login.includes('@')) throw new Refusal(400, '请填写 GitHub 用户名（github.com/<用户名>），不是邮箱')
    const newRole = role(input.role ?? 'member')
    const memberTeam = team(input.team)
    const name2 = displayName(input.displayName, name)
    if (await this.store.member(name) !== undefined) throw new Refusal(409, `成员 ${name} 已存在`)
    const enabled = input.vendors ?? []
    if (!Array.isArray(enabled)) throw new Refusal(400, '厂商列表格式不正确')
    for (const entry of enabled as unknown[]) await this.vendors.mustVendor(String(typeof entry === 'string' ? entry : (entry as { vendor?: unknown }).vendor ?? ''))
    let user
    try { user = await this.github.lookup(login) } catch { throw new Refusal(404, `GitHub 上找不到用户 ${login}`) }
    const found = user
    return this.atomically(async () => {
      const holder = await this.store.memberByGithubId(found.id)
      if (holder !== undefined) throw new Refusal(409, `GitHub 账号 ${found.login} 已属于成员 ${holder.name}`)
      await this.store.addMember({
        name, githubId: found.id, githubLogin: found.login, role: newRole, displayName: name2, team: memberTeam,
        ...typeof input.tunnels === 'boolean' ? { tunnels: input.tunnels } : {},
      })
      await this.audit(actor, 'member-add', name, `github ${found.login} (${String(found.id)}), ${newRole}`)
      if (enabled.length > 0) {
        const result = await this.vendors.setMemberVendors(name, enabled)
        await this.audit(actor, 'member-vendors', name, result.map(a => `${a.vendor}:${a.mode}`).join(', '))
      }
      return this.member(name)
    })
  }

  async setStatus(actor: Actor, name: string, status: unknown): Promise<Member> {
    return this.atomically(async () => {
      const target = await this.member(name)
      if (status !== 'active' && status !== 'disabled') throw new Refusal(400, '状态只能是正常或停用')
      await this.keepAnAdmin(actor, target, { status })
      await this.store.setStatus(name, status)
      await this.audit(actor, status === 'disabled' ? 'member-disable' : 'member-enable', name)
      return this.member(name)
    })
  }

  async setRole(actor: Actor, name: string, value: unknown): Promise<Member> {
    return this.atomically(async () => {
      const target = await this.member(name)
      const next = role(value)
      await this.keepAnAdmin(actor, target, { role: next })
      await this.store.setRole(name, next)
      await this.audit(actor, 'member-role', name, next)
      return this.member(name)
    })
  }

  async deleteMember(actor: Actor, name: string): Promise<void> {
    await this.atomically(async () => {
      const target = await this.member(name)
      await this.keepAnAdmin(actor, target, { deleted: true })
      await this.store.deleteMember(name)
      await this.vendors.rebalance()
      await this.audit(actor, 'member-delete', name, `github ${target.githubLogin}`)
    })
  }

  async setProfile(actor: Actor, name: string, input: Record<string, unknown>): Promise<Member> {
    const target = await this.member(name)
    await this.store.setProfile(name, { displayName: displayName(input.displayName, target.displayName), ...'team' in input ? { team: team(input.team) } : {} })
    await this.audit(actor, 'member-profile', name)
    return this.member(name)
  }

  async setTunnelGrants(actor: Actor, name: string, input: { tunnels?: unknown; ssh?: unknown }): Promise<Member> {
    await this.member(name)
    const grants: { tunnels?: boolean; ssh?: boolean } = {}
    if (typeof input.tunnels === 'boolean') grants.tunnels = input.tunnels
    if (typeof input.ssh === 'boolean') grants.ssh = input.ssh
    await this.store.setTunnelGrants(name, grants)
    await this.audit(actor, 'member-tunnels', name, Object.entries(grants).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', '))
    return this.member(name)
  }

  async setMemberVendors(actor: Actor, name: string, entries: unknown) {
    await this.member(name)
    const result = await this.vendors.setMemberVendors(name, entries)
    await this.audit(actor, 'member-vendors', name, result.map(a => `${a.vendor}:${a.mode}`).join(', ') || 'none')
    return result
  }

  /** Enable one vendor for a member or change how they reach it, leaving their other vendors alone. */
  async assign(actor: Actor, name: string, vendor: string, input: { mode?: unknown; apiKey?: unknown; cliAccount?: unknown }) {
    await this.member(name)
    const result = await this.vendors.assign(name, vendor, input)
    await this.audit(actor, 'member-assign', name, `${vendor}:${result.mode}`)
    return result
  }

  async unassign(actor: Actor, name: string, vendor: string): Promise<void> {
    await this.member(name)
    await this.atomically(async () => {
      await this.vendors.setMemberVendors(name, (await this.vendors.assignments(name)).filter(a => a.vendor !== vendor).map(({ vendor: v, mode }) => ({ vendor: v, mode })))
      await this.audit(actor, 'member-unassign', name, vendor)
    })
  }

  async issueKey(actor: Actor, name: string, label: unknown): Promise<IssuedKey> {
    const target = await this.member(name)
    if (target.status !== 'active') throw new Refusal(409, '成员已停用')
    const issued = await issueInternalKey(this.store, name, label)
    await this.audit(actor, 'key-issue', issued.id, `${name} ${issued.label}`)
    return issued
  }

  // Devices: every credential, each belonging to a member

  async devices(member?: string): Promise<DeviceView[]> {
    return (await this.store.listCredentials(member)).map(deviceView)
  }

  async revokeDevice(actor: Actor, id: string): Promise<void> {
    const credential = await this.store.credential(id)
    if (credential === undefined || credential.revokedAt !== null) throw new Refusal(404, '设备不存在或已吊销')
    await this.store.revokeCredential(id)
    await this.audit(actor, 'credential-revoke', id, `${credential.member} ${credential.kind} ${credential.label}`)
  }

  // Vendors and models

  async vendorList() {
    const keys = await this.vendors.listKeys()
    const accounts = await this.vendors.listAccounts()
    const assignments = await this.vendors.assignments()
    const usage = new Map((await this.store.vendorUsageSince(this.now() - 30 * DAY_MS)).map(row => [row.vendor, row.tokens]))
    return (await this.vendors.listVendors()).map(v => ({
      ...v,
      keys: keys.filter(k => k.vendor === v.id).length,
      activeKeys: keys.filter(k => k.vendor === v.id && k.status === 'active').length,
      accounts: accounts.filter(a => a.vendor === v.id).length,
      members: assignments.filter(a => a.vendor === v.id).length,
      // Members enabled but still waiting for a key or a free account.
      waiting: assignments.filter(a => a.vendor === v.id && (v.auth === 'key' ? a.apiKey === null : a.cliAccount === null)).length,
      tokens30d: usage.get(v.id) ?? 0,
    }))
  }

  async addVendor(actor: Actor, input: Record<string, unknown>) {
    const vendor = await this.vendors.addVendor(input)
    await this.audit(actor, 'vendor-add', vendor.id, `${vendor.name} ${vendor.type}/${vendor.auth}${vendor.baseUrl === null ? '' : ` ${vendor.baseUrl}`}`)
    return vendor
  }

  async updateVendor(actor: Actor, id: string, input: Record<string, unknown>) {
    const vendor = await this.vendors.updateVendor(id, input)
    await this.audit(actor, 'vendor-update', id, `${vendor.name}${vendor.baseUrl === null ? '' : ` ${vendor.baseUrl}`}`)
    return vendor
  }

  async deleteVendor(actor: Actor, id: string): Promise<void> {
    await this.vendors.deleteVendor(id)
    await this.audit(actor, 'vendor-delete', id)
  }

  async refreshCatalog(actor: Actor, id: string) {
    const vendor = await this.vendors.refreshCatalog(id)
    await this.audit(actor, 'vendor-catalog', id, `${String(vendor.catalog.length)} models listed`)
    return vendor
  }

  async setModels(actor: Actor, id: string, models: unknown) {
    const vendor = await this.vendors.setModels(id, models)
    await this.audit(actor, 'vendor-models', id, vendor.models.map(m => m.id).join(', ') || 'none')
    return vendor
  }

  // API keys

  async keys() {
    const assignments = await this.vendors.assignments()
    const usage = new Map((await this.store.usageByKeySince(this.now() - 30 * DAY_MS)).map(row => [row.apiKey, row]))
    return (await this.vendors.listKeys()).map(k => ({
      ...k,
      members: assignments.filter(a => a.apiKey === k.id).map(a => a.member),
      requests30d: usage.get(k.id)?.requests ?? 0,
      tokens30d: usage.get(k.id)?.tokens ?? 0,
    }))
  }

  async addKey(actor: Actor, input: Record<string, unknown>) {
    const holder = await optionalMember(this.store, input.member)
    const key = await this.vendors.addKey(String(input.vendor ?? ''), input.label, input.key, input.mode ?? 'shared', holder)
    await this.audit(actor, 'key-add', key.id, `${key.vendor} ${key.label} …${key.last4} ${key.mode}${holder === null ? '' : ` → ${holder}`}`)
    return key
  }

  async setKeyStatus(actor: Actor, id: string, status: unknown) {
    const key = await this.vendors.setKeyStatus(id, status)
    await this.audit(actor, key.status === 'active' ? 'key-enable' : 'key-disable', id, `${key.vendor} ${key.label}`)
    return key
  }

  async deleteKey(actor: Actor, id: string): Promise<void> {
    const key = await this.vendors.deleteKey(id)
    await this.audit(actor, 'key-delete', id, `${key.vendor} ${key.label} …${key.last4}`)
  }

  // Subscriptions and accounts

  async subscriptions() {
    return this.vendors.listSubscriptions()
  }

  async addSubscription(actor: Actor, input: Record<string, unknown>) {
    const sub = await this.vendors.addSubscription(input)
    await this.audit(actor, 'subscription-add', sub.id, `${sub.vendor} ${sub.plan} × ${String(sub.seats)}`)
    return sub
  }

  async updateSubscription(actor: Actor, id: string, input: Record<string, unknown>) {
    const sub = await this.vendors.updateSubscription(id, input)
    await this.audit(actor, 'subscription-update', id, `${sub.plan} × ${String(sub.seats)}`)
    return sub
  }

  async deleteSubscription(actor: Actor, id: string): Promise<void> {
    const sub = await this.vendors.deleteSubscription(id)
    await this.audit(actor, 'subscription-delete', id, `${sub.vendor} ${sub.plan}`)
  }

  async accounts() {
    const holders = new Map((await this.vendors.assignments()).filter(a => a.cliAccount !== null).map(a => [a.cliAccount, a.member]))
    return (await this.vendors.listAccounts()).map(a => ({ ...a, member: holders.get(a.id) ?? null }))
  }

  async addAccount(actor: Actor, input: Record<string, unknown>) {
    const holder = await optionalMember(this.store, input.member)
    const account = await this.vendors.addAccount(String(input.subscription ?? input.vendor ?? ''), input.account, input.note, holder)
    await this.audit(actor, 'account-add', account.id, `${account.vendor} ${account.account}${holder === null ? '' : ` → ${holder}`}`)
    return account
  }

  async releaseAccount(actor: Actor, id: string): Promise<string | null> {
    const account = await this.vendors.account(id)
    if (account === undefined) throw new Refusal(404, '账号不存在')
    const from = await this.vendors.releaseAccount(id)
    await this.audit(actor, 'account-release', id, `${account.account}${from === null ? '' : ` ← ${from}`}`)
    return from
  }

  async deleteAccount(actor: Actor, id: string): Promise<void> {
    const account = await this.vendors.deleteAccount(id)
    await this.audit(actor, 'account-delete', account.id, `${account.vendor} ${account.account}`)
  }

  // Plugin catalog

  async plugins() {
    return { plugins: await this.catalog.list(), installs: await this.catalog.installs() }
  }

  /** Download and read a package before registering it: what the administrator is about to publish. */
  async inspectPlugin(url: unknown): Promise<PluginPackage & { registered: string | null }> {
    const pkg = await fetchPackage(packageUrl(url), this.fetch)
    return { ...pkg, registered: (await this.catalog.get(pkg.name))?.version ?? null }
  }

  async registerPlugin(actor: Actor, input: Record<string, unknown>) {
    const url = packageUrl(input.url)
    const meta = pluginMeta(input)
    const pkg = await fetchPackage(url, this.fetch)
    if (await this.catalog.get(pkg.name) !== undefined) throw new Refusal(409, `${pkg.name} 已经登记过，请在它那一行“更新版本”`)
    const plugin = await this.catalog.save(pkg, url, { ...meta, status: input.publish === true ? 'published' : 'hidden' })
    await this.audit(actor, 'plugin-add', plugin.name, `${plugin.version} ${plugin.status}`)
    return plugin
  }

  /** A new version of a registered plugin, from a new package. */
  async updatePlugin(actor: Actor, name: string, url: unknown) {
    const current = await this.catalog.get(name)
    if (current === undefined) throw new Refusal(404, `没有插件 ${name}`)
    const pkg = await fetchPackage(packageUrl(url), this.fetch)
    const plugin = await this.catalog.save(pkg, packageUrl(url), { displayName: current.displayName, permissions: current.permissions, preinstalled: current.preinstalled }, name)
    await this.audit(actor, 'plugin-update', name, `${current.version} → ${plugin.version}`)
    return plugin
  }

  async describePlugin(actor: Actor, name: string, input: Record<string, unknown>) {
    const plugin = await this.catalog.describe(name, pluginMeta(input))
    await this.audit(actor, 'plugin-describe', name)
    return plugin
  }

  async setPluginStatus(actor: Actor, name: string, status: unknown) {
    const plugin = await this.catalog.setStatus(name, status)
    await this.audit(actor, plugin.status === 'published' ? 'plugin-publish' : 'plugin-hide', name, plugin.version)
    return plugin
  }

  async deletePlugin(actor: Actor, name: string): Promise<void> {
    const plugin = await this.catalog.delete(name)
    await this.audit(actor, 'plugin-delete', name, plugin.version)
  }

  // Tunnels

  // 语音 (GL Work for iOS)

  /** The voice vendors with their keys and members, the settings, the voices, and the last day's token trades. */
  async voice() {
    const keys = await this.vendors.listKeys()
    const assignments = await this.vendors.assignments()
    const vendors = []
    for (const v of await this.voiceStore.voiceVendors()) {
      vendors.push({
        id: v.id, name: v.name, protocol: v.protocol,
        activeKeys: keys.filter(k => k.vendor === v.id && k.status === 'active').length,
        members: assignments.filter(a => a.vendor === v.id && a.apiKey !== null).map(a => a.member),
        waiting: assignments.filter(a => a.vendor === v.id && a.apiKey === null).map(a => a.member),
        catalogAt: await this.voiceStore.catalogAt(v.id),
      })
    }
    return {
      settings: await this.voiceStore.settings(),
      vendors,
      voices: await this.voiceStore.catalog(),
      tokens: await this.voiceStore.tokensSince(this.now() - DAY_MS),
    }
  }

  async setVoiceSettings(actor: Actor, input: Record<string, unknown>): Promise<VoiceSettings> {
    const before = JSON.stringify(await this.voiceStore.settings())
    const after = await this.voiceStore.setSettings(input)
    if (JSON.stringify(after) !== before) {
      const vendors = Object.entries(after.vendors).map(([id, v]) => `${id} 识别${v.asr ? '开' : '关'}(${v.asrModel}) 播报${v.tts ? '开' : '关'}(${v.ttsModel})`)
      await this.audit(actor, 'voice-settings', null, `${vendors.join('; ')}; 令牌 ${String(after.tokenTtlSeconds)} 秒, 每小时 ${String(after.tokensPerHour)} 次`)
    }
    return after
  }

  async refreshVoices(actor: Actor, vendor: string) {
    const result = await this.voiceStore.refreshCatalog(vendor, this.fetch)
    await this.audit(actor, 'voice-catalog', vendor, `${String(result.voices)} voices, ${String(result.added)} new`)
    return result
  }

  /** A voice's sample for the console's 试听 (administrators only; previews are not audited). */
  async voiceSample(vendor: string, voice: string) {
    return this.voiceStore.sample(vendor, voice, this.fetch)
  }

  /** Add a voice to the library members pick from, hide it for now, show it again, or take it out. */
  async setVoiceState(actor: Actor, vendor: string, voice: unknown, state: unknown) {
    const entry = await this.voiceStore.setVoiceState(vendor, voice, state)
    await this.audit(actor, 'voice-voices', vendor, `${entry.id} ${entry.state}`)
    return entry
  }

  /** Every tunnel with its owner's device, the domains, the settings, and who may open which kind. */
  async tunnels() {
    const devices = new Map((await this.store.listCredentials()).filter(c => c.kind === 'device').map(c => [c.id, c]))
    return {
      server: this.tunnelStore.server,
      publicIp: this.config.frps?.publicIp ?? null,
      settings: await this.tunnelStore.settings(),
      domains: await this.tunnelStore.domains(),
      tunnels: (await this.tunnelStore.list()).map(t => ({ ...t, deviceLabel: devices.get(t.device)?.label ?? null, deviceRevoked: devices.get(t.device)?.revokedAt != null })),
      members: (await this.store.listMembers()).map(m => ({ name: m.name, displayName: m.displayName, githubId: m.githubId, status: m.status, tunnels: m.tunnels, ssh: m.ssh })),
    }
  }

  async setTunnelSettings(actor: Actor, input: Record<string, unknown>) {
    const before = await this.tunnelStore.settings()
    const after = await this.tunnelStore.setSettings(input)
    const changed = (Object.keys(after) as (keyof TunnelSettings)[]).filter(k => after[k] !== before[k]).map(k => `${String(k)} ${String(after[k])}`)
    if (changed.length > 0) await this.audit(actor, 'tunnel-settings', null, changed.join(', '))
    return after
  }

  async addTunnelDomain(actor: Actor, input: Record<string, unknown>) {
    const domain = await this.tunnelStore.addDomain(input)
    await this.audit(actor, 'tunnel-domain-add', domain.name)
    return domain
  }

  async checkTunnelDomain(name: string) {
    return this.tunnelStore.checkDomain(name)
  }

  async setDefaultTunnelDomain(actor: Actor, name: string): Promise<void> {
    await this.tunnelStore.setDefaultDomain(name)
    await this.audit(actor, 'tunnel-domain-default', name)
  }

  async deleteTunnelDomain(actor: Actor, name: string): Promise<void> {
    await this.tunnelStore.deleteDomain(name)
    await this.audit(actor, 'tunnel-domain-delete', name)
  }

  /** Close a tunnel (frps refuses it until reopened) or reopen it. */
  async setTunnelClosed(actor: Actor, id: string, closed: boolean) {
    const tunnel = await this.tunnelStore.setClosed(id, closed ? actor.member.name : null)
    await this.audit(actor, closed ? 'tunnel-close' : 'tunnel-reopen', id, `${tunnel.member} ${tunnel.type} ${tunnel.name}`)
    return tunnel
  }

  async deleteTunnel(actor: Actor, id: string): Promise<void> {
    const tunnel = await this.tunnelStore.delete(id)
    await this.audit(actor, 'tunnel-delete', id, `${tunnel.member} ${tunnel.type} ${tunnel.name}`)
  }

  // System config

  async systemConfig() {
    return { canSeal: this.vendors.canSeal, entries: await this.vendors.listPublic() }
  }

  async setConfig(actor: Actor, input: Record<string, unknown>) {
    const entry = await this.vendors.setPublic(input.key, input.value, input.secret, input.note, input.group)
    // Never the value: secret or not, it is configuration other people read.
    await this.audit(actor, 'config-set', entry.key, entry.secret ? 'secret' : null)
    return entry
  }

  async deleteConfig(actor: Actor, key: string): Promise<void> {
    await this.vendors.deletePublic(key)
    await this.audit(actor, 'config-delete', key)
  }
}

/** What any signed-in member may see and do about themselves. */
export class SelfService {
  private readonly config: GatewayConfig
  private readonly store: Store
  private readonly vendors: Vendors

  constructor(deps: ServiceDeps) {
    this.config = deps.config
    this.store = deps.store
    this.vendors = deps.vendors
  }

  /** The member whose view is read: the viewer, or for administrators a previewed member. */
  async subject(viewer: Member, as: string | null | undefined): Promise<Member> {
    if (as === null || as === undefined || as === '' || as === viewer.name) return viewer
    if (viewer.role !== 'admin') throw new Refusal(403, '只有管理员能预览其他成员')
    const member = await this.store.member(as)
    if (member === undefined) throw new Refusal(404, `没有成员 ${as}`)
    return member
  }

  async profile(member: Member) {
    const keys = new Map((await this.vendors.listKeys()).map(k => [k.id, k]))
    const accounts = new Map((await this.vendors.listAccounts()).map(a => [a.id, a]))
    const subscriptions = new Map((await this.vendors.listSubscriptions()).map(s => [s.id, s]))
    const vendors = new Map((await this.vendors.listVendors()).map(v => [v.id, v]))
    return {
      member,
      gateway: `${this.config.publicOrigin}/agent-work/llm`,
      configUrl: `${this.config.publicOrigin}/agent-work/config/system`,
      vendors: (await this.vendors.assignments(member.name)).flatMap((a) => {
        const vendor = vendors.get(a.vendor)
        if (vendor === undefined) return []
        const key = a.apiKey === null ? undefined : keys.get(a.apiKey)
        const account = a.cliAccount === null ? undefined : accounts.get(a.cliAccount)
        return [{
          vendor: vendor.id, name: vendor.name, type: vendor.type, auth: vendor.auth, protocol: vendor.protocol, mode: a.mode,
          models: vendor.models, url: vendor.auth === 'key' ? `${this.config.publicOrigin}/agent-work/llm/${vendor.id}` : null,
          // Only what identifies the key; the key itself never leaves the server.
          key: key === undefined || key.status !== 'active' ? null : { label: key.label, last4: key.last4 },
          account: account === undefined ? null : { account: account.account, plan: account.subscription === null ? null : subscriptions.get(account.subscription)?.plan ?? null },
        }]
      }),
    }
  }

  async devices(member: Member): Promise<DeviceView[]> {
    return (await this.store.listCredentials(member.name)).map(deviceView)
  }

  /** System config as members see it in the console: secret values masked (tools read them with a key). */
  async systemConfig() {
    return (await this.vendors.listPublic()).map(({ key, value, secret, note, group }) => ({ key, value, secret, note, group }))
  }

  async issueKey(actor: Actor, label: unknown): Promise<IssuedKey> {
    const issued = await issueInternalKey(this.store, actor.member.name, label)
    await this.store.audit({ actor: actor.member.name, action: 'key-issue', target: issued.id, detail: `${actor.member.name} ${issued.label}`, ip: actor.ip })
    return issued
  }

  /** Revoke one of the member's own credentials; anyone else's answers as missing. */
  async revoke(actor: Actor, id: string): Promise<void> {
    const credential = await this.store.credential(id)
    if (credential === undefined || credential.member !== actor.member.name || credential.revokedAt !== null) throw new Refusal(404, '没有这个设备或 Key')
    await this.store.revokeCredential(id)
    await this.store.audit({ actor: actor.member.name, action: 'credential-revoke', target: id, detail: `${actor.member.name} ${credential.kind} ${credential.label}`, ip: actor.ip })
  }
}
