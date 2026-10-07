/**
 * Company service state in PostgreSQL (sql.ts, schema in schema.ts): members,
 * their credentials, short-lived login state, model usage, vendors and their
 * keys (vendors.ts), and the audit log. Credentials and login codes are stored
 * as SHA-256 digests only.
 */
import { migrate } from './schema.ts'
import type { Sql } from './sql.ts'
import { digest, randomSecret } from './tokens.ts'

export type Role = 'member' | 'admin'
export type MemberStatus = 'active' | 'disabled'
/**
 * A desktop device token (Authorization header), a browser session (cookie),
 * or a member's internal key (Authorization header, for their own tools).
 */
export type CredentialKind = 'device' | 'browser' | 'key' | 'phone'
export type Team = 'dev' | 'product' | 'qa'

export interface Member {
  name: string
  displayName: string
  githubId: number
  githubLogin: string
  role: Role
  status: MemberStatus
  team: Team | null
  /** May open web tunnels. */
  tunnels: boolean
  /** May open SSH tunnels. */
  ssh: boolean
  createdAt: number
}

export interface Credential {
  id: string
  member: string
  kind: CredentialKind
  label: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  lastIp: string | null
}

export interface OAuthState {
  kind: 'web' | 'desktop' | 'phone'
  returnTo: string | null
  redirectPort: number | null
  codeChallenge: string | null
  clientState: string | null
}

export interface AuditEntry {
  at: number
  actor: string | null
  action: string
  target: string | null
  detail: string | null
  ip: string | null
}

const MEMBER_NAME = /^[a-z][a-z0-9-]{0,30}$/
/** `last_used_at` is refreshed at most this often per credential. */
const LAST_USED_RESOLUTION_MS = 60_000

export interface UsageSummary {
  member: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface MemberRow {
  name: string; display_name: string | null; github_id: number; github_login: string; role: Role; status: MemberStatus
  team: Team | null; tunnels: number; ssh: number; created_at: number
}
interface CredentialRow {
  id: string; member: string; kind: CredentialKind; label: string
  created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null; last_ip: string | null
}

function toMember(row: MemberRow): Member {
  return {
    name: row.name, displayName: row.display_name ?? row.name, githubId: row.github_id, githubLogin: row.github_login, role: row.role, status: row.status,
    team: row.team, tunnels: row.tunnels === 1, ssh: row.ssh === 1, createdAt: row.created_at,
  }
}

function toCredential(row: CredentialRow): Credential {
  return {
    id: row.id, member: row.member, kind: row.kind, label: row.label, createdAt: row.created_at,
    expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, lastIp: row.last_ip,
  }
}

export function assertMemberName(name: string): void {
  if (!MEMBER_NAME.test(name)) throw new Error(`member name must match ${MEMBER_NAME.source}`)
}

/** The process's time zone, in which usage is counted per calendar day (as SQLite's 'localtime' did). */
function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** A millisecond timestamp column as the local calendar day, YYYY-MM-DD; its one parameter is the zone. */
const LOCAL_DAY = `to_char(to_timestamp(at::double precision / 1000) at time zone ?, 'YYYY-MM-DD')`

export class Store {
  readonly sql: Sql
  private readonly now: () => number

  /**
   * A store on a migrated database; see {@link Store.open}.
   * @param now - clock, injectable for tests.
   */
  constructor(sql: Sql, now: () => number = Date.now) {
    this.sql = sql
    this.now = now
  }

  /** Migrate the database to the current schema, then hand out the store. */
  static async open(sql: Sql, now: () => number = Date.now): Promise<Store> {
    await migrate(sql, now)
    return new Store(sql, now)
  }

  async close(): Promise<void> { await this.sql.close() }

  // Members

  async addMember(input: { name: string; githubId: number; githubLogin: string; role: Role; displayName?: string; team?: Team | null; tunnels?: boolean; ssh?: boolean }): Promise<Member> {
    assertMemberName(input.name)
    // Developers and testers get web tunnels by default; SSH is granted one by one.
    const tunnels = input.tunnels ?? input.team !== 'product'
    await this.sql.run('insert into members (name, display_name, github_id, github_login, role, status, team, tunnels, ssh, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [input.name, input.displayName ?? null, input.githubId, input.githubLogin, input.role, 'active', input.team ?? null, tunnels ? 1 : 0, input.ssh === true ? 1 : 0, this.now()])
    return await this.member(input.name) as Member
  }

  async setProfile(name: string, profile: { displayName?: string; team?: Team | null }): Promise<void> {
    const member = await this.member(name)
    if (member === undefined) throw new Error(`unknown member ${name}`)
    await this.sql.run('update members set display_name = ?, team = ? where name = ?',
      [profile.displayName ?? member.displayName, profile.team === undefined ? member.team : profile.team, name])
  }

  async setTunnelGrants(name: string, grants: { tunnels?: boolean; ssh?: boolean }): Promise<void> {
    const member = await this.member(name)
    if (member === undefined) throw new Error(`unknown member ${name}`)
    await this.sql.run('update members set tunnels = ?, ssh = ? where name = ?',
      [(grants.tunnels ?? member.tunnels) ? 1 : 0, (grants.ssh ?? member.ssh) ? 1 : 0, name])
  }

  async member(name: string): Promise<Member | undefined> {
    const row = await this.sql.one<MemberRow>('select * from members where name = ?', [name])
    return row === undefined ? undefined : toMember(row)
  }

  async memberByGithubId(githubId: number): Promise<Member | undefined> {
    const row = await this.sql.one<MemberRow>('select * from members where github_id = ?', [githubId])
    return row === undefined ? undefined : toMember(row)
  }

  async listMembers(): Promise<Member[]> {
    return (await this.sql.query<MemberRow>('select * from members order by name')).map(toMember)
  }

  /** Remove a member with their credentials and pending login codes; audit and usage history stay. */
  async deleteMember(name: string): Promise<void> {
    this.mustChange(await this.sql.run('delete from members where name = ?', [name]), name)
  }

  /** @returns active device and browser credentials per member, with the latest use of any of them. */
  async credentialSummary(): Promise<{ member: string; devices: number; browsers: number; lastUsedAt: number | null }[]> {
    return this.sql.query(`select member, count(*) filter (where kind = 'device') as devices, count(*) filter (where kind = 'browser') as browsers,
      max(last_used_at) as "lastUsedAt" from credentials where revoked_at is null and expires_at > ? group by member`, [this.now()])
  }

  /** GitHub logins can be renamed; the numeric id is the identity, the login is display only. */
  async updateGithubLogin(name: string, login: string): Promise<void> {
    await this.sql.run('update members set github_login = ? where name = ?', [login, name])
  }

  async setRole(name: string, role: Role): Promise<void> {
    this.mustChange(await this.sql.run('update members set role = ? where name = ?', [role, name]), name)
  }

  /** Disabling also revokes every credential, so re-enabling requires a fresh login. */
  async setStatus(name: string, status: MemberStatus): Promise<void> {
    await this.sql.transaction(async () => {
      this.mustChange(await this.sql.run('update members set status = ? where name = ?', [status, name]), name)
      if (status === 'disabled') await this.revokeMemberCredentials(name)
    })
  }

  private mustChange(changes: number, name: string): void {
    if (changes === 0) throw new Error(`unknown member ${name}`)
  }

  // Credentials

  /** @returns the credential and its plain token, shown to the holder once. */
  async issueCredential(member: string, kind: CredentialKind, label: string, ttlMs: number): Promise<{ credential: Credential; token: string }> {
    const token = randomSecret({ device: 'awd_', key: 'awk_', phone: 'awp_', browser: 'aws_' }[kind])
    const id = randomSecret().slice(0, 12)
    const now = this.now()
    await this.sql.run('insert into credentials (id, member, kind, token_hash, label, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)',
      [id, member, kind, digest(token), label, now, now + ttlMs])
    return { credential: await this.credential(id) as Credential, token }
  }

  async credential(id: string): Promise<Credential | undefined> {
    const row = await this.sql.one<CredentialRow>('select * from credentials where id = ?', [id])
    return row === undefined ? undefined : toCredential(row)
  }

  /**
   * Resolve a presented token to its live credential and active member.
   * @returns undefined for unknown, expired, or revoked tokens and for disabled members.
   */
  async authenticate(token: string, kind: CredentialKind | readonly CredentialKind[], ip: string | null = null): Promise<{ credential: Credential; member: Member } | undefined> {
    const kinds: readonly CredentialKind[] = typeof kind === 'string' ? [kind] : kind
    const row = await this.sql.one<CredentialRow>('select * from credentials where token_hash = ?', [digest(token)])
    if (row === undefined || !kinds.includes(row.kind)) return undefined
    const now = this.now()
    if (row.revoked_at !== null || row.expires_at <= now) return undefined
    const member = await this.member(row.member)
    if (member === undefined || member.status !== 'active') return undefined
    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION_MS || (ip !== null && ip !== row.last_ip)) {
      await this.sql.run('update credentials set last_used_at = ?, last_ip = coalesce(?, last_ip) where id = ?', [now, ip, row.id])
      row.last_used_at = now
      if (ip !== null) row.last_ip = ip
    }
    return { credential: toCredential(row), member }
  }

  async listCredentials(member?: string): Promise<Credential[]> {
    const rows = member === undefined
      ? await this.sql.query<CredentialRow>('select * from credentials where revoked_at is null and expires_at > ? order by member, created_at, seq', [this.now()])
      : await this.sql.query<CredentialRow>('select * from credentials where member = ? and revoked_at is null and expires_at > ? order by created_at, seq', [member, this.now()])
    return rows.map(toCredential)
  }

  async revokeCredential(id: string): Promise<boolean> {
    return await this.sql.run('update credentials set revoked_at = ? where id = ? and revoked_at is null', [this.now(), id]) > 0
  }

  async revokeMemberCredentials(member: string): Promise<number> {
    return this.sql.run('update credentials set revoked_at = ? where member = ? and revoked_at is null', [this.now(), member])
  }

  // Login flow state

  /** @returns the opaque state value sent through GitHub. */
  async saveOAuthState(state: OAuthState, ttlMs: number): Promise<string> {
    const value = randomSecret()
    await this.sql.run('insert into oauth_states (state_hash, kind, return_to, redirect_port, code_challenge, client_state, expires_at) values (?, ?, ?, ?, ?, ?, ?)',
      [digest(value), state.kind, state.returnTo, state.redirectPort, state.codeChallenge, state.clientState, this.now() + ttlMs])
    return value
  }

  /** Single use: the state is deleted whether or not it is still valid. */
  async takeOAuthState(value: string): Promise<OAuthState | undefined> {
    const row = await this.sql.one<{ kind: OAuthState['kind']; return_to: string | null; redirect_port: number | null; code_challenge: string | null; client_state: string | null; expires_at: number }>(
      'delete from oauth_states where state_hash = ? returning *', [digest(value)])
    if (row === undefined || row.expires_at <= this.now()) return undefined
    return { kind: row.kind, returnTo: row.return_to, redirectPort: row.redirect_port, codeChallenge: row.code_challenge, clientState: row.client_state }
  }

  /** @returns the one-time code handed to the desktop's loopback listener, or to the phone app. */
  async saveLoginCode(member: string, challenge: string, ttlMs: number, kind: 'desktop' | 'phone' = 'desktop'): Promise<string> {
    const code = randomSecret()
    await this.sql.run('insert into login_codes (code_hash, member, code_challenge, expires_at, kind) values (?, ?, ?, ?, ?)',
      [digest(code), member, challenge, this.now() + ttlMs, kind])
    return code
  }

  /** Single use, like OAuth state. */
  async takeLoginCode(code: string): Promise<{ member: string; codeChallenge: string; kind: 'desktop' | 'phone' } | undefined> {
    const row = await this.sql.one<{ member: string; code_challenge: string; expires_at: number; kind: 'desktop' | 'phone' }>(
      'delete from login_codes where code_hash = ? returning *', [digest(code)])
    if (row === undefined || row.expires_at <= this.now()) return undefined
    return { member: row.member, codeChallenge: row.code_challenge, kind: row.kind }
  }

  /** Drop expired login state. */
  async purge(): Promise<void> {
    const now = this.now()
    await this.sql.run('delete from oauth_states where expires_at <= ?', [now])
    await this.sql.run('delete from login_codes where expires_at <= ?', [now])
  }

  // Model usage

  async recordUsage(member: string, credential: string, usage: { model: string | null; status: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, via: { vendor: string; apiKey: string } | null = null): Promise<void> {
    await this.sql.run('insert into llm_usage (at, member, credential, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, vendor, api_key) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [this.now(), member, credential, usage.model, usage.status, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, via?.vendor ?? null, via?.apiKey ?? null])
  }

  /** @returns tokens per local calendar day and vendor, oldest first. */
  async dailyVendorUsageSince(since: number): Promise<{ day: string; vendor: string; requests: number; tokens: number }[]> {
    // Grouped by position: `group by vendor` would name the column, not the coalesced output.
    return this.sql.query(`select ${LOCAL_DAY} as day, coalesce(vendor, 'deepseek') as vendor,
      count(*) as requests, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? group by 1, 2 order by 1, 2`, [localZone(), since])
  }

  /** @returns tokens per member and vendor since the given time. */
  async memberVendorUsageSince(since: number): Promise<{ member: string; vendor: string; tokens: number }[]> {
    return this.sql.query(`select member, coalesce(vendor, 'deepseek') as vendor, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? group by 1, 2`, [since])
  }

  /** @returns tokens per vendor since the given time. */
  async vendorUsageSince(since: number): Promise<{ vendor: string; tokens: number }[]> {
    return this.sql.query(`select coalesce(vendor, 'deepseek') as vendor, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? group by 1`, [since])
  }

  /** @returns one key's requests, tokens and cache reads since the given time. */
  async keyUsageSince(apiKey: string, since: number): Promise<{ requests: number; tokens: number; inputTokens: number; cacheReadTokens: number }> {
    return await this.sql.one(`select count(*) as requests, coalesce(sum(input_tokens + output_tokens), 0) as tokens,
      coalesce(sum(input_tokens), 0) as "inputTokens", coalesce(sum(cache_read_tokens), 0) as "cacheReadTokens"
      from llm_usage where api_key = ? and at >= ?`, [apiKey, since]) as { requests: number; tokens: number; inputTokens: number; cacheReadTokens: number }
  }

  /** @returns requests and tokens per API key since the given time. */
  async usageByKeySince(since: number): Promise<{ apiKey: string; requests: number; tokens: number }[]> {
    return this.sql.query(`select api_key as "apiKey", count(*) as requests, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? and api_key is not null group by api_key`, [since])
  }

  /** @returns totals per member since the given time. */
  async usageSince(since: number): Promise<UsageSummary[]> {
    return this.sql.query(`select member, count(*) as requests, sum(input_tokens) as "inputTokens", sum(output_tokens) as "outputTokens",
      sum(cache_read_tokens) as "cacheReadTokens", sum(cache_write_tokens) as "cacheWriteTokens"
      from llm_usage where at >= ? group by member order by member`, [since])
  }

  /** @returns per-day totals since the given time, in local calendar days, oldest first. */
  async dailyUsageSince(since: number): Promise<{ day: string; requests: number; inputTokens: number; outputTokens: number }[]> {
    return this.sql.query(`select ${LOCAL_DAY} as day, count(*) as requests,
      sum(input_tokens) as "inputTokens", sum(output_tokens) as "outputTokens"
      from llm_usage where at >= ? group by 1 order by 1`, [localZone(), since])
  }

  // Audit

  async audit(entry: Omit<AuditEntry, 'at'>): Promise<void> {
    await this.sql.run('insert into audit (at, actor, action, target, detail, ip) values (?, ?, ?, ?, ?, ?)',
      [this.now(), entry.actor, entry.action, entry.target, entry.detail, entry.ip])
  }

  async recentAudit(limit = 100): Promise<AuditEntry[]> {
    return this.sql.query<AuditEntry>('select at, actor, action, target, detail, ip from audit order by id desc limit ?', [limit])
  }
}

