/**
 * The company service's SQLite schema as it stood before PostgreSQL (versions
 * 1 to 8, copied from gateway/src/db.ts before the port), to build source
 * databases for the migration script's tests. Do not change: it is history.
 */
import { DatabaseSync } from 'node:sqlite'

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

/**
 * Voice (GL Work for iOS): `voice` vendors, whose keys the phone never sees;
 * the company service trades the member's key for a short-lived vendor token
 * the phone uses directly (voice.ts). Their voices as the vendors list them,
 * and the token trades, for the rate limit. The vendors table is rebuilt for
 * the new type and protocols, with foreign keys off as for v7.
 */
const SCHEMA_V8 = `
create table vendors_v8 (
  id text primary key,
  name text not null,
  type text not null check (type in ('api', 'cli', 'voice')),
  auth text not null check (auth in ('key', 'account')),
  protocol text check (protocol in ('anthropic', 'openai', 'dashscope', 'volcengine')),
  base_url text,
  models_url text,
  compat text,
  models text not null default '[]',
  catalog text not null default '[]',
  catalog_at integer,
  builtin integer not null default 0,
  created_at integer not null
);
insert into vendors_v8 select id, name, type, auth, protocol, base_url, models_url, compat, models, catalog, catalog_at, builtin, created_at from vendors;
drop table vendors;
alter table vendors_v8 rename to vendors;
create table voice_catalog (
  vendor text not null references vendors(id) on delete cascade,
  id text not null,
  name text not null,
  description text,
  gender text check (gender in ('female', 'male')),
  languages text,
  family text,
  models text not null default '[]',
  sample_url text,
  enabled integer not null default 1,
  position integer not null,
  updated_at integer not null,
  primary key (vendor, id)
);
create table voice_tokens (
  member text not null,
  vendor text not null,
  at integer not null
);
create index voice_tokens_member on voice_tokens(member, at);
`

/** Built-in voice vendors (v8): Alibaba Model Studio (千问) and Volcengine (豆包语音). */
const SEED_VOICE_VENDORS: [id: string, name: string, protocol: string, baseUrl: string][] = [
  ['qwen-voice', '千问语音', 'dashscope', 'https://dashscope.aliyuncs.com'],
  ['volc-voice', '火山语音', 'volcengine', 'https://openspeech.bytedance.com'],
]

const SEED_VENDORS: [id: string, name: string, type: 'api' | 'cli', auth: 'key' | 'account', protocol: string | null, baseUrl: string | null, modelsUrl: string | null, compat: string | null, models: string][] = [
  ['codex', 'Codex', 'cli', 'account', null, null, null, null, '[]'],
  ['claude', 'Claude', 'cli', 'account', null, null, null, null, '[]'],
  ['qoder', 'Qoder', 'cli', 'account', null, null, null, null, '[]'],
  ['qwen', '千问', 'api', 'key', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', null, '{"thinkingFormat":"qwen"}', '[]'],
  ['deepseek', 'DeepSeek', 'api', 'key', 'anthropic', 'https://api.deepseek.com/anthropic', 'https://api.deepseek.com/models', null,
    '[{"id":"deepseek-flash","name":"DeepSeek-V41-Flash"},{"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro"}]'],
]

/**
 * A SQLite database at schema version 8 (or 7), migrated step by step as the
 * pre-PostgreSQL service did.
 */
export function sqliteDatabase(path: string, upTo: 7 | 8 = 8, now = Date.now()): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
  const { user_version: version } = db.prepare('pragma user_version').get() as { user_version: number }
  if (version === 0) db.exec(`begin; ${SCHEMA} pragma user_version = 1; commit;`)
  if (version <= 1) db.exec(`begin; ${SCHEMA_V2} pragma user_version = 2; commit;`)
  if (version <= 2) {
    db.exec(`begin; ${SCHEMA_V3}`)
    const seed = db.prepare('insert into vendors (id, name, type, auth, protocol, base_url, models_url, compat, models, builtin, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
    for (const row of SEED_VENDORS) seed.run(...row, now)
    db.exec('pragma user_version = 3; commit;')
  }
  if (version <= 3) db.exec(`begin; ${SCHEMA_V4} pragma user_version = 4; commit;`)
  if (version <= 4) db.exec(`begin; ${SCHEMA_V5} pragma user_version = 5; commit;`)
  if (version <= 5) db.exec(`begin; ${SCHEMA_V6} pragma user_version = 6; commit;`)
  if (version <= 6) {
    // foreign_keys only changes outside a transaction.
    db.exec('pragma foreign_keys = off;')
    try {
      db.exec(`begin; ${SCHEMA_V7}`)
      if ((db.prepare('pragma foreign_key_check').all() as unknown[]).length > 0) throw new Error('gateway: schema v7 broke a foreign key')
      db.exec('pragma user_version = 7; commit;')
    } catch (error) {
      if (db.isTransaction) db.exec('rollback')
      throw error
    } finally {
      db.exec('pragma foreign_keys = on;')
    }
  }
  if (version <= 7 && upTo >= 8) {
    db.exec('pragma foreign_keys = off;')
    try {
      db.exec(`begin; ${SCHEMA_V8}`)
      const seed = db.prepare(`insert into vendors (id, name, type, auth, protocol, base_url, builtin, created_at) values (?, ?, 'voice', 'key', ?, ?, 1, ?) on conflict (id) do nothing`)
      for (const row of SEED_VOICE_VENDORS) seed.run(...row, now)
      if ((db.prepare('pragma foreign_key_check').all() as unknown[]).length > 0) throw new Error('gateway: schema v8 broke a foreign key')
      db.exec('pragma user_version = 8; commit;')
    } catch (error) {
      if (db.isTransaction) db.exec('rollback')
      throw error
    } finally {
      db.exec('pragma foreign_keys = on;')
    }
  }
  return db
}
