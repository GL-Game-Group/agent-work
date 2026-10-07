/**
 * One-time move of the company service's data from its SQLite file (schema 7
 * or 8) into PostgreSQL:
 *
 *   DATABASE_URL=postgres://… node gateway/src/migrate-sqlite.ts <gateway.db> [--force]
 *   pnpm --filter @agent-work/gateway migrate-sqlite <gateway.db>
 *
 * (AGENT_WORK_DATA_DIR instead of DATABASE_URL writes into a PGlite directory.)
 * The SQLite file is opened read-only. The target is migrated to the current
 * schema, must hold no data yet (--force empties it first), and receives every
 * table in foreign-key order in one transaction, rows in their SQLite order;
 * identity sequences then continue after the copied ids. Sealed keys, token
 * digests and other secrets are copied byte for byte and never printed. Prints
 * the rows per table on both sides and exits non-zero when any differ.
 * Stop the service first, so the file does not change underneath.
 */
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { migrate, SEED_VOICE_VENDORS } from './schema.ts'
import { openDatabase, type Sql } from './sql.ts'

interface Table {
  name: string
  columns: string[]
  /** Copied as the SQLite rowid: an integer primary key (`id`), or `seq`, the order rows were added in. */
  rowid?: 'id' | 'seq'
  /** Only from schema version 8. */
  since?: 8
}

/** Every table, parents before children. */
const TABLES: Table[] = [
  { name: 'members', columns: ['name', 'github_id', 'github_login', 'role', 'status', 'created_at', 'display_name', 'team', 'tunnels', 'ssh'] },
  { name: 'credentials', rowid: 'seq', columns: ['id', 'member', 'kind', 'token_hash', 'label', 'created_at', 'expires_at', 'last_used_at', 'revoked_at', 'last_ip'] },
  { name: 'oauth_states', columns: ['state_hash', 'kind', 'return_to', 'redirect_port', 'code_challenge', 'client_state', 'expires_at'] },
  { name: 'login_codes', columns: ['code_hash', 'member', 'code_challenge', 'expires_at', 'kind'] },
  { name: 'audit', rowid: 'id', columns: ['at', 'actor', 'action', 'target', 'detail', 'ip'] },
  { name: 'llm_usage', rowid: 'id', columns: ['at', 'member', 'credential', 'model', 'status', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'vendor', 'api_key'] },
  { name: 'vendors', rowid: 'seq', columns: ['id', 'name', 'type', 'auth', 'protocol', 'base_url', 'models_url', 'compat', 'models', 'catalog', 'catalog_at', 'builtin', 'created_at'] },
  { name: 'api_keys', rowid: 'seq', columns: ['id', 'vendor', 'label', 'secret', 'last4', 'status', 'created_at', 'mode'] },
  { name: 'subscriptions', rowid: 'seq', columns: ['id', 'vendor', 'plan', 'seats', 'price', 'cycle', 'renews_at', 'owner', 'note', 'created_at'] },
  { name: 'cli_accounts', columns: ['id', 'vendor', 'account', 'note', 'created_at', 'subscription'] },
  { name: 'member_vendors', columns: ['member', 'vendor', 'api_key', 'cli_account', 'created_at', 'mode'] },
  { name: 'public_config', columns: ['key', 'value', 'secret', 'note', 'updated_at', 'group_name', 'reads', 'last_read_at'] },
  { name: 'plugins', rowid: 'seq', columns: ['name', 'display_name', 'description', 'version', 'url', 'integrity', 'size', 'permissions', 'status', 'preinstalled', 'created_at', 'updated_at'] },
  { name: 'device_plugins', columns: ['credential', 'plugin', 'version', 'reported_at'] },
  { name: 'tunnel_domains', rowid: 'seq', columns: ['name', 'is_default', 'dns', 'cert', 'checked_at', 'note', 'created_at'] },
  { name: 'tunnels', rowid: 'seq', columns: ['id', 'member', 'device', 'type', 'name', 'domain', 'local_port', 'protection', 'ssh_access', 'secret_key', 'public_port', 'closed_by', 'online', 'last_seen_at', 'created_at', 'updated_at'] },
  { name: 'app_settings', columns: ['key', 'value'] },
  { name: 'voice_catalog', since: 8, columns: ['vendor', 'id', 'name', 'description', 'gender', 'languages', 'family', 'models', 'sample_url', 'enabled', 'position', 'updated_at'] },
  { name: 'voice_tokens', since: 8, columns: ['member', 'vendor', 'at'] },
]

/** Rows per insert statement (PostgreSQL takes at most 65535 parameters). */
const BATCH = 200

export interface TableCount { table: string; sqlite: number; postgres: number }

export class MigrationRefused extends Error {}

/** The SQLite file's schema version, if it is one this script reads. */
export function sourceVersion(source: DatabaseSync): 7 | 8 {
  const { user_version: version } = source.prepare('pragma user_version').get() as { user_version: number }
  if (version !== 7 && version !== 8) {
    throw new MigrationRefused(`the SQLite file is at schema version ${String(version)}; this script reads versions 7 and 8 (start the old service on it once to bring it to 8)`)
  }
  return version
}

async function count(sql: Sql, table: string): Promise<number> {
  return (await sql.one<{ n: number }>(`select count(*) as n from ${table}`))?.n ?? 0
}

/**
 * Copy everything from the SQLite database into the PostgreSQL one.
 * @returns the rows per table on both sides (the voice vendors PostgreSQL seeds count as copied from a v7 file).
 */
export async function copySqlite(source: DatabaseSync, target: Sql, options: { force?: boolean; now?: () => number } = {}): Promise<TableCount[]> {
  const version = sourceVersion(source)
  await migrate(target, options.now)
  const tables = TABLES.filter(t => t.since === undefined || version >= t.since)

  // Nothing but the vendors a new database starts with, unless told to replace what is there.
  if (options.force !== true) {
    const members = await count(target, 'members')
    if (members > 0) throw new MigrationRefused(`the target already has ${String(members)} members; add --force to empty it first`)
    for (const table of TABLES) {
      const held = table.name === 'vendors'
        ? (await target.one<{ n: number }>('select count(*) as n from vendors where builtin = 0'))?.n ?? 0
        : await count(target, table.name)
      if (held > 0) throw new MigrationRefused(`the target's ${table.name} table is not empty; add --force to empty it first`)
    }
  }

  const seededVoice: string[] = []
  await target.transaction(async (tx) => {
    await tx.exec(`truncate ${TABLES.map(t => t.name).join(', ')} restart identity`)
    for (const table of tables) {
      const columns = table.rowid === undefined ? table.columns : [table.rowid, ...table.columns]
      const select = `select ${table.rowid === undefined ? '' : 'rowid as rowid_, '}${table.columns.join(', ')} from ${table.name} order by rowid`
      const rows = source.prepare(select).all() as Record<string, unknown>[]
      for (let at = 0; at < rows.length; at += BATCH) {
        const batch = rows.slice(at, at + BATCH)
        const values = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
        const params = batch.flatMap(row => [...table.rowid === undefined ? [] : [row.rowid_], ...table.columns.map(column => row[column] ?? null)])
        await tx.run(`insert into ${table.name} (${columns.join(', ')}) values ${values}`, params)
      }
      // Identity columns continue after the copied rows.
      if (table.rowid !== undefined) {
        await tx.query(`select setval(pg_get_serial_sequence('${table.name}', '${table.rowid}'), coalesce(max(${table.rowid}), 0) + 1, false) from ${table.name}`)
      }
    }
    // A v7 file has no voice vendors yet: add them as SQLite's v8 step would have.
    if (version === 7) {
      const now = (options.now ?? Date.now)()
      for (const [id, name, protocol, baseUrl] of SEED_VOICE_VENDORS) {
        const added = await tx.run(`insert into vendors (id, name, type, auth, protocol, base_url, builtin, created_at) values (?, ?, 'voice', 'key', ?, ?, 1, ?) on conflict (id) do nothing`,
          [id, name, protocol, baseUrl, now])
        if (added > 0) seededVoice.push(id)
      }
    }
  })

  const result: TableCount[] = []
  for (const table of TABLES) {
    const present = version >= (table.since ?? 0)
    const sqlite = present ? (source.prepare(`select count(*) as n from ${table.name}`).get() as { n: number }).n : 0
    result.push({ table: table.name, sqlite: sqlite + (table.name === 'vendors' ? seededVoice.length : 0), postgres: await count(target, table.name) })
  }
  return result
}

async function main(): Promise<number> {
  if (process.env.AGENT_WORK_ENV_FILE !== undefined) process.loadEnvFile(process.env.AGENT_WORK_ENV_FILE)
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { force: { type: 'boolean' } } })
  const file = positionals[0]
  if (file === undefined || positionals.length > 1) {
    console.error('usage: DATABASE_URL=postgres://… node gateway/src/migrate-sqlite.ts <gateway.db> [--force]')
    return 2
  }
  const databaseUrl = process.env.DATABASE_URL || process.env.AGENT_WORK_DATABASE_URL || undefined
  const dataDir = process.env.AGENT_WORK_DATA_DIR || undefined
  if (databaseUrl === undefined && dataDir === undefined) {
    console.error('migrate-sqlite: set DATABASE_URL (PostgreSQL) or AGENT_WORK_DATA_DIR (PGlite) to say where the data goes')
    return 2
  }
  const source = new DatabaseSync(file, { readOnly: true })
  const target = await openDatabase(databaseUrl === undefined ? { dataDir } : { databaseUrl })
  try {
    console.log(`migrate-sqlite: ${file} (schema ${String(sourceVersion(source))}) → ${databaseUrl === undefined ? `PGlite ${dataDir ?? ''}` : 'PostgreSQL (DATABASE_URL)'}`)
    const counts = await copySqlite(source, target, { force: values.force === true })
    const width = Math.max(...counts.map(c => c.table.length))
    console.log(`${'TABLE'.padEnd(width)}  ${'SQLITE'.padStart(8)}  ${'POSTGRES'.padStart(8)}`)
    for (const c of counts) console.log(`${c.table.padEnd(width)}  ${String(c.sqlite).padStart(8)}  ${String(c.postgres).padStart(8)}${c.sqlite === c.postgres ? '' : '  ← differs'}`)
    const differ = counts.filter(c => c.sqlite !== c.postgres)
    if (differ.length > 0) {
      console.error(`migrate-sqlite: ${String(differ.length)} tables differ: ${differ.map(c => c.table).join(', ')}`)
      return 1
    }
    console.log('migrate-sqlite: every table copied')
    return 0
  } catch (error) {
    // The message only: drivers attach the statement's parameters (keys, token digests) to their errors.
    const { message, constraint, table } = error as { message?: string; constraint?: string; table?: string }
    console.error(`migrate-sqlite: ${message ?? String(error)}${table === undefined ? '' : ` (table ${table}${constraint === undefined ? '' : `, constraint ${constraint}`})`}`)
    if (!(error instanceof MigrationRefused)) console.error('migrate-sqlite: nothing was written (the copy runs in one transaction)')
    return 1
  } finally {
    source.close()
    await target.close()
  }
}

if (import.meta.main) process.exitCode = await main()
