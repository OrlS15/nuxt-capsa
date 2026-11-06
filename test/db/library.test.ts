import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { formatToMillis } from 'drizzle-orm/migrator.utils'
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readMigrations } from '../../src/runtime/db/drizzle/migrations'
import { importModule, writeFiles } from '../helpers/nuxt'
import { capsaSource, folderStorage } from './source'

/**
 * What capsa assumes of drizzle, checked on the real drizzle and on databases that live in memory: when drizzle
 * changes under capsa, these are the tests that fail. The generated module itself runs wherever it can.
 */

// Two migrations sharing a timestamp and differing in case, a breakpoint, a snapshot, a name with no timestamp.
const FIXTURE = fileURLToPath(new URL('../fixtures/migrations', import.meta.url))

describe('drizzle\'s migration files', () => {
  it('are read from Nitro\'s storage exactly as drizzle reads them from disk', async () => {
    expect(await readMigrations(folderStorage(FIXTURE), formatToMillis)).toStrictEqual(readMigrationFiles({ migrationsFolder: FIXTURE }))
  })
})

const INIT = `CREATE TABLE "users" ("id" integer PRIMARY KEY, "name" text NOT NULL);
--> statement-breakpoint
CREATE INDEX "users_name_idx" ON "users" ("name");`

/** Reads rows with a driver's own call: each one hands them back its way. */
type Rows = (db: unknown, query: string) => Promise<unknown[]>

// The drivers that run in this process, with where drizzle records migrations and the drizzle options of their store.
const EMBEDDED: { driver: string, dialect: string, connection: string | object, table: string, rows: Rows }[] = [
  {
    driver: 'pglite',
    dialect: 'postgresql',
    connection: 'memory://',
    table: 'drizzle.__drizzle_migrations',
    rows: async (db, query) => (await (db as PgliteDatabase).execute(sql.raw(query))).rows,
  },
  {
    // Synchronous: migrated with drizzle's `migrateSync`, on the session.
    driver: 'node-sqlite',
    dialect: 'sqlite',
    connection: ':memory:',
    table: '__drizzle_migrations',
    rows: async (db, query) => (db as NodeSQLiteDatabase).all(sql.raw(query)),
  },
  {
    // No interactive transaction: migrated in one call of libsql's `session.migrate`.
    driver: 'libsql',
    dialect: 'sqlite',
    connection: ':memory:',
    table: '__drizzle_migrations',
    rows: async (db, query) => (await (db as LibSQLDatabase).run(sql.raw(query))).rows,
  },
]

const folders = await mkdtemp(join(tmpdir(), 'capsa-migrations-'))

afterAll(() => rm(folders, { recursive: true, force: true }))

beforeAll(() => writeFiles(folders, {
  'good/20260101000000_init/migration.sql': INIT,
  'good/20260102000000_seed/migration.sql': `INSERT INTO "users" ("id", "name") VALUES (1, 'ada');`,
  'broken/20260101000000_init/migration.sql': INIT,
  'broken/20260102000000_broken/migration.sql': 'THIS IS NOT SQL',
}))

// A source migrates through the module capsa generates for it, and a second database through drizzle's own migrator
// for the driver, the one drizzle-kit runs: both have to end up the same.
describe.each(EMBEDDED)('migrating $driver', ({ driver, dialect, connection, table, rows }) => {
  const config = { provider: 'drizzle', dialect, driver } as const
  const applied = `select hash, created_at, name from ${table} order by id`

  it('records the same rows as drizzle\'s own migrator, and applies the SQL', async () => {
    const source = await capsaSource(config, { connection: String(connection), migrations: join(folders, 'good') })
    const { drizzle } = await importModule(`drizzle-orm/${driver}`)
    const { migrate } = await importModule(`drizzle-orm/${driver}/migrator`)
    const reference = drizzle({ connection })

    await source.applyMigrations()
    await migrate(reference, { migrationsFolder: join(folders, 'good') })

    expect(await rows(source.getDb(), applied)).toEqual(await rows(reference, applied))
    expect(await rows(source.getDb(), applied)).toMatchObject([{ name: '20260101000000_init' }, { name: '20260102000000_seed' }])
    expect(await rows(source.getDb(), 'select id, name from users')).toEqual([{ id: 1, name: 'ada' }])
  })

  it('applies nothing again on the next run', async () => {
    const source = await capsaSource(config, { connection: String(connection), migrations: join(folders, 'good') })

    await source.applyMigrations()
    await source.applyMigrations()

    expect(await rows(source.getDb(), applied)).toHaveLength(2)
  })

  it('applies nothing of a run that fails', async () => {
    const source = await capsaSource(config, { connection: String(connection), migrations: join(folders, 'broken') })

    await expect(source.applyMigrations()).rejects.toThrow()
    await expect(rows(source.getDb(), 'select id from users')).rejects.toThrow()
  })

  it('closes the client with the driver\'s own method when the server stops', async () => {
    const closing: (() => unknown)[] = []
    const source = await capsaSource(config, { connection: String(connection), closing })

    await rows(source.getDb(), 'select 1 as one')
    await Promise.all(closing.map(close => close()))

    expect(closing).toHaveLength(1)
    await expect(rows(source.getDb(), 'select 1 as one')).rejects.toThrow()
  })
})

const PGLITE = { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' } as const
const pgRows = EMBEDDED[0]!.rows

describe('migrating postgres', () => {
  // What keeps two servers from migrating at once: the lock is taken in the transaction drizzle's executor runs in,
  // as a savepoint, and ends with it. A migration sees it held, and nothing is left holding it after.
  it('runs drizzle\'s executor inside the transaction that holds the lock of the source, which ends with it', async () => {
    const folder = join(folders, 'locks')
    const advisory = `select count(*)::int as held from pg_locks where locktype = 'advisory'`

    await writeFiles(folder, { '20260101000000_seen/migration.sql': `CREATE TABLE "seen" AS ${advisory};` })

    const source = await capsaSource(PGLITE, { connection: 'memory://', migrations: folder })

    await source.applyMigrations()

    expect(await pgRows(source.getDb(), 'select held from seen')).toEqual([{ held: 1 }])
    expect(await pgRows(source.getDb(), advisory)).toEqual([{ held: 0 }])
  })

  // The kit hook moves the table drizzle-kit records migrations in: the server reads the same one.
  it('records them in the table the kit hook of config.ts picks, as drizzle\'s migrator does with that table', async () => {
    const source = await capsaSource(PGLITE, {
      connection: 'memory://',
      migrations: join(folders, 'good'),
      config: { kit: () => ({ migrations: { table: 'history' } }) },
    })
    const { drizzle } = await importModule('drizzle-orm/pglite')
    const { migrate } = await importModule('drizzle-orm/pglite/migrator')
    const reference = drizzle({ connection: 'memory://' })
    const applied = 'select hash, created_at, name from drizzle.history order by id'

    await source.applyMigrations()
    await migrate(reference, { migrationsFolder: join(folders, 'good'), migrationsTable: 'history' })

    expect(await pgRows(source.getDb(), applied)).toEqual(await pgRows(reference, applied))
    await expect(pgRows(source.getDb(), 'select 1 from drizzle.__drizzle_migrations')).rejects.toThrow()
  })

  // drizzle's withReplicas: reads go to `$replica`, which is one of `$replicas`; the primary stays the instance.
  it('reads db.$replica from the replica, and migrates only the primary', async () => {
    const source = await capsaSource(PGLITE, { connection: 'memory://', replicas: ['memory://'], migrations: join(folders, 'good') })
    const db = source.getDb() as PgliteDatabase & { $replica: PgliteDatabase, $replicas: PgliteDatabase[] }

    await db.$replicas[0]!.execute(sql.raw('create table users (id integer primary key, name text not null)'))
    await db.$replicas[0]!.execute(sql.raw(`insert into users (id, name) values (7, 'only on the replica')`))
    await source.applyMigrations()

    expect(db.$replicas).toHaveLength(1)
    expect(await pgRows(db.$replica, 'select id, name from users')).toEqual([{ id: 7, name: 'only on the replica' }])
    expect(await pgRows(db, 'select id, name from users')).toEqual([{ id: 1, name: 'ada' }])
    await expect(pgRows(db.$replica, 'select 1 from drizzle.__drizzle_migrations')).rejects.toThrow()
  })
})
