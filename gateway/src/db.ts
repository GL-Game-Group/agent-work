/**
 * Company service state in one SQLite file: members, their credentials,
 * short-lived login state, model usage, vendors and their keys (vendors.ts),
 * and the audit log. Credentials and login codes are stored as SHA-256
 * digests only.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

const SCHEMA = `
create table members (
  name text primary key,
  github_id integer not null unique,
  github_login text not null,
  role text not null check (role in ('member', 'admin')),
  status text not null check (status in ('active', 'disabled')),
  created_at integer not null
);
create table credentials (
  id text primary key,
  member text not null references members(name) on delete cascade,
  kind text not null check (kind in ('device', 'browser')),
  token_hash text not null unique,
  label text not null,
  created_at integer not null,
  expires_at integer not null,
  last_used_at integer,
  revoked_at integer
);
create index credentials_member on credentials(member);
create table oauth_states (
  state_hash text primary key,
  kind text not null check (kind in ('web', 'desktop')),
  return_to text,
  redirect_port integer,
  code_challenge text,
  client_state text,
  expires_at integer not null
);
create table login_codes (
  code_hash text primary key,
  member text not null references members(name) on delete cascade,
  code_challenge text not null,
  expires_at integer not null
);
create table audit (
  id integer primary key autoincrement,
  at integer not null,
  actor text,
  action text not null,
  target text,
  detail text,
  ip text
);
`

/** Model gateway usage, one row per Messages call. */
const SCHEMA_V2 = `
create table llm_usage (
  id integer primary key autoincrement,
  at integer not null,
  member text not null,
  credential text not null,
  model text,
  status integer not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read_tokens integer not null,
  cache_write_tokens integer not null
);
create index llm_usage_member_at on llm_usage(member, at);
`

/**
 * Vendors and what the company holds for them: API keys (sealed, see
 * secrets.ts), CLI account names (no passwords), which vendors each member
 * may use with which key or account, and public config for client plugins.
 * Five vendors are seeded once; administrators edit or remove them freely.
 */
const SCHEMA_V3 = `
create table vendors (
  id text primary key,
  name text not null,
  type text not null check (type in ('api', 'cli')),
  auth text not null check (auth in ('key', 'account')),
  protocol text check (protocol in ('anthropic', 'openai')),
  base_url text,
  models_url text,
  compat text,
  models text not null default '[]',
  catalog text not null default '[]',
  catalog_at integer,
  builtin integer not null default 0,
  created_at integer not null
);
create table api_keys (
  id text primary key,
  vendor text not null references vendors(id),
  label text not null,
  secret text not null,
  last4 text not null,
  status text not null check (status in ('active', 'disabled')),
  created_at integer not null
);
create table cli_accounts (
  id text primary key,
  vendor text not null references vendors(id),
  account text not null,
  note text,
  created_at integer not null,
  unique (vendor, account)
);
create table member_vendors (
  member text not null references members(name) on delete cascade,
  vendor text not null references vendors(id) on delete cascade,
  api_key text references api_keys(id) on delete set null,
  cli_account text unique references cli_accounts(id) on delete set null,
  created_at integer not null,
  primary key (member, vendor)
);
create table public_config (
  key text primary key,
  value text not null,
  secret integer not null,
  note text,
  updated_at integer not null
);
alter table llm_usage add column vendor text;
alter table llm_usage add column api_key text;
update llm_usage set vendor = 'deepseek';
`

/**
 * Members' profile and tunnel grants, shared vs dedicated keys and how each
 * member reaches a vendor, subscriptions over accounts, grouped system config,
 * and internal keys (a third credential kind, so the table is rebuilt: SQLite
 * cannot change a check constraint in place).
 */
const SCHEMA_V4 = `
alter table members add column display_name text;
alter table members add column team text check (team in ('dev', 'product', 'qa'));
alter table members add column tunnels integer not null default 0;
alter table members add column ssh integer not null default 0;
update members set tunnels = 1;
alter table api_keys add column mode text not null default 'shared' check (mode in ('shared', 'dedicated'));
alter table member_vendors add column mode text check (mode in ('shared', 'dedicated', 'account'));
update member_vendors set mode = (select case when vendors.auth = 'account' then 'account' else 'shared' end from vendors where vendors.id = member_vendors.vendor);
create table subscriptions (
  id text primary key,
  vendor text not null references vendors(id),
  plan text not null,
  seats integer not null check (seats > 0),
  price text,
  cycle text not null check (cycle in ('monthly', 'yearly')),
  renews_at integer,
  owner text,
  note text,
  created_at integer not null
);
alter table cli_accounts add column subscription text references subscriptions(id) on delete set null;
alter table public_config add column group_name text;
alter table public_config add column reads integer not null default 0;
alter table public_config add column last_read_at integer;
create table credentials_v4 (
  id text primary key,
  member text not null references members(name) on delete cascade,
  kind text not null check (kind in ('device', 'browser', 'key')),
  token_hash text not null unique,
  label text not null,
  created_at integer not null,
  expires_at integer not null,
  last_used_at integer,
  revoked_at integer,
  last_ip text
);
insert into credentials_v4 (id, member, kind, token_hash, label, created_at, expires_at, last_used_at, revoked_at)
  select id, member, kind, token_hash, label, created_at, expires_at, last_used_at, revoked_at from credentials;
drop table credentials;
alter table credentials_v4 rename to credentials;
create index credentials_member on credentials(member);
`

/** The company's plugin catalog, and which catalog plugins each desktop reported installed. */
const SCHEMA_V5 = `
create table plugins (
  name text primary key,
  display_name text not null,
  description text,
  version text not null,
  url text not null,
  integrity text not null,
  size integer not null,
  permissions text not null default '[]',
  status text not null check (status in ('published', 'hidden')),
  preinstalled integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);
create table device_plugins (
  credential text not null references credentials(id) on delete cascade,
  plugin text not null references plugins(name) on delete cascade,
  version text not null,
  reported_at integer not null,
  primary key (credential, plugin)
);
`

/**
 * Tunnels (frp): the domains web tunnels live under, the tunnels members
 * defined from GL Work and whether frps holds them open, and the settings
 * that govern them.
 */
const SCHEMA_V6 = `
create table tunnel_domains (
  name text primary key,
  is_default integer not null default 0,
  dns text not null default 'unknown',
  cert text not null default 'unknown',
  checked_at integer,
  note text,
  created_at integer not null
);
create table tunnels (
  id text primary key,
  member text not null references members(name) on delete cascade,
  device text not null,
  type text not null check (type in ('http', 'ssh')),
  name text not null,
  domain text,
  local_port integer not null,
  protection text not null default 'public' check (protection in ('public', 'password')),
  ssh_access text,
  secret_key text,
  public_port integer unique,
  closed_by text,
  online integer not null default 0,
  last_seen_at integer,
  created_at integer not null,
  updated_at integer not null,
  unique (member, type, name)
);
create table app_settings (
  key text primary key,
  value text not null
);
`

/**
 * Phones (GL Work for iOS): a fourth credential kind, which only reaches the
 * member's own Macs through the relay; phone sign-ins in flight; and the
 * Mac-side end of that relay, a `remote` tunnel. Check constraints change, so
 * the tables are rebuilt with foreign keys off (dropping `credentials` would
 * otherwise cascade into `device_plugins`).
 */
const SCHEMA_V7 = `
create table credentials_v7 (
  id text primary key,
  member text not null references members(name) on delete cascade,
  kind text not null check (kind in ('device', 'browser', 'key', 'phone')),
  token_hash text not null unique,
  label text not null,
  created_at integer not null,
  expires_at integer not null,
  last_used_at integer,
  revoked_at integer,
  last_ip text
);
insert into credentials_v7 select id, member, kind, token_hash, label, created_at, expires_at, last_used_at, revoked_at, last_ip from credentials;
drop table credentials;
alter table credentials_v7 rename to credentials;
create index credentials_member on credentials(member);
drop table oauth_states;
create table oauth_states (
  state_hash text primary key,
  kind text not null check (kind in ('web', 'desktop', 'phone')),
  return_to text,
  redirect_port integer,
  code_challenge text,
  client_state text,
  expires_at integer not null
);
alter table login_codes add column kind text not null default 'desktop' check (kind in ('desktop', 'phone'));
create table tunnels_v7 (
  id text primary key,
  member text not null references members(name) on delete cascade,
  device text not null,
  type text not null check (type in ('http', 'ssh', 'remote')),
  name text not null,
  domain text,
  local_port integer not null,
  protection text not null default 'public' check (protection in ('public', 'password')),
  ssh_access text,
  secret_key text,
  public_port integer unique,
  closed_by text,
  online integer not null default 0,
  last_seen_at integer,
  created_at integer not null,
  updated_at integer not null,
  unique (member, type, name)
);
insert into tunnels_v7 select * from tunnels;
drop table tunnels;
alter table tunnels_v7 rename to tunnels;
`

const SEED_VENDORS: [id: string, name: string, type: 'api' | 'cli', auth: 'key' | 'account', protocol: string | null, baseUrl: string | null, modelsUrl: string | null, compat: string | null, models: string][] = [
  ['codex', 'Codex', 'cli', 'account', null, null, null, null, '[]'],
  ['claude', 'Claude', 'cli', 'account', null, null, null, null, '[]'],
  ['qoder', 'Qoder', 'cli', 'account', null, null, null, null, '[]'],
  ['qwen', '千问', 'api', 'key', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', null, '{"thinkingFormat":"qwen"}', '[]'],
  ['deepseek', 'DeepSeek', 'api', 'key', 'anthropic', 'https://api.deepseek.com/anthropic', 'https://api.deepseek.com/models', null,
    '[{"id":"deepseek-flash","name":"DeepSeek-V41-Flash"},{"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro"}]'],
]

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

export class Store {
  readonly db: DatabaseSync
  private readonly now: () => number

  /**
   * @param path - database file, or ':memory:' in tests.
   * @param now - clock, injectable for tests.
   */
  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
    const { user_version: version } = this.db.prepare('pragma user_version').get() as { user_version: number }
    if (version === 0) this.db.exec(`begin; ${SCHEMA} pragma user_version = 1; commit;`)
    if (version <= 1) this.db.exec(`begin; ${SCHEMA_V2} pragma user_version = 2; commit;`)
    if (version <= 2) {
      this.db.exec(`begin; ${SCHEMA_V3}`)
      const seed = this.db.prepare('insert into vendors (id, name, type, auth, protocol, base_url, models_url, compat, models, builtin, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
      for (const row of SEED_VENDORS) seed.run(...row, this.now())
      this.db.exec('pragma user_version = 3; commit;')
    }
    if (version <= 3) this.db.exec(`begin; ${SCHEMA_V4} pragma user_version = 4; commit;`)
    if (version <= 4) this.db.exec(`begin; ${SCHEMA_V5} pragma user_version = 5; commit;`)
    if (version <= 5) this.db.exec(`begin; ${SCHEMA_V6} pragma user_version = 6; commit;`)
    if (version <= 6) {
      // foreign_keys only changes outside a transaction.
      this.db.exec('pragma foreign_keys = off;')
      try {
        this.db.exec(`begin; ${SCHEMA_V7}`)
        if ((this.db.prepare('pragma foreign_key_check').all() as unknown[]).length > 0) throw new Error('gateway: schema v7 broke a foreign key')
        this.db.exec('pragma user_version = 7; commit;')
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('rollback')
        throw error
      } finally {
        this.db.exec('pragma foreign_keys = on;')
      }
    }
  }

  close(): void { this.db.close() }

  // Members

  addMember(input: { name: string; githubId: number; githubLogin: string; role: Role; displayName?: string; team?: Team | null; tunnels?: boolean; ssh?: boolean }): Member {
    assertMemberName(input.name)
    // Developers and testers get web tunnels by default; SSH is granted one by one.
    const tunnels = input.tunnels ?? input.team !== 'product'
    this.db.prepare('insert into members (name, display_name, github_id, github_login, role, status, team, tunnels, ssh, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.name, input.displayName ?? null, input.githubId, input.githubLogin, input.role, 'active', input.team ?? null, tunnels ? 1 : 0, input.ssh === true ? 1 : 0, this.now())
    return this.member(input.name) as Member
  }

  setProfile(name: string, profile: { displayName?: string; team?: Team | null }): void {
    const member = this.member(name)
    if (member === undefined) throw new Error(`unknown member ${name}`)
    this.db.prepare('update members set display_name = ?, team = ? where name = ?')
      .run(profile.displayName ?? member.displayName, profile.team === undefined ? member.team : profile.team, name)
  }

  setTunnelGrants(name: string, grants: { tunnels?: boolean; ssh?: boolean }): void {
    const member = this.member(name)
    if (member === undefined) throw new Error(`unknown member ${name}`)
    this.db.prepare('update members set tunnels = ?, ssh = ? where name = ?')
      .run((grants.tunnels ?? member.tunnels) ? 1 : 0, (grants.ssh ?? member.ssh) ? 1 : 0, name)
  }

  member(name: string): Member | undefined {
    const row = this.db.prepare('select * from members where name = ?').get(name) as MemberRow | undefined
    return row === undefined ? undefined : toMember(row)
  }

  memberByGithubId(githubId: number): Member | undefined {
    const row = this.db.prepare('select * from members where github_id = ?').get(githubId) as MemberRow | undefined
    return row === undefined ? undefined : toMember(row)
  }

  listMembers(): Member[] {
    return (this.db.prepare('select * from members order by name').all() as unknown as MemberRow[]).map(toMember)
  }

  /** Remove a member with their credentials and pending login codes; audit and usage history stay. */
  deleteMember(name: string): void {
    this.mustChange(this.db.prepare('delete from members where name = ?').run(name).changes, name)
  }

  /** @returns active device and browser credentials per member, with the latest use of any of them. */
  credentialSummary(): { member: string; devices: number; browsers: number; lastUsedAt: number | null }[] {
    const rows = this.db.prepare(`select member, sum(kind = 'device') as devices, sum(kind = 'browser') as browsers, max(last_used_at) as lastUsedAt
      from credentials where revoked_at is null and expires_at > ? group by member`).all(this.now()) as unknown as { member: string; devices: number; browsers: number; lastUsedAt: number | null }[]
    return rows.map(row => ({ ...row }))
  }

  /** GitHub logins can be renamed; the numeric id is the identity, the login is display only. */
  updateGithubLogin(name: string, login: string): void {
    this.db.prepare('update members set github_login = ? where name = ?').run(login, name)
  }

  setRole(name: string, role: Role): void {
    this.mustChange(this.db.prepare('update members set role = ? where name = ?').run(role, name).changes, name)
  }

  /** Disabling also revokes every credential, so re-enabling requires a fresh login. */
  setStatus(name: string, status: MemberStatus): void {
    this.mustChange(this.db.prepare('update members set status = ? where name = ?').run(status, name).changes, name)
    if (status === 'disabled') this.revokeMemberCredentials(name)
  }

  private mustChange(changes: number | bigint, name: string): void {
    if (Number(changes) === 0) throw new Error(`unknown member ${name}`)
  }

  // Credentials

  /** @returns the credential and its plain token, shown to the holder once. */
  issueCredential(member: string, kind: CredentialKind, label: string, ttlMs: number): { credential: Credential; token: string } {
    const token = randomSecret({ device: 'awd_', key: 'awk_', phone: 'awp_', browser: 'aws_' }[kind])
    const id = randomSecret().slice(0, 12)
    const now = this.now()
    this.db.prepare('insert into credentials (id, member, kind, token_hash, label, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, member, kind, digest(token), label, now, now + ttlMs)
    return { credential: this.credential(id) as Credential, token }
  }

  credential(id: string): Credential | undefined {
    const row = this.db.prepare('select * from credentials where id = ?').get(id) as CredentialRow | undefined
    return row === undefined ? undefined : toCredential(row)
  }

  /**
   * Resolve a presented token to its live credential and active member.
   * @returns undefined for unknown, expired, or revoked tokens and for disabled members.
   */
  authenticate(token: string, kind: CredentialKind | readonly CredentialKind[], ip: string | null = null): { credential: Credential; member: Member } | undefined {
    const kinds: readonly CredentialKind[] = typeof kind === 'string' ? [kind] : kind
    const row = this.db.prepare('select * from credentials where token_hash = ?').get(digest(token)) as CredentialRow | undefined
    if (row === undefined || !kinds.includes(row.kind)) return undefined
    const now = this.now()
    if (row.revoked_at !== null || row.expires_at <= now) return undefined
    const member = this.member(row.member)
    if (member === undefined || member.status !== 'active') return undefined
    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION_MS || (ip !== null && ip !== row.last_ip)) {
      this.db.prepare('update credentials set last_used_at = ?, last_ip = coalesce(?, last_ip) where id = ?').run(now, ip, row.id)
      row.last_used_at = now
      if (ip !== null) row.last_ip = ip
    }
    return { credential: toCredential(row), member }
  }

  listCredentials(member?: string): Credential[] {
    const rows = member === undefined
      ? this.db.prepare('select * from credentials where revoked_at is null and expires_at > ? order by member, created_at').all(this.now())
      : this.db.prepare('select * from credentials where member = ? and revoked_at is null and expires_at > ? order by created_at').all(member, this.now())
    return (rows as unknown as CredentialRow[]).map(toCredential)
  }

  revokeCredential(id: string): boolean {
    return Number(this.db.prepare('update credentials set revoked_at = ? where id = ? and revoked_at is null').run(this.now(), id).changes) > 0
  }

  revokeMemberCredentials(member: string): number {
    return Number(this.db.prepare('update credentials set revoked_at = ? where member = ? and revoked_at is null').run(this.now(), member).changes)
  }

  // Login flow state

  /** @returns the opaque state value sent through GitHub. */
  saveOAuthState(state: OAuthState, ttlMs: number): string {
    const value = randomSecret()
    this.db.prepare('insert into oauth_states (state_hash, kind, return_to, redirect_port, code_challenge, client_state, expires_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(digest(value), state.kind, state.returnTo, state.redirectPort, state.codeChallenge, state.clientState, this.now() + ttlMs)
    return value
  }

  /** Single use: the state is deleted whether or not it is still valid. */
  takeOAuthState(value: string): OAuthState | undefined {
    const row = this.db.prepare('delete from oauth_states where state_hash = ? returning *').get(digest(value)) as
      { kind: OAuthState['kind']; return_to: string | null; redirect_port: number | null; code_challenge: string | null; client_state: string | null; expires_at: number } | undefined
    if (row === undefined || row.expires_at <= this.now()) return undefined
    return { kind: row.kind, returnTo: row.return_to, redirectPort: row.redirect_port, codeChallenge: row.code_challenge, clientState: row.client_state }
  }

  /** @returns the one-time code handed to the desktop's loopback listener, or to the phone app. */
  saveLoginCode(member: string, challenge: string, ttlMs: number, kind: 'desktop' | 'phone' = 'desktop'): string {
    const code = randomSecret()
    this.db.prepare('insert into login_codes (code_hash, member, code_challenge, expires_at, kind) values (?, ?, ?, ?, ?)')
      .run(digest(code), member, challenge, this.now() + ttlMs, kind)
    return code
  }

  /** Single use, like OAuth state. */
  takeLoginCode(code: string): { member: string; codeChallenge: string; kind: 'desktop' | 'phone' } | undefined {
    const row = this.db.prepare('delete from login_codes where code_hash = ? returning *').get(digest(code)) as
      { member: string; code_challenge: string; expires_at: number; kind: 'desktop' | 'phone' } | undefined
    if (row === undefined || row.expires_at <= this.now()) return undefined
    return { member: row.member, codeChallenge: row.code_challenge, kind: row.kind }
  }

  /** Drop expired login state. */
  purge(): void {
    const now = this.now()
    this.db.prepare('delete from oauth_states where expires_at <= ?').run(now)
    this.db.prepare('delete from login_codes where expires_at <= ?').run(now)
  }

  // Model usage

  recordUsage(member: string, credential: string, usage: { model: string | null; status: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, via: { vendor: string; apiKey: string } | null = null): void {
    this.db.prepare('insert into llm_usage (at, member, credential, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, vendor, api_key) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.now(), member, credential, usage.model, usage.status, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, via?.vendor ?? null, via?.apiKey ?? null)
  }

  /** @returns tokens per local calendar day and vendor, oldest first. */
  dailyVendorUsageSince(since: number): { day: string; vendor: string; requests: number; tokens: number }[] {
    const rows = this.db.prepare(`select date(at / 1000, 'unixepoch', 'localtime') as day, coalesce(vendor, 'deepseek') as vendor,
      count(*) as requests, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? group by day, vendor order by day, vendor`).all(since) as unknown as { day: string; vendor: string; requests: number; tokens: number }[]
    return rows.map(row => ({ ...row }))
  }

  /** @returns tokens per member and vendor since the given time. */
  memberVendorUsageSince(since: number): { member: string; vendor: string; tokens: number }[] {
    const rows = this.db.prepare(`select member, coalesce(vendor, 'deepseek') as vendor, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? group by member, vendor`).all(since) as unknown as { member: string; vendor: string; tokens: number }[]
    return rows.map(row => ({ ...row }))
  }

  /** @returns tokens per vendor since the given time. */
  vendorUsageSince(since: number): { vendor: string; tokens: number }[] {
    const rows = this.db.prepare(`select coalesce(vendor, 'deepseek') as vendor, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? group by vendor`).all(since) as unknown as { vendor: string; tokens: number }[]
    return rows.map(row => ({ ...row }))
  }

  /** @returns one key's requests, tokens and cache reads since the given time. */
  keyUsageSince(apiKey: string, since: number): { requests: number; tokens: number; inputTokens: number; cacheReadTokens: number } {
    const row = this.db.prepare(`select count(*) as requests, coalesce(sum(input_tokens + output_tokens), 0) as tokens,
      coalesce(sum(input_tokens), 0) as inputTokens, coalesce(sum(cache_read_tokens), 0) as cacheReadTokens
      from llm_usage where api_key = ? and at >= ?`).get(apiKey, since) as { requests: number; tokens: number; inputTokens: number; cacheReadTokens: number }
    return { ...row }
  }

  /** @returns requests and tokens per API key since the given time. */
  usageByKeySince(since: number): { apiKey: string; requests: number; tokens: number }[] {
    const rows = this.db.prepare(`select api_key as apiKey, count(*) as requests, sum(input_tokens + output_tokens) as tokens
      from llm_usage where at >= ? and api_key is not null group by api_key`).all(since) as unknown as { apiKey: string; requests: number; tokens: number }[]
    return rows.map(row => ({ ...row }))
  }

  /** @returns totals per member since the given time. */
  usageSince(since: number): UsageSummary[] {
    const rows = this.db.prepare(`select member, count(*) as requests, sum(input_tokens) as inputTokens, sum(output_tokens) as outputTokens,
      sum(cache_read_tokens) as cacheReadTokens, sum(cache_write_tokens) as cacheWriteTokens
      from llm_usage where at >= ? group by member order by member`).all(since) as unknown as UsageSummary[]
    return rows.map(row => ({ ...row }))
  }

  /** @returns per-day totals since the given time, in local calendar days, oldest first. */
  dailyUsageSince(since: number): { day: string; requests: number; inputTokens: number; outputTokens: number }[] {
    const rows = this.db.prepare(`select date(at / 1000, 'unixepoch', 'localtime') as day, count(*) as requests,
      sum(input_tokens) as inputTokens, sum(output_tokens) as outputTokens
      from llm_usage where at >= ? group by day order by day`).all(since) as unknown as { day: string; requests: number; inputTokens: number; outputTokens: number }[]
    return rows.map(row => ({ ...row }))
  }

  // Audit

  audit(entry: Omit<AuditEntry, 'at'>): void {
    this.db.prepare('insert into audit (at, actor, action, target, detail, ip) values (?, ?, ?, ?, ?, ?)')
      .run(this.now(), entry.actor, entry.action, entry.target, entry.detail, entry.ip)
  }

  recentAudit(limit = 100): AuditEntry[] {
    return this.db.prepare('select at, actor, action, target, detail, ip from audit order by id desc limit ?').all(limit) as unknown as AuditEntry[]
  }
}
