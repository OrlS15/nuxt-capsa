import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { capsaSource, importModule, writeFiles } from './nuxt'

// A server is skipped unless its variable is set. Its user must be able to create databases, because each test uses its own.
const SERVERS = [
  {
    config: { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres' },
    url: process.env.CAPSA_TEST_POSTGRES_URL,
    table: 'drizzle.__drizzle_migrations',
    sleep: 'select pg_sleep(3)',
    rows: async (db: unknown, query: string) => (await (db as NodePgDatabase).execute(sql.raw(query))).rows,
  },
  {
    config: { provider: 'drizzle', dialect: 'mysql', driver: 'mysql2' },
    url: process.env.CAPSA_TEST_MYSQL_URL,
    table: '__drizzle_migrations',
    sleep: 'select sleep(3)',
    rows: async (db: unknown, query: string) => (await (db as MySql2Database).execute(sql.raw(query)))[0],
  },
] as const

const INIT = 'CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);'
const SEED = `INSERT INTO users (id, name) VALUES (1, 'ada');`
const APPLIED = [{ name: '20260101000000_init' }, { name: '20260102000000_seed' }]

for (const { config, url, table, sleep, rows } of SERVERS) {
  describe.skipIf(!url)(`migrating a real ${config.driver} server`, { timeout: 30_000 }, () => {
    const applied = `select hash, created_at, name from ${table} order by id`
    const closing: (() => unknown)[] = []
    const databases: string[] = []
    let folders: string
    let drizzle: (options: { connection: string }) => { $client: { end: () => unknown } }
    let admin: ReturnType<typeof drizzle>

    beforeAll(async () => {
      folders = await mkdtemp(join(tmpdir(), 'capsa-servers-'))
      await writeFiles(folders, {
        'good/20260101000000_init/migration.sql': INIT,
        'good/20260102000000_seed/migration.sql': SEED,
        // Long enough for the second source to read an empty history, and to collide unless the lock holds it back.
        'slow/20260101000000_init/migration.sql': `${sleep};\n--> statement-breakpoint\n${INIT}`,
        'slow/20260102000000_seed/migration.sql': SEED,
        // Alone in its folder: MySQL commits DDL on its own, and a table left behind would fail the next run for its own reason.
        'broken/20260101000000_broken/migration.sql': 'THIS IS NOT SQL',
      })
      ;({ drizzle } = await importModule(`drizzle-orm/${config.driver}`))
      admin = drizzle({ connection: url! })
    })

    afterEach(async () => {
      await Promise.all(closing.splice(0).map(close => close()))
      for (const name of databases.splice(0)) await rows(admin, `drop database ${name}`)
    })

    afterAll(async () => {
      await admin.$client.end()
      await rm(folders, { recursive: true, force: true })
    })

    /**
     * Creates a database that is dropped after the running test, and returns its URL.
     *
     * @example
     * await freshDatabase()  // 'mysql://root:capsa@127.0.0.1:53306/capsa_0f3a…'
     */
    async function freshDatabase() {
      const name = `capsa_${randomUUID().replaceAll('-', '')}`
      const database = new URL(url!)

      await rows(admin, `create database ${name}`)
      databases.push(name)
      database.pathname = `/${name}`

      return database.href
    }

    /**
     * Loads capsa's module for a source on `database`, as one more server would: it opens its own pool, closed after the test.
     *
     * @example
     * const { applyMigrations } = await source(await freshDatabase(), 'good')
     */
    const source = (database: string, folder: string) => capsaSource(config, database, join(folders, folder), closing)

    it('records the same rows as drizzle\'s own migrator', async () => {
      const capsa = await source(await freshDatabase(), 'good')
      const { migrate } = await importModule(`drizzle-orm/${config.driver}/migrator`)
      const reference = drizzle({ connection: await freshDatabase() })

      closing.push(() => reference.$client.end())

      await capsa.applyMigrations()
      await migrate(reference, { migrationsFolder: join(folders, 'good') })

      expect(await rows(capsa.getDb(), applied)).toEqual(await rows(reference, applied))
      expect(await rows(capsa.getDb(), applied)).toMatchObject(APPLIED)
      expect(await rows(capsa.getDb(), 'select id, name from users')).toEqual([{ id: 1, name: 'ada' }])
    })

    it('migrates once when two sources start together, and neither fails', async () => {
      const database = await freshDatabase()
      const one = await source(database, 'slow')
      const two = await source(database, 'slow')

      await Promise.all([one.applyMigrations(), two.applyMigrations()])

      expect(await rows(one.getDb(), applied)).toMatchObject(APPLIED)
      expect(await rows(one.getDb(), 'select id, name from users')).toEqual([{ id: 1, name: 'ada' }])
    })

    // The first source's pool stays open: on MySQL, a lock its session kept would hold the second one back until the timeout.
    it('frees the lock after a run, for the next source to take it', async () => {
      const database = await freshDatabase()
      const first = await source(database, 'good')
      const next = await source(database, 'good')

      await first.applyMigrations()
      await next.applyMigrations()

      expect(await rows(next.getDb(), applied)).toMatchObject(APPLIED)
    })

    it('frees the lock after a run that fails, for the next source to take it', async () => {
      const database = await freshDatabase()
      const failing = await source(database, 'broken')
      const next = await source(database, 'good')

      await expect(failing.applyMigrations()).rejects.toThrow()
      await next.applyMigrations()

      expect(await rows(next.getDb(), applied)).toMatchObject(APPLIED)
    })

    it('closes the client when the server stops', async () => {
      const { getDb } = await source(await freshDatabase(), 'good')

      await rows(getDb(), 'select 1 as one')
      expect(closing).toHaveLength(1)

      await Promise.all(closing.splice(0).map(close => close()))

      await expect(rows(getDb(), 'select 1 as one')).rejects.toThrow()
    })
  })
}
