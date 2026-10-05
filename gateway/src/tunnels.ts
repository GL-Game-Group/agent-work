/**
 * Tunnels through frp. Members define them in GL Work (whose frpc runs on
 * their machine); frps on the company server asks this service about every
 * client login, every tunnel it is about to open, and every heartbeat, so a
 * tunnel exists only as defined here, on the device that defined it:
 *
 * - web tunnels (`http`) at `<name>-<member>.<domain>`, under a domain an
 *   administrator added and whose DNS and certificate are in place;
 * - SSH tunnels (`stcp`): no public port; only the members the owner chose
 *   connect, through their own GL Work, with a key this service hands them;
 *   optionally also a public TCP port (`tcp`) when an administrator allows it;
 * - 手机远程 (`remote`, one per device): an `http` proxy under {@link REMOTE_DOMAIN},
 *   a name only the company service resolves (through frps on the compose
 *   network; Traefik routes no such name), so the member's phone reaches its
 *   Mac only through the company service's relay (server.ts), signed in.
 *
 * frpc logs in with the device token, and its frp user must be the token's
 * member, so the access lists frps enforces by user name name real members.
 */
import { randomBytes } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import type { DatabaseSync } from 'node:sqlite'
import { connect } from 'node:tls'
import type { GatewayConfig } from './config.ts'
import type { Credential, Member, Store } from './db.ts'
import { Refusal } from './errors.ts'
import { randomSecret, sameSecret } from './tokens.ts'

export type TunnelType = 'http' | 'ssh' | 'remote'

export interface TunnelSettings {
  enabled: boolean
  /** Web tunnels may go without a password. */
  allowPublic: boolean
  perMember: number
  /** SSH tunnels at all (members still need their own grant). */
  ssh: boolean
  /** SSH tunnels may also take a public TCP port. */
  publicTcp: boolean
  portRange: string
  /** Members may reach their own Macs from GL Work for iOS. */
  remote: boolean
}

export interface TunnelDomain {
  name: string
  isDefault: boolean
  dns: 'ok' | 'missing' | 'wrong' | 'unknown'
  cert: 'ok' | 'failed' | 'unknown'
  checkedAt: number | null
  note: string | null
  createdAt: number
}

export interface Tunnel {
  id: string
  member: string
  device: string
  type: TunnelType
  name: string
  domain: string | null
  /** Web tunnels: the address. */
  host: string | null
  localPort: number
  protection: 'public' | 'password'
  /** SSH tunnels: who may connect, or 'all' members. */
  sshAccess: 'all' | string[] | null
  publicPort: number | null
  /** The administrator who closed it; frps refuses it until reopened. */
  closedBy: string | null
  online: boolean
  lastSeenAt: number | null
  createdAt: number
  updatedAt: number
}

const DEFAULT_SETTINGS: TunnelSettings = { enabled: true, allowPublic: true, perMember: 5, ssh: true, publicTcp: false, portRange: '20000-20099', remote: true }
/** Where `remote` tunnels live: frps routes it, nothing public does. */
export const REMOTE_DOMAIN = 'remote.internal'
const NAME = /^[a-z][a-z0-9-]{0,30}$/u
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u
/**
 * GL Work's frpc pings every 30 s (transport.heartbeatInterval, which it must set:
 * with tcpMux frpc sends no heartbeats by default, and frps calls Ping only on
 * one); a tunnel not heard of in this long is offline whatever frps last said.
 */
const STALE_MS = 3 * 60_000

interface TunnelRow {
  id: string; member: string; device: string; type: TunnelType; name: string; domain: string | null; local_port: number
  protection: 'public' | 'password'; ssh_access: string | null; secret_key: string | null; public_port: number | null
  closed_by: string | null; online: number; last_seen_at: number | null; created_at: number; updated_at: number
}

function hostOf(row: Pick<TunnelRow, 'type' | 'name' | 'member' | 'domain'>): string | null {
  if (row.type === 'remote') return `${row.name}.${REMOTE_DOMAIN}`
  return row.type === 'http' && row.domain !== null ? `${row.name}-${row.member}.${row.domain}` : null
}

/** frp's plugin answers. */
const ALLOW = { reject: false, unchange: true } as const
const deny = (reason: string) => ({ reject: true, reject_reason: reason })
export type FrpAnswer = typeof ALLOW | ReturnType<typeof deny>

export class Tunnels {
  private readonly db: DatabaseSync
  private readonly store: Store
  private readonly config: GatewayConfig
  private readonly now: () => number

  constructor(store: Store, config: GatewayConfig, now: () => number = Date.now) {
    this.db = store.db
    this.store = store
    this.config = config
    this.now = now
  }

  /** Where frpc connects, or null while the company runs no frps. */
  get server(): { addr: string; port: number; protocol: 'wss' | 'tcp' } | null {
    const frps = this.config.frps
    return frps === undefined ? null : { addr: frps.addr, port: frps.port, protocol: frps.protocol }
  }

  // Settings

  settings(): TunnelSettings {
    const row = this.db.prepare(`select value from app_settings where key = 'tunnels'`).get() as { value: string } | undefined
    return { ...DEFAULT_SETTINGS, ...row === undefined ? {} : JSON.parse(row.value) as Partial<TunnelSettings> }
  }

  setSettings(input: Record<string, unknown>): TunnelSettings {
    const next = { ...this.settings() }
    for (const key of ['enabled', 'allowPublic', 'ssh', 'publicTcp', 'remote'] as const) if (typeof input[key] === 'boolean') next[key] = input[key]
    if (input.perMember !== undefined) {
      const n = Number(input.perMember)
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Refusal(400, '每人最多隧道数要在 1 到 50 之间')
      next.perMember = n
    }
    if (input.portRange !== undefined) {
      this.parseRange(String(input.portRange))
      next.portRange = String(input.portRange).trim()
    }
    this.db.prepare(`insert into app_settings (key, value) values ('tunnels', ?) on conflict (key) do update set value = excluded.value`).run(JSON.stringify(next))
    return next
  }

  private parseRange(value: string): [number, number] {
    const match = /^\s*(\d{4,5})\s*-\s*(\d{4,5})\s*$/u.exec(value)
    const [from, to] = match === null ? [0, 0] : [Number(match[1]), Number(match[2])]
    if (match === null || from < 1024 || to > 65535 || from > to || to - from > 1000) throw new Refusal(400, '端口范围格式是 20000-20099，在 1024 到 65535 之间，最多 1000 个')
    return [from, to]
  }

  // Domains

  domains(): TunnelDomain[] {
    const rows = this.db.prepare('select * from tunnel_domains order by is_default desc, created_at').all() as unknown as
      { name: string; is_default: number; dns: TunnelDomain['dns']; cert: TunnelDomain['cert']; checked_at: number | null; note: string | null; created_at: number }[]
    return rows.map(r => ({ name: r.name, isDefault: r.is_default === 1, dns: r.dns, cert: r.cert, checkedAt: r.checked_at, note: r.note, createdAt: r.created_at }))
  }

  /** Domains a web tunnel may use: DNS and certificate in place. */
  usableDomains(): TunnelDomain[] {
    return this.domains().filter(d => d.dns === 'ok' && d.cert === 'ok')
  }

  addDomain(input: { name?: unknown; note?: unknown }): TunnelDomain {
    const name = String(input.name ?? '').trim().toLowerCase().replace(/^\*\./u, '').replace(/\.$/u, '')
    if (!HOSTNAME.test(name)) throw new Refusal(400, '请填写有效的域名，例如 t.example.com')
    // Tunnels serve members' own code: never under the service's own name or a parent of it.
    const service = new URL(this.config.publicOrigin).hostname
    if (service === name || service.endsWith(`.${name}`)) throw new Refusal(400, `不能使用公司服务所在的域名（${service}）`)
    if (name === REMOTE_DOMAIN || name.endsWith(`.${REMOTE_DOMAIN}`) || REMOTE_DOMAIN.endsWith(`.${name}`)) throw new Refusal(400, `${REMOTE_DOMAIN} 留给手机远程使用`)
    if (this.domains().some(d => d.name === name)) throw new Refusal(409, '这个域名已经添加过了')
    const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim().slice(0, 60) : null
    this.db.prepare('insert into tunnel_domains (name, is_default, note, created_at) values (?, ?, ?, ?)').run(name, this.domains().length === 0 ? 1 : 0, note, this.now())
    return this.domains().find(d => d.name === name) as TunnelDomain
  }

  /**
   * Check a domain's wildcard DNS and certificate on a random name under it: it
   * must resolve, either to the server or to an edge in front of it (Cloudflare)
   * that demonstrably reaches this frps (its "not found" page for an unknown
   * tunnel), and HTTPS on it must verify.
   */
  async checkDomain(
    name: string,
    lookup: (host: string) => Promise<string[]> = host => new Resolver({ timeout: 5000 }).resolve4(host),
    reach: (host: string) => Promise<Reach> = reachesFrps,
  ): Promise<TunnelDomain> {
    const domain = this.domains().find(d => d.name === name)
    if (domain === undefined) throw new Refusal(404, `没有域名 ${name}`)
    const probe = `check-${randomSecret().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/gu, 'x')}.${name}`
    let dns: TunnelDomain['dns'] = 'missing'
    let addresses: string[] = []
    try {
      addresses = await lookup(probe)
      dns = addresses.length === 0 ? 'missing' : 'wrong'
    } catch { dns = 'missing' }
    let cert: TunnelDomain['cert'] = 'unknown'
    if (dns === 'wrong') {
      const publicIp = this.config.frps?.publicIp ?? null
      const reached = await reach(probe)
      const direct = publicIp === null || addresses.includes(publicIp)
      if (direct || reached.frps) dns = 'ok'
      cert = dns === 'ok' ? (reached.tls ? 'ok' : 'failed') : 'unknown'
    }
    this.db.prepare('update tunnel_domains set dns = ?, cert = ?, checked_at = ? where name = ?').run(dns, cert, this.now(), name)
    return this.domains().find(d => d.name === name) as TunnelDomain
  }

  /** For tests and the development seed: record a domain's state without probing. */
  markDomain(name: string, dns: TunnelDomain['dns'], cert: TunnelDomain['cert']): void {
    this.db.prepare('update tunnel_domains set dns = ?, cert = ?, checked_at = ? where name = ?').run(dns, cert, this.now(), name)
  }

  setDefaultDomain(name: string): void {
    const domain = this.domains().find(d => d.name === name)
    if (domain === undefined) throw new Refusal(404, `没有域名 ${name}`)
    if (domain.dns !== 'ok' || domain.cert !== 'ok') throw new Refusal(409, 'DNS 和证书都就绪后才能设为默认')
    this.db.prepare('update tunnel_domains set is_default = (name = ?)').run(name)
  }

  deleteDomain(name: string): void {
    const domain = this.domains().find(d => d.name === name)
    if (domain === undefined) throw new Refusal(404, `没有域名 ${name}`)
    if (domain.isDefault && this.domains().length > 1) throw new Refusal(409, '默认域名不能删除，请先把其他域名设为默认')
    const used = (this.db.prepare('select count(*) as n from tunnels where domain = ?').get(name) as { n: number }).n
    if (used > 0) throw new Refusal(409, `还有 ${String(used)} 条隧道在用这个域名`)
    this.db.prepare('delete from tunnel_domains where name = ?').run(name)
  }

  // Tunnels

  private toTunnel(row: TunnelRow): Tunnel {
    const fresh = row.last_seen_at !== null && this.now() - row.last_seen_at < STALE_MS
    return {
      id: row.id, member: row.member, device: row.device, type: row.type, name: row.name, domain: row.domain, host: hostOf(row),
      localPort: row.local_port, protection: row.protection,
      sshAccess: row.ssh_access === null ? null : row.ssh_access === 'all' ? 'all' : JSON.parse(row.ssh_access) as string[],
      publicPort: row.public_port, closedBy: row.closed_by, online: row.online === 1 && fresh, lastSeenAt: row.last_seen_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private row(id: string): TunnelRow | undefined {
    return this.db.prepare('select * from tunnels where id = ?').get(id) as TunnelRow | undefined
  }

  list(member?: string): Tunnel[] {
    const rows = member === undefined
      ? this.db.prepare('select * from tunnels order by member, created_at').all()
      : this.db.prepare('select * from tunnels where member = ? order by created_at').all(member)
    return (rows as unknown as TunnelRow[]).map(r => this.toTunnel(r))
  }

  get(id: string): Tunnel | undefined {
    const row = this.row(id)
    return row === undefined ? undefined : this.toTunnel(row)
  }

  /**
   * What one member's GL Work needs: their tunnels with frpc's settings, and the SSH tunnels shared with them.
   * @param device - the asking device's credential id: only its own tunnels run there.
   */
  forMember(member: Member, device: string | null = null) {
    const settings = this.settings()
    const own = (this.db.prepare('select * from tunnels where member = ? order by created_at').all(member.name) as unknown as TunnelRow[])
    const shared = (this.db.prepare(`select * from tunnels where type = 'ssh' and member != ? order by member, name`).all(member.name) as unknown as TunnelRow[])
      .filter(r => this.allowedUsers(r).includes('*') || this.allowedUsers(r).includes(member.name))
    return {
      member: member.name,
      device,
      server: this.server,
      settings: { enabled: settings.enabled && this.server !== null, allowPublic: settings.allowPublic, perMember: settings.perMember, ssh: settings.ssh, publicTcp: settings.publicTcp, remote: settings.remote },
      grants: { tunnels: member.tunnels, ssh: member.ssh },
      domains: this.usableDomains().map(d => ({ name: d.name, isDefault: d.isDefault })),
      tunnels: own.map(r => ({ ...this.toTunnel(r), secretKey: r.secret_key, allowUsers: r.type === 'ssh' ? this.allowedUsers(r) : null })),
      shared: shared.map(r => ({ id: r.id, owner: r.member, name: r.name, online: this.toTunnel(r).online, secretKey: r.secret_key })),
      // Whom an SSH tunnel may be opened to.
      colleagues: this.store.listMembers().filter(m => m.status === 'active' && m.name !== member.name).map(m => ({ name: m.name, displayName: m.displayName })),
    }
  }

  /** frp's allowUsers for an SSH tunnel. */
  private allowedUsers(row: Pick<TunnelRow, 'ssh_access'>): string[] {
    if (row.ssh_access === 'all') return ['*']
    return row.ssh_access === null ? [] : (JSON.parse(row.ssh_access) as string[]).toSorted()
  }

  private sshAccess(owner: string, value: unknown): string {
    if (value === 'all') return 'all'
    if (!Array.isArray(value) || value.length === 0) throw new Refusal(400, '请选择可以连接的同事，或允许全部成员')
    const names = [...new Set(value.map(String))].filter(n => n !== owner)
    for (const name of names) if (this.store.member(name) === undefined) throw new Refusal(400, `没有成员 ${name}`)
    if (names.length === 0) throw new Refusal(400, '请选择可以连接的同事')
    return JSON.stringify(names.toSorted())
  }

  private port(value: unknown): number {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal(400, '本机端口要在 1 到 65535 之间')
    return port
  }

  private freePublicPort(): number {
    const [from, to] = this.parseRange(this.settings().portRange)
    const used = new Set((this.db.prepare('select public_port from tunnels where public_port is not null').all() as { public_port: number }[]).map(r => r.public_port))
    for (let port = from; port <= to; port += 1) if (!used.has(port)) return port
    throw new Refusal(409, '公网端口已经分完了，请管理员扩大端口范围')
  }

  /** A member defines a tunnel on one of their devices. */
  create(member: Member, device: Credential, input: Record<string, unknown>): Tunnel {
    const settings = this.settings()
    if (!settings.enabled || this.server === null) throw new Refusal(409, '内网穿透没有开启')
    if (input.type === 'remote') return this.createRemote(member, device, settings)
    const type = input.type === 'ssh' ? 'ssh' : input.type === 'http' ? 'http' : null
    if (type === null) throw new Refusal(400, '隧道类型只能是网页或 SSH')
    if (type === 'http' && !member.tunnels) throw new Refusal(403, '你还没有开通网页隧道')
    if (type === 'ssh' && (!member.ssh || !settings.ssh)) throw new Refusal(403, '你还没有开通 SSH 隧道')
    const name = String(input.name ?? '').trim()
    if (!NAME.test(name)) throw new Refusal(400, '名字只能用小写字母、数字和 -，以字母开头（最长 31 个字符）')
    if (this.list(member.name).filter(t => t.type !== 'remote').length >= settings.perMember) throw new Refusal(409, `每人最多 ${String(settings.perMember)} 条隧道`)
    if (this.list(member.name).some(t => t.type === type && t.name === name)) throw new Refusal(409, `你已经有一条叫 ${name} 的隧道`)
    const localPort = this.port(input.localPort)
    let domain: string | null = null
    let protection: 'public' | 'password' = 'password'
    let sshAccess: string | null = null
    let secretKey: string | null = null
    let publicPort: number | null = null
    if (type === 'http') {
      const usable = this.usableDomains()
      domain = typeof input.domain === 'string' && input.domain !== '' ? input.domain : usable.find(d => d.isDefault)?.name ?? usable[0]?.name ?? null
      if (domain === null || !usable.some(d => d.name === domain)) throw new Refusal(400, '请选择一个可用的域名')
      if (`${name}-${member.name}`.length > 63) throw new Refusal(400, '名字和成员名加起来太长了')
      protection = input.protection === 'public' ? 'public' : 'password'
      if (protection === 'public' && !settings.allowPublic) throw new Refusal(400, '管理员要求网页隧道都设置访问密码')
    } else {
      sshAccess = this.sshAccess(member.name, input.sshAccess)
      secretKey = randomSecret().slice(0, 32)
      if (input.publicPort === true) {
        if (!settings.publicTcp) throw new Refusal(403, '管理员没有开放公网 TCP 端口')
        publicPort = this.freePublicPort()
      }
    }
    const id = `tun_${randomSecret().slice(0, 10).replace(/[^A-Za-z0-9]/gu, 'x')}`
    this.db.prepare(`insert into tunnels (id, member, device, type, name, domain, local_port, protection, ssh_access, secret_key, public_port, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, member.name, device.id, type, name, domain, localPort, protection, sshAccess, secretKey, publicPort, this.now(), this.now())
    return this.get(id) as Tunnel
  }

  /** 手机远程 for this device: one per device, so asking again returns the same one. */
  private createRemote(member: Member, device: Credential, settings: TunnelSettings): Tunnel {
    if (!settings.remote) throw new Refusal(403, '管理员没有开启手机远程')
    const existing = this.db.prepare(`select * from tunnels where type = 'remote' and device = ?`).get(device.id) as TunnelRow | undefined
    if (existing !== undefined) return this.toTunnel(existing)
    // The host name is the only thing frps routes on, so it is random rather than guessable.
    const name = `r${randomBytes(12).toString('hex')}`
    const id = `tun_${randomSecret().slice(0, 10).replace(/[^A-Za-z0-9]/gu, 'x')}`
    this.db.prepare(`insert into tunnels (id, member, device, type, name, domain, local_port, protection, created_at, updated_at)
      values (?, ?, ?, 'remote', ?, ?, 0, 'public', ?, ?)`)
      .run(id, member.name, device.id, name, REMOTE_DOMAIN, this.now(), this.now())
    return this.get(id) as Tunnel
  }

  /** The member's Macs that turned 手机远程 on, for the phone's list. */
  remotes(member: Member): { id: string; device: string; label: string; online: boolean; closed: boolean; lastSeenAt: number | null }[] {
    const settings = this.settings()
    const rows = this.db.prepare(`select * from tunnels where type = 'remote' and member = ? order by created_at`).all(member.name) as unknown as TunnelRow[]
    return rows.flatMap((row) => {
      const device = this.store.credential(row.device)
      if (device === undefined || device.revokedAt !== null || device.expiresAt <= this.now()) return []
      const tunnel = this.toTunnel(row)
      return [{ id: row.id, device: row.device, label: device.label, online: tunnel.online, closed: row.closed_by !== null || !settings.enabled || !settings.remote, lastSeenAt: row.last_seen_at }]
    })
  }

  /**
   * Where the relay sends a phone's request: the member's own, running 手机远程.
   * @throws Refusal otherwise.
   */
  remoteTarget(member: Member, id: string): { host: string; device: string } {
    const row = this.row(id)
    if (row === undefined || row.type !== 'remote' || row.member !== member.name) throw new Refusal(404, '没有这台电脑')
    const settings = this.settings()
    if (!settings.enabled || !settings.remote || this.server === null) throw new Refusal(403, '管理员没有开启手机远程')
    if (row.closed_by !== null) throw new Refusal(403, '管理员已关闭这台电脑的手机远程')
    const device = this.store.credential(row.device)
    if (device === undefined || device.revokedAt !== null || device.expiresAt <= this.now()) throw new Refusal(404, '这台电脑已经退出登录')
    if (!this.toTunnel(row).online) throw new Refusal(503, '这台电脑现在不在线：请确认它开着 GL Work，并打开了手机远程')
    return { host: hostOf(row) as string, device: row.device }
  }

  /** A member changes their tunnel's port, password requirement or who may connect. */
  update(member: Member, id: string, input: Record<string, unknown>): Tunnel {
    const row = this.row(id)
    if (row === undefined || row.member !== member.name) throw new Refusal(404, '没有这条隧道')
    if (row.type === 'remote') throw new Refusal(400, '手机远程没有可以修改的设置')
    const localPort = input.localPort === undefined ? row.local_port : this.port(input.localPort)
    let protection = row.protection
    if (row.type === 'http' && input.protection !== undefined) {
      protection = input.protection === 'public' ? 'public' : 'password'
      if (protection === 'public' && !this.settings().allowPublic) throw new Refusal(400, '管理员要求网页隧道都设置访问密码')
    }
    const sshAccess = row.type === 'ssh' && input.sshAccess !== undefined ? this.sshAccess(member.name, input.sshAccess) : row.ssh_access
    this.db.prepare('update tunnels set local_port = ?, protection = ?, ssh_access = ?, updated_at = ? where id = ?').run(localPort, protection, sshAccess, this.now(), id)
    return this.get(id) as Tunnel
  }

  /**
   * The member, or an administrator (any member's). frps keeps a running
   * tunnel nobody knows about any more, so administrators close it first.
   */
  delete(id: string, member?: Member): Tunnel {
    const tunnel = this.get(id)
    if (tunnel === undefined || (member !== undefined && tunnel.member !== member.name)) throw new Refusal(404, '没有这条隧道')
    if (member === undefined && tunnel.online) throw new Refusal(409, '隧道还在运行，请先关闭，等它断开后再删除')
    this.db.prepare('delete from tunnels where id = ?').run(id)
    return tunnel
  }

  /**
   * An administrator closes a tunnel (frps refuses it until reopened) or reopens it.
   * A running tunnel stops at its device's next heartbeat (see {@link frp}).
   */
  setClosed(id: string, by: string | null): Tunnel {
    if (Number(this.db.prepare('update tunnels set closed_by = ?, updated_at = ? where id = ?').run(by, this.now(), id).changes) === 0) {
      throw new Refusal(404, '没有这条隧道')
    }
    return this.get(id) as Tunnel
  }

  /** Whether a tunnel may still run: not closed, its member still granted its kind, its domain still usable. */
  private allowed(row: TunnelRow, member: Member, settings: TunnelSettings): boolean {
    if (row.closed_by !== null || !settings.enabled) return false
    if (row.type === 'remote') return settings.remote
    if (row.type === 'http') return member.tunnels && this.usableDomains().some(d => d.name === row.domain)
    return member.ssh && settings.ssh && (row.public_port === null || settings.publicTcp)
  }

  // frps server plugin

  /** Whether frps called on the secret path. */
  pluginPath(path: string): boolean {
    const secret = this.config.frps?.pluginSecret
    if (secret === undefined) return false
    return path.length === secret.length && sameSecret(path, secret)
  }

  /** The device behind frpc's metas.token, if it is a live device of an active member using its own name. */
  private principal(user: unknown, metas: unknown): { member: Member; credential: Credential } | undefined {
    const token = typeof metas === 'object' && metas !== null ? (metas as Record<string, unknown>).token : undefined
    if (typeof token !== 'string') return undefined
    const found = this.store.authenticate(token, 'device')
    if (found === undefined || found.member.name !== user) return undefined
    return found
  }

  /**
   * Answer one frps plugin call.
   * @param op - Login, NewProxy, CloseProxy, Ping or NewUserConn.
   * @param content - the operation's content as frps sends it.
   */
  frp(op: string, content: Record<string, unknown>): FrpAnswer {
    const settings = this.settings()
    const user = (content.user ?? {}) as { user?: unknown; metas?: unknown }
    switch (op) {
      case 'Login': {
        if (!settings.enabled) return deny('内网穿透没有开启')
        return this.principal(content.user, content.metas) === undefined ? deny('GL Work 的登录已失效') : ALLOW
      }
      case 'Ping': {
        const who = this.principal(user.user, user.metas)
        if (who === undefined) return deny('GL Work 的登录已失效')
        if (!settings.enabled) return deny('内网穿透没有开启')
        // A tunnel running here that may no longer run: drop the client; frpc logs in again, and
        // frps asks about each tunnel anew (CloseProxy marks them offline in between).
        const running = this.db.prepare('select * from tunnels where device = ? and online = 1').all(who.credential.id) as unknown as TunnelRow[]
        const stopped = running.find(r => !this.allowed(r, who.member, settings))
        if (stopped !== undefined) return deny(`隧道 ${stopped.name} 已被关闭`)
        this.db.prepare('update tunnels set last_seen_at = ? where device = ? and online = 1').run(this.now(), who.credential.id)
        return ALLOW
      }
      case 'NewProxy': return this.newProxy(content, settings)
      case 'CloseProxy': {
        const id = proxyId(String(content.proxy_name ?? ''), user.user)
        this.db.prepare('update tunnels set online = 0, updated_at = ? where id = ?').run(this.now(), id.tunnel)
        return ALLOW
      }
      case 'NewUserConn': {
        const id = proxyId(String(content.proxy_name ?? ''), user.user)
        const row = this.row(id.tunnel)
        return row === undefined || row.closed_by !== null ? deny('隧道已关闭') : ALLOW
      }
      default: return ALLOW
    }
  }

  private newProxy(content: Record<string, unknown>, settings: TunnelSettings): FrpAnswer {
    const user = (content.user ?? {}) as { user?: unknown; metas?: unknown }
    const who = this.principal(user.user, user.metas)
    if (!settings.enabled) return deny('内网穿透没有开启')
    if (who === undefined) return deny('GL Work 的登录已失效')
    const { tunnel: id, publicPart } = proxyId(String(content.proxy_name ?? ''), user.user)
    const row = this.row(id)
    if (row === undefined || row.member !== who.member.name) return deny('公司服务里没有这条隧道')
    if (row.device !== who.credential.id) return deny('这条隧道属于你的另一台电脑')
    if (row.closed_by !== null) return deny('管理员已关闭这条隧道')
    const type = content.proxy_type
    if (row.type === 'remote') {
      if (!settings.remote) return deny('管理员没有开启手机远程')
      if (type !== 'http' || publicPart) return deny('隧道类型不符')
      const domains = Array.isArray(content.custom_domains) ? content.custom_domains : []
      if (domains.length !== 1 || domains[0] !== hostOf(row) || (typeof content.subdomain === 'string' && content.subdomain !== '')) return deny('隧道地址和公司登记的不一致')
      // The relay presents no Basic Auth: the phone signed in to the company service instead.
      if (typeof content.http_user === 'string' && content.http_user !== '') return deny('手机远程不使用访问密码')
    } else if (row.type === 'http') {
      if (!who.member.tunnels) return deny('你还没有开通网页隧道')
      if (type !== 'http' || publicPart) return deny('隧道类型不符')
      if (!this.usableDomains().some(d => d.name === row.domain)) return deny('这条隧道的域名已经不可用')
      const domains = Array.isArray(content.custom_domains) ? content.custom_domains : []
      if (domains.length !== 1 || domains[0] !== hostOf(row) || (typeof content.subdomain === 'string' && content.subdomain !== '')) return deny('隧道地址和公司登记的不一致')
      const passworded = typeof content.http_user === 'string' && content.http_user !== '' && typeof content.http_pwd === 'string' && content.http_pwd !== ''
      if ((row.protection === 'password' || !settings.allowPublic) && !passworded) return deny('这条隧道需要设置访问密码')
    } else {
      if (!who.member.ssh || !settings.ssh) return deny('你还没有开通 SSH 隧道')
      if (publicPart) {
        if (type !== 'tcp' || row.public_port === null || !settings.publicTcp) return deny('没有为这条隧道开放公网端口')
        if (Number(content.remote_port) !== row.public_port) return deny('公网端口和公司分配的不一致')
      } else {
        if (type !== 'stcp') return deny('隧道类型不符')
        if (typeof content.sk !== 'string' || row.secret_key === null || !sameSecret(content.sk, row.secret_key)) return deny('连接密钥和公司登记的不一致')
        const allowed = Array.isArray(content.allow_users) ? content.allow_users.map(String).toSorted() : []
        if (JSON.stringify(allowed) !== JSON.stringify(this.allowedUsers(row))) return deny('可以连接的成员和公司登记的不一致')
      }
    }
    this.db.prepare('update tunnels set online = 1, last_seen_at = ?, updated_at = ? where id = ?').run(this.now(), this.now(), id)
    return ALLOW
  }
}

/** frp proxy names: `<tunnel id>` or `<tunnel id>-public`, perhaps prefixed `<user>.` by frps. */
function proxyId(name: string, user: unknown): { tunnel: string; publicPart: boolean } {
  const bare = typeof user === 'string' && name.startsWith(`${user}.`) ? name.slice(user.length + 1) : name
  return bare.endsWith('-public') ? { tunnel: bare.slice(0, -'-public'.length), publicPart: true } : { tunnel: bare, publicPart: false }
}

/** What HTTPS on a name under a tunnel domain shows: a verified certificate, and frps behind it. */
export interface Reach { tls: boolean; frps: boolean }

/** frps's page for a name with no tunnel ("…Faithfully yours, frp."), which only this service's frps serves here. */
const FRPS_NOT_FOUND = /Faithfully yours, frp\./u

async function reachesFrps(host: string): Promise<Reach> {
  const tls = await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 5000 }, () => {
      resolve(socket.authorized)
      socket.end()
    })
    socket.on('error', () => { resolve(false) })
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
  if (!tls) return { tls, frps: false }
  try {
    const response = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    return { tls, frps: FRPS_NOT_FOUND.test(await response.text()) }
  } catch {
    return { tls, frps: false }
  }
}
