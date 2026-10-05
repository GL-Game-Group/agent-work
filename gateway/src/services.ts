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
  /** Downloads plugin packages; injectable for tests. */
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

function optionalMember(store: Store, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const name = String(value)
  if (store.member(name) === undefined) throw new Refusal(404, `没有成员 ${name}`)
  return name
}

/** A freshly issued internal key; the token is shown this once. */
export interface IssuedKey {
  id: string
  label: string
  token: string
  createdAt: number
}

function issueInternalKey(store: Store, member: string, label: unknown): IssuedKey {
  const name = typeof label === 'string' ? label.trim() : ''
  if (name === '' || name.length > 40) throw new Refusal(400, '请填写用途（最多 40 个字符）')
  if (store.listCredentials(member).filter(c => c.kind === 'key').length >= MAX_INTERNAL_KEYS) throw new Refusal(409, '内部 Key 太多了，先吊销不用的')
  const { credential, token } = store.issueCredential(member, 'key', name, INTERNAL_KEY_TTL_MS)
  return { id: credential.id, label: credential.label, token, createdAt: credential.createdAt }
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
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(deps: ServiceDeps) {
    this.config = deps.config
    this.store = deps.store
    this.github = deps.github
    this.vendors = deps.vendors
    this.catalog = deps.plugins ?? new PluginCatalog(deps.store, deps.now)
    this.tunnelStore = deps.tunnels ?? new Tunnels(deps.store, deps.config, deps.now)
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  private audit(actor: Actor, action: string, target: string | null, detail: string | null = null): void {
    this.store.audit({ actor: actor.member.name, action, target, detail, ip: actor.ip })
  }

  private member(name: string): Member {
    const found = this.store.member(name)
    if (found === undefined) throw new Refusal(404, `没有成员 ${name}`)
    return found
  }

  /** Refuse changes that would leave no active administrator, or lock the caller out. */
  private keepAnAdmin(actor: Actor, target: Member, after: { role?: Role; status?: 'active' | 'disabled'; deleted?: boolean }): void {
    const losesAdmin = target.role === 'admin' && target.status === 'active'
      && (after.deleted === true || after.role === 'member' || after.status === 'disabled')
    if (!losesAdmin) return
    if (target.name === actor.member.name) throw new Refusal(409, '不能停用、降级或删除自己的管理员账号')
    if (this.store.listMembers().filter(m => m.role === 'admin' && m.status === 'active').length <= 1) throw new Refusal(409, '至少需要保留一个有效的管理员')
  }

  // Overview and records

  overview() {
    const week = this.store.usageSince(this.now() - 7 * DAY_MS)
    return {
      productName: this.config.productName ?? 'GL Work',
      publicOrigin: this.config.publicOrigin,
      githubOrg: this.config.github.org || null,
      secretKey: this.vendors.canSeal,
      usage7d: {
        requests: week.reduce((sum, row) => sum + row.requests, 0),
        tokens: week.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0),
      },
      daily: this.store.dailyVendorUsageSince(this.now() - 14 * DAY_MS),
    }
  }

  usage(days: number) {
    if (!(USAGE_WINDOWS as readonly number[]).includes(days)) throw new Refusal(400, '只支持 1、7、30、90 天')
    const since = this.now() - days * DAY_MS
    const totals = new Map(this.store.usageSince(since).map(row => [row.member, row]))
    return {
      days,
      daily: this.store.dailyVendorUsageSince(since),
      members: this.store.listMembers().map(m => ({
        member: m.name, displayName: m.displayName,
        requests: totals.get(m.name)?.requests ?? 0,
        inputTokens: totals.get(m.name)?.inputTokens ?? 0,
        outputTokens: totals.get(m.name)?.outputTokens ?? 0,
        cacheReadTokens: totals.get(m.name)?.cacheReadTokens ?? 0,
      })),
      byVendor: this.store.memberVendorUsageSince(since),
      keys: this.keys().map(k => ({ id: k.id, vendor: k.vendor, label: k.label, last4: k.last4, ...this.store.keyUsageSince(k.id, since) })),
    }
  }

  auditLog(limit = 200) {
    return this.store.recentAudit(Math.min(Math.max(limit, 1), 1000))
  }

  // Members

  members() {
    const credentials = new Map(this.store.credentialSummary().map(row => [row.member, row]))
    const usage = new Map(this.store.usageSince(this.now() - 30 * DAY_MS).map(row => [row.member, row]))
    const assignments = this.vendors.assignments()
    return this.store.listMembers().map(m => ({
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
    if (this.store.member(name) !== undefined) throw new Refusal(409, `成员 ${name} 已存在`)
    const enabled = input.vendors ?? []
    if (!Array.isArray(enabled)) throw new Refusal(400, '厂商列表格式不正确')
    for (const entry of enabled as unknown[]) this.vendors.mustVendor(String(typeof entry === 'string' ? entry : (entry as { vendor?: unknown }).vendor ?? ''))
    let user
    try { user = await this.github.lookup(login) } catch { throw new Refusal(404, `GitHub 上找不到用户 ${login}`) }
    const holder = this.store.memberByGithubId(user.id)
    if (holder !== undefined) throw new Refusal(409, `GitHub 账号 ${user.login} 已属于成员 ${holder.name}`)
    this.store.addMember({
      name, githubId: user.id, githubLogin: user.login, role: newRole, displayName: name2, team: memberTeam,
      ...typeof input.tunnels === 'boolean' ? { tunnels: input.tunnels } : {},
    })
    this.audit(actor, 'member-add', name, `github ${user.login} (${String(user.id)}), ${newRole}`)
    if (enabled.length > 0) {
      const result = this.vendors.setMemberVendors(name, enabled)
      this.audit(actor, 'member-vendors', name, result.map(a => `${a.vendor}:${a.mode}`).join(', '))
    }
    return this.member(name)
  }

  setStatus(actor: Actor, name: string, status: unknown): Member {
    const target = this.member(name)
    if (status !== 'active' && status !== 'disabled') throw new Refusal(400, '状态只能是正常或停用')
    this.keepAnAdmin(actor, target, { status })
    this.store.setStatus(name, status)
    this.audit(actor, status === 'disabled' ? 'member-disable' : 'member-enable', name)
    return this.member(name)
  }

  setRole(actor: Actor, name: string, value: unknown): Member {
    const target = this.member(name)
    const next = role(value)
    this.keepAnAdmin(actor, target, { role: next })
    this.store.setRole(name, next)
    this.audit(actor, 'member-role', name, next)
    return this.member(name)
  }

  deleteMember(actor: Actor, name: string): void {
    const target = this.member(name)
    this.keepAnAdmin(actor, target, { deleted: true })
    this.store.deleteMember(name)
    this.vendors.rebalance()
    this.audit(actor, 'member-delete', name, `github ${target.githubLogin}`)
  }

  setProfile(actor: Actor, name: string, input: Record<string, unknown>): Member {
    const target = this.member(name)
    this.store.setProfile(name, { displayName: displayName(input.displayName, target.displayName), ...'team' in input ? { team: team(input.team) } : {} })
    this.audit(actor, 'member-profile', name)
    return this.member(name)
  }

  setTunnelGrants(actor: Actor, name: string, input: { tunnels?: unknown; ssh?: unknown }): Member {
    this.member(name)
    const grants: { tunnels?: boolean; ssh?: boolean } = {}
    if (typeof input.tunnels === 'boolean') grants.tunnels = input.tunnels
    if (typeof input.ssh === 'boolean') grants.ssh = input.ssh
    this.store.setTunnelGrants(name, grants)
    this.audit(actor, 'member-tunnels', name, Object.entries(grants).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', '))
    return this.member(name)
  }

  setMemberVendors(actor: Actor, name: string, entries: unknown) {
    this.member(name)
    const result = this.vendors.setMemberVendors(name, entries)
    this.audit(actor, 'member-vendors', name, result.map(a => `${a.vendor}:${a.mode}`).join(', ') || 'none')
    return result
  }

  /** Enable one vendor for a member or change how they reach it, leaving their other vendors alone. */
  assign(actor: Actor, name: string, vendor: string, input: { mode?: unknown; apiKey?: unknown; cliAccount?: unknown }) {
    this.member(name)
    const result = this.vendors.assign(name, vendor, input)
    this.audit(actor, 'member-assign', name, `${vendor}:${result.mode}`)
    return result
  }

  unassign(actor: Actor, name: string, vendor: string): void {
    this.member(name)
    this.vendors.setMemberVendors(name, this.vendors.assignments(name).filter(a => a.vendor !== vendor).map(({ vendor: v, mode }) => ({ vendor: v, mode })))
    this.audit(actor, 'member-unassign', name, vendor)
  }

  issueKey(actor: Actor, name: string, label: unknown): IssuedKey {
    const target = this.member(name)
    if (target.status !== 'active') throw new Refusal(409, '成员已停用')
    const issued = issueInternalKey(this.store, name, label)
    this.audit(actor, 'key-issue', issued.id, `${name} ${issued.label}`)
    return issued
  }

  // Devices: every credential, each belonging to a member

  devices(member?: string): DeviceView[] {
    return this.store.listCredentials(member).map(deviceView)
  }

  revokeDevice(actor: Actor, id: string): void {
    const credential = this.store.credential(id)
    if (credential === undefined || credential.revokedAt !== null) throw new Refusal(404, '设备不存在或已吊销')
    this.store.revokeCredential(id)
    this.audit(actor, 'credential-revoke', id, `${credential.member} ${credential.kind} ${credential.label}`)
  }

  // Vendors and models

  vendorList() {
    const keys = this.vendors.listKeys()
    const accounts = this.vendors.listAccounts()
    const assignments = this.vendors.assignments()
    const usage = new Map(this.store.vendorUsageSince(this.now() - 30 * DAY_MS).map(row => [row.vendor, row.tokens]))
    return this.vendors.listVendors().map(v => ({
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

  addVendor(actor: Actor, input: Record<string, unknown>) {
    const vendor = this.vendors.addVendor(input)
    this.audit(actor, 'vendor-add', vendor.id, `${vendor.name} ${vendor.type}/${vendor.auth}${vendor.baseUrl === null ? '' : ` ${vendor.baseUrl}`}`)
    return vendor
  }

  updateVendor(actor: Actor, id: string, input: Record<string, unknown>) {
    const vendor = this.vendors.updateVendor(id, input)
    this.audit(actor, 'vendor-update', id, `${vendor.name}${vendor.baseUrl === null ? '' : ` ${vendor.baseUrl}`}`)
    return vendor
  }

  deleteVendor(actor: Actor, id: string): void {
    this.vendors.deleteVendor(id)
    this.audit(actor, 'vendor-delete', id)
  }

  async refreshCatalog(actor: Actor, id: string) {
    const vendor = await this.vendors.refreshCatalog(id)
    this.audit(actor, 'vendor-catalog', id, `${String(vendor.catalog.length)} models listed`)
    return vendor
  }

  setModels(actor: Actor, id: string, models: unknown) {
    const vendor = this.vendors.setModels(id, models)
    this.audit(actor, 'vendor-models', id, vendor.models.map(m => m.id).join(', ') || 'none')
    return vendor
  }

  // API keys

  keys() {
    const assignments = this.vendors.assignments()
    const usage = new Map(this.store.usageByKeySince(this.now() - 30 * DAY_MS).map(row => [row.apiKey, row]))
    return this.vendors.listKeys().map(k => ({
      ...k,
      members: assignments.filter(a => a.apiKey === k.id).map(a => a.member),
      requests30d: usage.get(k.id)?.requests ?? 0,
      tokens30d: usage.get(k.id)?.tokens ?? 0,
    }))
  }

  addKey(actor: Actor, input: Record<string, unknown>) {
    const holder = optionalMember(this.store, input.member)
    const key = this.vendors.addKey(String(input.vendor ?? ''), input.label, input.key, input.mode ?? 'shared', holder)
    this.audit(actor, 'key-add', key.id, `${key.vendor} ${key.label} …${key.last4} ${key.mode}${holder === null ? '' : ` → ${holder}`}`)
    return key
  }

  setKeyStatus(actor: Actor, id: string, status: unknown) {
    const key = this.vendors.setKeyStatus(id, status)
    this.audit(actor, key.status === 'active' ? 'key-enable' : 'key-disable', id, `${key.vendor} ${key.label}`)
    return key
  }

  deleteKey(actor: Actor, id: string): void {
    const key = this.vendors.deleteKey(id)
    this.audit(actor, 'key-delete', id, `${key.vendor} ${key.label} …${key.last4}`)
  }

  // Subscriptions and accounts

  subscriptions() {
    return this.vendors.listSubscriptions()
  }

  addSubscription(actor: Actor, input: Record<string, unknown>) {
    const sub = this.vendors.addSubscription(input)
    this.audit(actor, 'subscription-add', sub.id, `${sub.vendor} ${sub.plan} × ${String(sub.seats)}`)
    return sub
  }

  updateSubscription(actor: Actor, id: string, input: Record<string, unknown>) {
    const sub = this.vendors.updateSubscription(id, input)
    this.audit(actor, 'subscription-update', id, `${sub.plan} × ${String(sub.seats)}`)
    return sub
  }

  deleteSubscription(actor: Actor, id: string): void {
    const sub = this.vendors.deleteSubscription(id)
    this.audit(actor, 'subscription-delete', id, `${sub.vendor} ${sub.plan}`)
  }

  accounts() {
    const holders = new Map(this.vendors.assignments().filter(a => a.cliAccount !== null).map(a => [a.cliAccount, a.member]))
    return this.vendors.listAccounts().map(a => ({ ...a, member: holders.get(a.id) ?? null }))
  }

  addAccount(actor: Actor, input: Record<string, unknown>) {
    const holder = optionalMember(this.store, input.member)
    const account = this.vendors.addAccount(String(input.subscription ?? input.vendor ?? ''), input.account, input.note, holder)
    this.audit(actor, 'account-add', account.id, `${account.vendor} ${account.account}${holder === null ? '' : ` → ${holder}`}`)
    return account
  }

  releaseAccount(actor: Actor, id: string): string | null {
    const account = this.vendors.account(id)
    if (account === undefined) throw new Refusal(404, '账号不存在')
    const from = this.vendors.releaseAccount(id)
    this.audit(actor, 'account-release', id, `${account.account}${from === null ? '' : ` ← ${from}`}`)
    return from
  }

  deleteAccount(actor: Actor, id: string): void {
    const account = this.vendors.deleteAccount(id)
    this.audit(actor, 'account-delete', account.id, `${account.vendor} ${account.account}`)
  }

  // Plugin catalog

  plugins() {
    return { plugins: this.catalog.list(), installs: this.catalog.installs() }
  }

  /** Download and read a package before registering it: what the administrator is about to publish. */
  async inspectPlugin(url: unknown): Promise<PluginPackage & { registered: string | null }> {
    const pkg = await fetchPackage(packageUrl(url), this.fetch)
    return { ...pkg, registered: this.catalog.get(pkg.name)?.version ?? null }
  }

  async registerPlugin(actor: Actor, input: Record<string, unknown>) {
    const url = packageUrl(input.url)
    const meta = pluginMeta(input)
    const pkg = await fetchPackage(url, this.fetch)
    if (this.catalog.get(pkg.name) !== undefined) throw new Refusal(409, `${pkg.name} 已经登记过，请在它那一行“更新版本”`)
    const plugin = this.catalog.save(pkg, url, { ...meta, status: input.publish === true ? 'published' : 'hidden' })
    this.audit(actor, 'plugin-add', plugin.name, `${plugin.version} ${plugin.status}`)
    return plugin
  }

  /** A new version of a registered plugin, from a new package. */
  async updatePlugin(actor: Actor, name: string, url: unknown) {
    const current = this.catalog.get(name)
    if (current === undefined) throw new Refusal(404, `没有插件 ${name}`)
    const pkg = await fetchPackage(packageUrl(url), this.fetch)
    const plugin = this.catalog.save(pkg, packageUrl(url), { displayName: current.displayName, permissions: current.permissions, preinstalled: current.preinstalled }, name)
    this.audit(actor, 'plugin-update', name, `${current.version} → ${plugin.version}`)
    return plugin
  }

  describePlugin(actor: Actor, name: string, input: Record<string, unknown>) {
    const plugin = this.catalog.describe(name, pluginMeta(input))
    this.audit(actor, 'plugin-describe', name)
    return plugin
  }

  setPluginStatus(actor: Actor, name: string, status: unknown) {
    const plugin = this.catalog.setStatus(name, status)
    this.audit(actor, plugin.status === 'published' ? 'plugin-publish' : 'plugin-hide', name, plugin.version)
    return plugin
  }

  deletePlugin(actor: Actor, name: string): void {
    const plugin = this.catalog.delete(name)
    this.audit(actor, 'plugin-delete', name, plugin.version)
  }

  // Tunnels

  /** Every tunnel with its owner's device, the domains, the settings, and who may open which kind. */
  tunnels() {
    const devices = new Map(this.store.listCredentials().filter(c => c.kind === 'device').map(c => [c.id, c]))
    return {
      server: this.tunnelStore.server,
      publicIp: this.config.frps?.publicIp ?? null,
      settings: this.tunnelStore.settings(),
      domains: this.tunnelStore.domains(),
      tunnels: this.tunnelStore.list().map(t => ({ ...t, deviceLabel: devices.get(t.device)?.label ?? null, deviceRevoked: devices.get(t.device)?.revokedAt != null })),
      members: this.store.listMembers().map(m => ({ name: m.name, displayName: m.displayName, githubId: m.githubId, status: m.status, tunnels: m.tunnels, ssh: m.ssh })),
    }
  }

  setTunnelSettings(actor: Actor, input: Record<string, unknown>) {
    const before = this.tunnelStore.settings()
    const after = this.tunnelStore.setSettings(input)
    const changed = (Object.keys(after) as (keyof TunnelSettings)[]).filter(k => after[k] !== before[k]).map(k => `${String(k)} ${String(after[k])}`)
    if (changed.length > 0) this.audit(actor, 'tunnel-settings', null, changed.join(', '))
    return after
  }

  addTunnelDomain(actor: Actor, input: Record<string, unknown>) {
    const domain = this.tunnelStore.addDomain(input)
    this.audit(actor, 'tunnel-domain-add', domain.name)
    return domain
  }

  async checkTunnelDomain(name: string) {
    return this.tunnelStore.checkDomain(name)
  }

  setDefaultTunnelDomain(actor: Actor, name: string): void {
    this.tunnelStore.setDefaultDomain(name)
    this.audit(actor, 'tunnel-domain-default', name)
  }

  deleteTunnelDomain(actor: Actor, name: string): void {
    this.tunnelStore.deleteDomain(name)
    this.audit(actor, 'tunnel-domain-delete', name)
  }

  /** Close a tunnel (frps refuses it until reopened) or reopen it. */
  setTunnelClosed(actor: Actor, id: string, closed: boolean) {
    const tunnel = this.tunnelStore.setClosed(id, closed ? actor.member.name : null)
    this.audit(actor, closed ? 'tunnel-close' : 'tunnel-reopen', id, `${tunnel.member} ${tunnel.type} ${tunnel.name}`)
    return tunnel
  }

  deleteTunnel(actor: Actor, id: string): void {
    const tunnel = this.tunnelStore.delete(id)
    this.audit(actor, 'tunnel-delete', id, `${tunnel.member} ${tunnel.type} ${tunnel.name}`)
  }

  // System config

  systemConfig() {
    return { canSeal: this.vendors.canSeal, entries: this.vendors.listPublic() }
  }

  setConfig(actor: Actor, input: Record<string, unknown>) {
    const entry = this.vendors.setPublic(input.key, input.value, input.secret, input.note, input.group)
    // Never the value: secret or not, it is configuration other people read.
    this.audit(actor, 'config-set', entry.key, entry.secret ? 'secret' : null)
    return entry
  }

  deleteConfig(actor: Actor, key: string): void {
    this.vendors.deletePublic(key)
    this.audit(actor, 'config-delete', key)
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
  subject(viewer: Member, as: string | null | undefined): Member {
    if (as === null || as === undefined || as === '' || as === viewer.name) return viewer
    if (viewer.role !== 'admin') throw new Refusal(403, '只有管理员能预览其他成员')
    const member = this.store.member(as)
    if (member === undefined) throw new Refusal(404, `没有成员 ${as}`)
    return member
  }

  profile(member: Member) {
    const keys = new Map(this.vendors.listKeys().map(k => [k.id, k]))
    const accounts = new Map(this.vendors.listAccounts().map(a => [a.id, a]))
    const subscriptions = new Map(this.vendors.listSubscriptions().map(s => [s.id, s]))
    return {
      member,
      gateway: `${this.config.publicOrigin}/agent-work/llm`,
      configUrl: `${this.config.publicOrigin}/agent-work/config/system`,
      vendors: this.vendors.assignments(member.name).flatMap((a) => {
        const vendor = this.vendors.vendor(a.vendor)
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

  devices(member: Member): DeviceView[] {
    return this.store.listCredentials(member.name).map(deviceView)
  }

  /** System config as members see it in the console: secret values masked (tools read them with a key). */
  systemConfig() {
    return this.vendors.listPublic().map(({ key, value, secret, note, group }) => ({ key, value, secret, note, group }))
  }

  issueKey(actor: Actor, label: unknown): IssuedKey {
    const issued = issueInternalKey(this.store, actor.member.name, label)
    this.store.audit({ actor: actor.member.name, action: 'key-issue', target: issued.id, detail: `${actor.member.name} ${issued.label}`, ip: actor.ip })
    return issued
  }

  /** Revoke one of the member's own credentials; anyone else's answers as missing. */
  revoke(actor: Actor, id: string): void {
    const credential = this.store.credential(id)
    if (credential === undefined || credential.member !== actor.member.name || credential.revokedAt !== null) throw new Refusal(404, '没有这个设备或 Key')
    this.store.revokeCredential(id)
    this.store.audit({ actor: actor.member.name, action: 'credential-revoke', target: id, detail: `${actor.member.name} ${credential.kind} ${credential.label}`, ip: actor.ip })
  }
}
