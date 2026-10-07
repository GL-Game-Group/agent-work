/**
 * The company service's database: PostgreSQL through node-postgres in
 * production (DATABASE_URL), or PGlite (PostgreSQL compiled to WebAssembly,
 * in this process) for tests, local development and a single-box deployment.
 * Both behind one small async interface, so the rest of the service writes
 * plain SQL with `?` placeholders and gets plain rows back:
 *
 * - `?` outside quoted strings, quoted identifiers and comments becomes `$1, $2…`;
 * - bigint (int8) and numeric results (millisecond timestamps, counts, sums)
 *   come back as JS numbers; integer flags stay 0/1;
 * - {@link Sql.transaction} runs everything inside it on one connection, also
 *   calls made through the outer `Sql` object (an AsyncLocalStorage carries the
 *   transaction to them), and transactions in this process run one at a time,
 *   as they did on SQLite.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'

export interface Sql {
  /** Rows of one statement. */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** The first row, if any. */
  one<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T | undefined>
  /** @returns the number of rows the statement changed. */
  run(text: string, params?: readonly unknown[]): Promise<number>
  /** Several statements separated by semicolons, without parameters. */
  exec(text: string): Promise<void>
  /**
   * Run `fn` in one transaction: committed when it resolves, rolled back when it
   * throws. Inside, `tx` and this object are the same transaction; a nested call joins it.
   */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  close(): Promise<void>
}

const PLACEHOLDERS = new Map<string, string>()

/**
 * `?` → `$n`, leaving quoted strings ('…', E'…'), quoted identifiers ("…"),
 * dollar-quoted strings and comments alone.
 */
export function numberPlaceholders(text: string): string {
  const cached = PLACEHOLDERS.get(text)
  if (cached !== undefined) return cached
  let out = ''
  let n = 0
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (c === "'" || c === '"') {
      // A quoted string or identifier; a doubled quote is an escaped one.
      let j = i + 1
      while (j < text.length) {
        if (text[j] === c) {
          if (text[j + 1] === c) { j += 2; continue }
          break
        }
        // E'…' strings escape with a backslash.
        if (c === "'" && text[j] === '\\' && /[eE]/u.test(text[i - 1] ?? '')) { j += 2; continue }
        j += 1
      }
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i)
      const j = end === -1 ? text.length : end
      out += text.slice(i, j)
      i = j
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const j = end === -1 ? text.length : end + 2
      out += text.slice(i, j)
      i = j
    } else if (c === '$' && !/[\w$]/u.test(text[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_]\w*)?\$/u.exec(text.slice(i))?.[0]
      if (tag === undefined) { out += c; i += 1; continue }
      const end = text.indexOf(tag, i + tag.length)
      const j = end === -1 ? text.length : end + tag.length
      out += text.slice(i, j)
      i = j
    } else if (c === '?') {
      n += 1
      out += `$${String(n)}`
      i += 1
    } else {
      out += c
      i += 1
    }
  }
  if (PLACEHOLDERS.size < 2000) PLACEHOLDERS.set(text, out)
  return out
}

/** What one connection (or a transaction on it) can do. */
interface Runner {
  query(text: string, params: readonly unknown[]): Promise<{ rows: unknown[]; count: number }>
  exec(text: string): Promise<void>
}

/** Transactions one after another, as with a single SQLite writer. */
class Lock {
  private tail: Promise<void> = Promise.resolve()

  async hold<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release = () => {}
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await fn() } finally { release() }
  }
}

abstract class BaseSql implements Sql {
  private readonly current = new AsyncLocalStorage<Runner>()
  private readonly lock = new Lock()

  protected abstract runner(): Runner
  /** Run `fn` with a runner in a transaction of its own. */
  protected abstract begin<T>(fn: (runner: Runner) => Promise<T>): Promise<T>
  abstract close(): Promise<void>

  private active(): Runner { return this.current.getStore() ?? this.runner() }

  async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.active().query(numberPlaceholders(text), params)).rows as T[]
  }

  async one<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(text, params))[0]
  }

  async run(text: string, params: readonly unknown[] = []): Promise<number> {
    return (await this.active().query(numberPlaceholders(text), params)).count
  }

  async exec(text: string): Promise<void> {
    await this.active().exec(text)
  }

  async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    if (this.current.getStore() !== undefined) return fn(this)
    return this.lock.hold(() => this.begin(runner => this.current.run(runner, () => fn(this))))
  }
}

/** int8 and numeric as numbers: millisecond timestamps, counts and sums stay far below 2^53. */
const toNumber = (value: string): number => Number(value)
const INT8 = 20
const NUMERIC = 1700

class PostgresSql extends BaseSql {
  private readonly pool: pg.Pool

  constructor(connectionString: string, max = 10) {
    super()
    this.pool = new pg.Pool({
      connectionString, max,
      types: {
        getTypeParser: ((oid: number, format?: string) =>
          oid === INT8 || oid === NUMERIC ? toNumber : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
      },
    })
    // An idle connection the server dropped must not take the process down.
    this.pool.on('error', (error) => { console.error('database: idle connection failed', error.message) })
  }

  private static runnerOf(client: pg.Pool | pg.PoolClient): Runner {
    return {
      async query(text, params) {
        const result = await client.query(text, params as unknown[])
        return { rows: result.rows, count: result.rowCount ?? 0 }
      },
      async exec(text) { await client.query(text) },
    }
  }

  protected runner(): Runner { return PostgresSql.runnerOf(this.pool) }

  protected async begin<T>(fn: (runner: Runner) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let broken = false
    try {
      await client.query('begin')
      const result = await fn(PostgresSql.runnerOf(client))
      await client.query('commit')
      return result
    } catch (error) {
      try { await client.query('rollback') } catch { broken = true }
      throw error
    } finally {
      client.release(broken)
    }
  }

  async close(): Promise<void> { await this.pool.end() }
}

/** PGlite's own parsers, with int8 and numeric as numbers. */
const PGLITE_PARSERS = { [INT8]: toNumber, [NUMERIC]: toNumber }

class PgliteSql extends BaseSql {
  readonly db: PGlite

  constructor(db: PGlite) {
    super()
    this.db = db
  }

  private static runnerOf(db: Pick<PGlite, 'query' | 'exec'>): Runner {
    return {
      async query(text, params) {
        const result = await db.query(text, params as unknown[])
        return { rows: result.rows, count: result.affectedRows ?? 0 }
      },
      async exec(text) { await db.exec(text) },
    }
  }

  protected runner(): Runner { return PgliteSql.runnerOf(this.db) }

  protected begin<T>(fn: (runner: Runner) => Promise<T>): Promise<T> {
    return this.db.transaction(tx => fn(PgliteSql.runnerOf(tx)))
  }

  async close(): Promise<void> {
    if (!this.db.closed) await this.db.close()
  }
}

/** PostgreSQL at a connection string (postgres://…), through a connection pool. */
export function openPostgres(connectionString: string, options: { max?: number } = {}): Sql {
  return new PostgresSql(connectionString, options.max)
}

/**
 * PGlite in this process.
 * @param dataDir - a directory to keep the data in; in memory when omitted.
 */
export async function openPglite(dataDir?: string): Promise<Sql & { db: PGlite }> {
  if (dataDir !== undefined) mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new PGlite({ ...dataDir === undefined ? {} : { dataDir }, parsers: PGLITE_PARSERS })
  await db.waitReady
  return new PgliteSql(db)
}

/** Where the data lives: PostgreSQL when a URL is given, otherwise PGlite in a directory (or in memory). */
export interface DatabaseConfig {
  databaseUrl?: string
  /** PGlite's data directory; null keeps the data in memory. */
  dataDir?: string | null
}

export async function openDatabase(config: DatabaseConfig): Promise<Sql> {
  if (config.databaseUrl !== undefined) return openPostgres(config.databaseUrl)
  return openPglite(config.dataDir ?? undefined)
}
