/** A fresh in-memory PostgreSQL (PGlite) per suite, usable at once. */
import { Store } from '../src/db.ts'
import { migrate } from '../src/schema.ts'
import { openPglite, type Sql } from '../src/sql.ts'

/**
 * An Sql that opens and migrates its PGlite database on first use, so suites
 * can create their store synchronously where they declare it.
 */
export function memoryDatabase(now: () => number = Date.now): Sql {
  let opened: Promise<Sql> | undefined
  const db = (): Promise<Sql> => {
    opened ??= openPglite().then(async (sql) => { await migrate(sql, now); return sql })
    return opened
  }
  return {
    async query<T>(text: string, params?: readonly unknown[]) { return (await db()).query<T>(text, params) },
    async one<T>(text: string, params?: readonly unknown[]) { return (await db()).one<T>(text, params) },
    async run(text: string, params?: readonly unknown[]) { return (await db()).run(text, params) },
    async exec(text: string) { await (await db()).exec(text) },
    async transaction<T>(fn: (tx: Sql) => Promise<T>) { return (await db()).transaction(fn) },
    async close() { if (opened !== undefined) await (await opened).close() },
  }
}

/** A store on a fresh in-memory database. */
export function memoryStore(now: () => number = Date.now): Store {
  return new Store(memoryDatabase(now), now)
}
