/** The one-time copy from the SQLite file into PostgreSQL. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/db.ts'
import { copySqlite, MigrationRefused } from '../src/migrate-sqlite.ts'
import { SecretBox } from '../src/secrets.ts'
import { openPglite, type Sql } from '../src/sql.ts'
import { digest } from '../src/tokens.ts'
import { Vendors } from '../src/vendors.ts'
import { sqliteDatabase } from './fixtures/sqlite-schema.ts'

const SECRET_KEY = Buffer.alloc(32, 7).toString('hex')
const T0 = 1_790_000_000_000
const TOKEN = 'awd_fixture-device-token'

/** Representative rows in every table, with the odd cases: nulls, gaps in ids, revoked and expired rows, secrets. */
function fill(db: DatabaseSync, version: 7 | 8): void {
  const box = SecretBox.fromEncoded(SECRET_KEY)
  const run = (sql: string, ...params: (string | number | null)[]) => { db.prepare(sql).run(...params) }
  run(`insert into members (name, github_id, github_login, role, status, created_at, display_name, team, tunnels, ssh) values
    ('wuming', 9000009919, 'eva2show', 'admin', 'active', ?, '吴明', 'dev', 1, 1),
    ('lina', 9000001024, 'lina-pm', 'member', 'active', ?, null, 'product', 0, 0),
    ('zhaolei', 9000016384, 'zhaolei', 'member', 'disabled', ?, '赵磊', null, 1, 0)`, T0, T0 + 1, T0 + 2)
  // Same created_at: the order they were added in must survive.
  run(`insert into credentials (id, member, kind, token_hash, label, created_at, expires_at, last_used_at, revoked_at, last_ip) values
    ('cred-mac', 'wuming', 'device', ?, 'MacBook Pro 16"（darwin-arm64）', ?, ?, ?, null, '58.247.10.21'),
    ('cred-a', 'wuming', 'browser', ?, 'Chrome · macOS', ?, ?, null, null, null),
    ('cred-0', 'wuming', 'key', ?, 'CI 脚本', ?, ?, null, null, null),
    ('cred-phone', 'lina', 'phone', ?, 'iPhone', ?, ?, null, ?, null)`,
  digest(TOKEN), T0, T0 + 9e12, T0 + 5, digest('aws_x'), T0, T0 + 1000, digest('awk_x'), T0, T0 + 9e12, digest('awp_x'), T0, T0 + 9e12, T0 + 7)
  run(`insert into oauth_states values (?, 'desktop', null, 49152, ?, 'client-state-0123456789', ?)`, digest('state'), 'c'.repeat(43), T0 + 600_000)
  run(`insert into login_codes (code_hash, member, code_challenge, expires_at, kind) values (?, 'lina', ?, ?, 'phone')`, digest('code'), 'd'.repeat(43), T0 + 60_000)
  for (let i = 0; i < 5; i += 1) run(`insert into audit (at, actor, action, target, detail, ip) values (?, ?, 'login', ?, ?, ?)`, T0 + i, i === 0 ? null : 'wuming', `t${String(i)}`, i === 2 ? null : '设备 ✓', '10.0.0.1')
  run('delete from audit where id = 3')
  for (let i = 0; i < 450; i += 1) {
    run(`insert into llm_usage (at, member, credential, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, vendor, api_key) values (?, ?, 'cred-mac', ?, 200, ?, ?, ?, 0, ?, ?)`,
      T0 + i * 60_000, i % 3 === 0 ? 'lina' : 'wuming', i % 7 === 0 ? null : 'deepseek-flash', 180_000 + i, 14_000, 3_000_000_000 + i, i % 5 === 0 ? null : 'deepseek', i % 5 === 0 ? null : 'key_shared')
  }
  run(`insert into vendors (id, name, type, auth, protocol, base_url, models_url, compat, models, catalog, catalog_at, builtin, created_at) values
    ('volcengine', '火山方舟', 'api', 'key', 'openai', 'https://ark.cn-beijing.volces.com/api/v3', null, '{"x":1}', '[{"id":"doubao"}]', '["doubao","other"]', ?, 0, ?)`, T0 + 3, T0 + 1)
  run(`insert into api_keys (id, vendor, label, secret, last4, status, created_at, mode) values
    ('key_shared', 'deepseek', '公司主账号', ?, 'c893', 'active', ?, 'shared'),
    ('key_dedicated', 'deepseek', '研发专用', ?, '7a1e', 'disabled', ?, 'dedicated')`, box.seal('sk-shared-c893'), T0, box.seal('sk-dedicated-7a1e'), T0)
  run(`insert into subscriptions values ('sub_claude', 'claude', 'Claude Max 5x', 2, '$100', 'monthly', ?, 'wuming', '公司信用卡', ?)`, T0 + 4 * 86_400_000, T0)
  run(`insert into subscriptions (id, vendor, plan, seats, price, cycle, renews_at, owner, note, created_at) values ('sub_codex', 'codex', 'Team', 3, null, 'yearly', null, null, null, ?)`, T0)
  run(`insert into cli_accounts (id, vendor, account, note, created_at, subscription) values
    ('acct_1', 'claude', 'ai-claude-1@glgwork.com', null, ?, 'sub_claude'),
    ('acct_2', 'codex', 'Codex-Dev@glgwork.com', '共用', ?, null)`, T0, T0)
  run(`insert into member_vendors (member, vendor, api_key, cli_account, created_at, mode) values
    ('wuming', 'deepseek', 'key_shared', null, ?, 'shared'),
    ('wuming', 'claude', null, 'acct_1', ?, 'account'),
    ('lina', 'deepseek', null, null, ?, null)`, T0, T0, T0)
  run(`insert into public_config (key, value, secret, note, updated_at, group_name, reads, last_read_at) values
    ('oss.bucket', 'gl-work-assets', 0, null, ?, '阿里云 OSS', 3, ?),
    ('oss.accessKeySecret', ?, 1, '只读', ?, '阿里云 OSS', 0, null),
    ('Release.channel', 'beta', 0, null, ?, null, 0, null)`, T0, T0 + 9, box.seal('oss-secret'), T0, T0)
  run(`insert into plugins values ('@agent-work/dsh-tunnel', '内网穿透', null, '0.1.0', 'https://oss.example/t.tgz', 'sha512-abc', 123456, '["运行 frpc"]', 'published', 1, ?, ?)`, T0, T0)
  run(`insert into plugins (name, display_name, description, version, url, integrity, size, permissions, status, preinstalled, created_at, updated_at) values ('@agent-work/dsh-prd', '需求', '起草', '0.2.0', 'https://oss.example/p.tgz', 'sha512-def', 9, '[]', 'hidden', 0, ?, ?)`, T0, T0)
  run(`insert into device_plugins values ('cred-mac', '@agent-work/dsh-tunnel', '0.1.0', ?)`, T0)
  run(`insert into tunnel_domains (name, is_default, dns, cert, checked_at, note, created_at) values ('t.glwork.app', 1, 'ok', 'ok', ?, '泛解析', ?), ('preview.glwork.app', 0, 'unknown', 'unknown', null, null, ?)`, T0, T0, T0)
  run(`insert into tunnels (id, member, device, type, name, domain, local_port, protection, ssh_access, secret_key, public_port, closed_by, online, last_seen_at, created_at, updated_at) values
    ('tun_web', 'wuming', 'cred-mac', 'http', 'preview', 't.glwork.app', 5173, 'password', null, null, null, null, 1, ?, ?, ?),
    ('tun_ssh', 'wuming', 'cred-mac', 'ssh', 'devbox', null, 22, 'public', '["lina"]', 'secret-key-0123456789', 20001, 'lina', 0, null, ?, ?),
    ('tun_remote', 'wuming', 'cred-mac', 'remote', 'r0123456789abcdef01234567', 'remote.internal', 0, 'public', null, null, null, null, 0, null, ?, ?)`,
  T0, T0, T0, T0, T0, T0, T0)
  run(`insert into app_settings values ('tunnels', '{"perMember":7}')`)
  if (version === 8) {
    run(`insert into app_settings values ('voice', '{"vendors":{"qwen-voice":{"tts":true}}}')`)
    run(`insert into voice_catalog values ('qwen-voice', 'Cherry', '芊悦', '阳光', 'female', '中文', 'qwen3-tts', '["qwen3-tts-flash"]', 'https://x/c.wav', 1, 0, ?), ('qwen-voice', 'Ethan', '晨煦', null, 'male', null, null, '[]', null, 0, 1, ?)`, T0, T0)
    run(`insert into voice_tokens values ('wuming', 'qwen-voice', ?), ('wuming', 'qwen-voice', ?)`, T0, T0 + 1)
  }
}

const KEYS: Record<string, string> = {
  members: 'name', credentials: 'id', oauth_states: 'state_hash', login_codes: 'code_hash', audit: 'id', llm_usage: 'id', vendors: 'id', api_keys: 'id',
  subscriptions: 'id', cli_accounts: 'id', member_vendors: 'member, vendor', public_config: 'key', plugins: 'name', device_plugins: 'credential, plugin',
  tunnel_domains: 'name', tunnels: 'id', app_settings: 'key', voice_catalog: 'vendor, id', voice_tokens: 'member, vendor, at',
}

/** Every row of a table on both sides, column by column (PostgreSQL's own `seq` left out). */
/** Columns PostgreSQL schema steps added after the SQLite era: copied rows leave them empty. */
const ADDED: Record<string, string[]> = { tunnels: ['client'] }
/** Columns newer than SQLite that the copy derives from a copied one. */
const DERIVED: Record<string, Record<string, (row: Record<string, unknown>) => unknown>> = {
  voice_catalog: { state: row => row.enabled === 1 ? 'enabled' : 'available' },
}

async function sameRows(source: DatabaseSync, target: Sql, table: string): Promise<void> {
  const order = `${KEYS[table] ?? ''}`
  const want = (source.prepare(`select * from ${table} order by ${order}`).all() as Record<string, unknown>[]).map(row => ({ ...row }))
  const got = (await target.query(`select * from ${table} order by ${order}`)).map(({ seq: _seq, ...row }) => {
    for (const column of ADDED[table] ?? []) {
      assert.equal(row[column], null, `${table}.${column}`)
      delete row[column]
    }
    for (const [column, derive] of Object.entries(DERIVED[table] ?? {})) {
      assert.equal(row[column], derive(row), `${table}.${column}`)
      delete row[column]
    }
    return row
  })
  assert.deepEqual(got, want, table)
}

describe('copying the SQLite file into PostgreSQL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-migrate-'))
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  describe('from schema 8', () => {
    let source: DatabaseSync
    let target: Sql & { db: unknown }

    before(async () => {
      source = sqliteDatabase(join(dir, 'v8.db'), 8, T0)
      fill(source, 8)
      target = await openPglite()
    })
    after(async () => { source.close(); await target.close() })

    it('copies every table and counts the same rows on both sides', async () => {
      const counts = await copySqlite(source, target)
      assert.equal(counts.length, 19)
      for (const c of counts) assert.equal(c.postgres, c.sqlite, c.table)
      assert.ok(counts.every(c => c.sqlite > 0), 'the fixture fills every table')
      for (const { table } of counts) await sameRows(source, target, table)
    })

    it('keeps secrets readable, tokens valid, and the order rows were added in', async () => {
      const store = new Store(target)
      const signedIn = await store.authenticate(TOKEN, 'device')
      assert.equal(signedIn?.member.name, 'wuming')
      const vendors = new Vendors(store, SecretBox.fromEncoded(SECRET_KEY))
      assert.equal(await vendors.keySecret('key_shared'), 'sk-shared-c893')
      assert.equal((await vendors.publicValues())['oss.accessKeySecret'], 'oss-secret')
      const sqliteOrder = (source.prepare('select id from vendors order by builtin desc, created_at, rowid').all() as { id: string }[]).map(v => v.id)
      assert.deepEqual((await vendors.listVendors()).map(v => v.id), sqliteOrder)
      assert.deepEqual((await store.listCredentials('wuming')).map(c => c.id), ['cred-mac', 'cred-0'], 'same created_at: in the order added (not by id); expired left out')
    })

    it('continues ids after the copied ones', async () => {
      const store = new Store(target)
      await store.audit({ actor: 'wuming', action: 'after', target: null, detail: null, ip: null })
      const [latest] = await store.recentAudit(1)
      const max = (source.prepare('select max(id) as id from audit').get() as { id: number }).id
      assert.equal((await target.one<{ id: number }>(`select id from audit where action = 'after'`))?.id, max + 1)
      assert.equal(latest?.action, 'after')
      await target.run(`insert into tunnel_domains (name, created_at) values ('later.glwork.app', ?)`, [T0])
      assert.deepEqual((await target.query<{ name: string }>('select name from tunnel_domains order by seq')).map(d => d.name), ['t.glwork.app', 'preview.glwork.app', 'later.glwork.app'])
    })

    it('refuses a target that already has members, and replaces it with --force', async () => {
      await assert.rejects(copySqlite(source, target), (error: unknown) => error instanceof MigrationRefused && /3 members/u.test(error.message))
      const counts = await copySqlite(source, target, { force: true })
      for (const c of counts) assert.equal(c.postgres, c.sqlite, c.table)
      await sameRows(source, target, 'audit')
    })
  })

  describe('from schema 7', () => {
    it('copies what a v7 file has and adds the voice vendors', async () => {
      const source = sqliteDatabase(join(dir, 'v7.db'), 7, T0)
      fill(source, 7)
      const target = await openPglite()
      try {
        const counts = await copySqlite(source, target, { now: () => T0 + 99 })
        for (const c of counts) assert.equal(c.postgres, c.sqlite, c.table)
        assert.deepEqual(counts.filter(c => c.table.startsWith('voice_')).map(c => c.postgres), [0, 0])
        const voice = await target.query<{ id: string; type: string }>(`select id, type from vendors where type = 'voice' order by seq`)
        assert.deepEqual(voice.map(v => v.id), ['qwen-voice', 'volc-voice'])
        for (const table of ['members', 'credentials', 'api_keys', 'tunnels', 'llm_usage']) await sameRows(source, target, table)
      } finally {
        source.close()
        await target.close()
      }
    })

    it('refuses older files', async () => {
      const { DatabaseSync: Sqlite } = await import('node:sqlite')
      const empty = new Sqlite(':memory:')
      const target = await openPglite()
      await assert.rejects(copySqlite(empty, target), /schema version 0/u)
      empty.close()
      await target.close()
    })
  })

  it('runs from the command line into a PGlite directory, printing counts but no values', async () => {
    const file = join(dir, 'cli.db')
    const source = sqliteDatabase(file, 8, T0)
    fill(source, 8)
    source.close()
    const script = resolve(import.meta.dirname, '../src/migrate-sqlite.ts')
    const env = { ...process.env, AGENT_WORK_DATA_DIR: join(dir, 'pglite'), DATABASE_URL: '', AGENT_WORK_DATABASE_URL: '' }
    const { stdout } = await promisify(execFile)(process.execPath, [script, file], { env })
    assert.match(stdout, /llm_usage\s+450\s+450/u)
    assert.match(stdout, /every table copied/u)
    assert.doesNotMatch(stdout, /sk-shared|v1:|oss-secret/u)
    const again = await promisify(execFile)(process.execPath, [script, file], { env }).then(() => 0, (error: { code: number; stderr: string }) => { assert.match(error.stderr, /--force/u); return error.code })
    assert.equal(again, 1, 'a second run into the same target is refused')
    // Before every start of the service (--once): copies the first time, then leaves the target alone.
    const once = await promisify(execFile)(process.execPath, [script, file, '--once'], { env })
    assert.match(once.stdout, /migrated before, nothing to do/u)
    const fresh = { ...env, AGENT_WORK_DATA_DIR: join(dir, 'pglite-once') }
    assert.match((await promisify(execFile)(process.execPath, [script, file, '--once'], { env: fresh })).stdout, /every table copied/u)
    assert.match((await promisify(execFile)(process.execPath, [script, file, '--once'], { env: fresh })).stdout, /nothing to do/u)
  })
})
