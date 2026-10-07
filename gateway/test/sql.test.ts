/** The database layer: placeholders, numbers, transactions, and the production driver (pg) over the wire. */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Store } from '../src/db.ts'
import { SCHEMA_VERSION, migrate } from '../src/schema.ts'
import { numberPlaceholders, openPglite, openPostgres, type Sql } from '../src/sql.ts'

describe('placeholders', () => {
  it('numbers ? in order', () => {
    assert.equal(numberPlaceholders('select * from t where a = ? and b in (?, ?)'), 'select * from t where a = $1 and b in ($2, $3)')
  })

  it('leaves ? alone inside strings, identifiers and comments', () => {
    assert.equal(numberPlaceholders(`select '?', 'it''s ?', "odd?name", ? -- why?\nfrom t /* ? */ where x = ?`),
      `select '?', 'it''s ?', "odd?name", $1 -- why?\nfrom t /* ? */ where x = $2`)
    assert.equal(numberPlaceholders(`select E'a\\'?', ?, $$?$$, $tag$ ? $tag$, ?`), `select E'a\\'?', $1, $$?$$, $tag$ ? $tag$, $2`)
    assert.equal(numberPlaceholders('select $1'), 'select $1', 'numbered parameters pass through')
  })
})

/** What both drivers must do the same way. */
function behaves(name: string, open: () => Promise<{ sql: Sql; stop: () => Promise<void> }>) {
  describe(name, () => {
    let sql: Sql
    let stop: () => Promise<void>

    before(async () => {
      ({ sql, stop } = await open())
      await sql.exec('create table t (id bigint primary key, n bigint, flag integer not null default 0, label text); create table u (id integer)')
    })
    after(async () => { await stop() })

    it('returns bigint, counts and sums as numbers, and flags as integers', async () => {
      const at = 1_791_000_000_123
      await sql.run('insert into t (id, n, flag, label) values (?, ?, ?, ?), (?, ?, ?, ?)', [1, at, 1, 'a?', 2, 5, 0, null])
      const row = await sql.one<{ n: number; flag: number; label: string }>('select n, flag, label from t where id = ?', [1])
      assert.deepEqual(row, { n: at, flag: 1, label: 'a?' })
      const totals = await sql.one('select count(*) as c, sum(n) as s, max(n) as m, coalesce(sum(n) filter (where false), 0) as z from t')
      assert.deepEqual(totals, { c: 2, s: at + 5, m: at, z: 0 })
      assert.equal(await sql.one('select * from t where id = ?', [99]), undefined)
    })

    it('counts the rows a statement changed', async () => {
      assert.equal(await sql.run('update t set flag = 1'), 2)
      assert.equal(await sql.run('delete from t where id = ?', [99]), 0)
    })

    it('rolls a transaction back when it throws, and commits when it resolves', async () => {
      await assert.rejects(sql.transaction(async (tx) => {
        await tx.run('insert into u (id) values (?)', [1])
        // The outer object is the same transaction inside it.
        await sql.run('insert into u (id) values (?)', [2])
        assert.equal((await sql.query('select id from u')).length, 2)
        throw new Error('no')
      }), /no/u)
      assert.deepEqual(await sql.query('select id from u'), [])
      const result = await sql.transaction(async (tx) => {
        await tx.run('insert into u (id) values (?)', [3])
        // A nested transaction joins the outer one.
        await sql.transaction(async () => { await sql.run('insert into u (id) values (?)', [4]) })
        return 'done'
      })
      assert.equal(result, 'done')
      assert.deepEqual(await sql.query('select id from u order by id'), [{ id: 3 }, { id: 4 }])
    })

    it('runs transactions one at a time', async () => {
      const order: string[] = []
      let release = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      const first = sql.transaction(async (tx) => { order.push('first'); await held; await tx.run('insert into u (id) values (5)'); order.push('first done') })
      const second = sql.transaction(async () => { order.push('second') })
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.deepEqual(order, ['first'])
      release()
      await Promise.all([first, second])
      assert.deepEqual(order, ['first', 'first done', 'second'])
    })

    it('migrates to the current schema once and keeps the store working', async () => {
      assert.equal(await migrate(sql), 0)
      assert.equal(await migrate(sql), SCHEMA_VERSION, 'a second start finds it migrated')
      const store = new Store(sql)
      await store.addMember({ name: 'alice', githubId: 9_000_009_919, githubLogin: 'alice', role: 'admin' })
      assert.equal((await store.member('alice'))?.githubId, 9_000_009_919, 'GitHub ids beyond 32 bits')
      const vendors = await sql.query<{ id: string }>('select id from vendors order by builtin desc, created_at, seq')
      assert.deepEqual(vendors.map(v => v.id), ['codex', 'claude', 'qoder', 'qwen', 'deepseek', 'qwen-voice', 'volc-voice'])
    })
  })
}

behaves('PGlite', async () => {
  const sql = await openPglite()
  return { sql, stop: () => sql.close() }
})

// The production driver (node-postgres) against PGlite served over the PostgreSQL wire protocol.
behaves('pg over the wire', async () => {
  const db = await PGlite.create()
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 })
  await server.start()
  const sql = openPostgres(`postgres://postgres@${server.getServerConn()}/postgres`, { max: 1 })
  return { sql, stop: async () => { await sql.close(); await server.stop(); await db.close() } }
})
