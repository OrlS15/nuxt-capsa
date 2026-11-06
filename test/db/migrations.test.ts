import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { formatToMillis } from 'drizzle-orm/migrator.utils'
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { readMigrations, runMigrations } from '../../src/runtime/db/drizzle/migrations'
import { capsaSource, folderStorage, importModule, writeFiles } from './nuxt'

// Two migrations sharing a timestamp and differing in case, a breakpoint, a snapshot, a name with no timestamp.
const FOLDER = fileURLToPath(new URL('../fixtures/migrations', import.meta.url))

describe('drizzle migrations', () => {
  it('reads them from storage exactly as drizzle reads them from disk', async () => {
    expect(await readMigrations(folderStorage(FOLDER), formatToMillis)).toStrictEqual(readMigrationFiles({ migrationsFolder: FOLDER }))
  })
})

const tick = () => new Promise(resolve => setTimeout(resolve))

/**
 * Makes a drizzle instance that logs, in order, what `runMigrations` does with it, and an executor
 * that logs whether it ran on the instance or on its transaction. Both end a tick late, like I/O.
 *
 * @example
 * const { db, log, executor } = fakeDb()
 * await runMigrations(db, [], { executor, lock: 'LOCK' })
 * log  // ['db.transaction', 'tx.execute LOCK', 'executor on tx', 'db.transaction end']
 */
function fakeDb() {
  const log: string[] = []
  const tx = { execute: async (query: string) => void log.push(`tx.execute ${query}`) }
  const db = {
    $client: { end: async () => void log.push('db.end') },
    async transaction(run: (transaction: typeof tx) => Promise<unknown>) {
      log.push('db.transaction')

      try {
        return await run(tx)
      }
      finally {
        await tick()
        log.push('db.transaction end')
      }
    },
    execute: async (query: string) => void log.push(`db.execute ${query}`),
    run: (query: unknown) => ({ run: query }),
    // The queries are logged as JSON when sent: the array could still grow after.
    session: {
      all: async () => void log.push('session.all'),
      transaction: async () => void log.push('session.transaction'),
      migrate: async (queries: unknown[]) => void log.push(`session.migrate ${JSON.stringify(queries)}`),
      batch: async (queries: unknown[]) => void log.push(`session.batch ${JSON.stringify(queries)}`),
    },
  }
  const executor = vi.fn(async (_migrations: unknown, target: unknown, _config: unknown) => {
    await tick()
    log.push(`executor on ${target === db ? 'db' : target === tx ? 'tx' : 'something else'}`)
  })

  return { db: db as never, log, executor, session: db.session }
}

describe('running migrations', () => {
  it('runs the executor on the instance when the dialect has no lock', async () => {
    const { db, log, executor } = fakeDb()

    await runMigrations(db, [], { executor })

    expect(log).toEqual(['executor on db'])
  })

  // Postgres: the lock ends with the transaction, so the executor runs inside it.
  it('holds the lock in a transaction, and runs the executor in it', async () => {
    const { db, log, executor } = fakeDb()

    await runMigrations(db, [], { executor, lock: 'LOCK' })

    expect(log).toEqual(['db.transaction', 'tx.execute LOCK', 'executor on tx', 'db.transaction end'])
  })

  // MySQL, SQL Server: the lock outlives the transaction, which only pins the connection holding it.
  it('runs the executor beside the locked transaction, and releases the lock before it ends', async () => {
    const { db, log, executor } = fakeDb()

    await runMigrations(db, [], { executor, lock: 'LOCK', unlock: 'UNLOCK' })

    expect(log).toEqual(['db.transaction', 'tx.execute LOCK', 'executor on db', 'tx.execute UNLOCK', 'db.transaction end'])
  })

  it('releases the lock and closes the client when the executor fails, and fails too', async () => {
    const { db, log } = fakeDb()
    const executor = async () => {
      throw new Error('boom')
    }

    await expect(runMigrations(db, [], { executor, lock: 'LOCK', unlock: 'UNLOCK', close: true })).rejects.toThrow('boom')

    expect(log).toEqual(['db.transaction', 'tx.execute LOCK', 'tx.execute UNLOCK', 'db.transaction end', 'db.end'])
  })

  it('closes a client opened for the migrations alone, once they are done', async () => {
    const plain = fakeDb()
    const locked = fakeDb()

    await runMigrations(plain.db, [], { executor: plain.executor, close: true })
    await runMigrations(locked.db, [], { executor: locked.executor, lock: 'LOCK', close: true })

    expect(plain.log).toEqual(['executor on db', 'db.end'])
    expect(locked.log).toEqual(['db.transaction', 'tx.execute LOCK', 'executor on tx', 'db.transaction end', 'db.end'])
  })

  // The kit hook may move the table the CLI records migrations in: the server must read the same one.
  it('hands the executor the migrations, and the table the kit hook picks', async () => {
    const { db, executor } = fakeDb()
    const migrations = await readMigrations({ getKeys: async () => ['20260101000000_init:migration.sql'], getItem: async () => 'SELECT 1;' }, formatToMillis)

    await runMigrations(db, migrations, { executor, kit: { migrations: { table: 'history', schema: 'audit' } } })
    await runMigrations(db, migrations, { executor })

    expect(executor.mock.calls.map(([migrations, , config]) => [(migrations as { name: string }[]).map(({ name }) => name), config])).toEqual([
      [['20260101000000_init'], { migrationsTable: 'history', migrationsSchema: 'audit' }],
      [['20260101000000_init'], { migrationsTable: undefined, migrationsSchema: undefined }],
    ])
  })
})

/** Does what drizzle's sqlite executor does: reads what is applied, then runs `queries` in a transaction. */
function sqliteExecutor(queries: string[]) {
  type Session = { all: () => Promise<void>, transaction: (run: (tx: { run: (query: object) => void }) => Promise<void>) => Promise<void> }

  return async (_migrations: unknown, target: unknown) => {
    const { session } = target as { session: Session }

    await session.all()
    await session.transaction(async (tx) => {
      for (const sql of queries) await tx.run({ sql, inlineParams: () => `${sql} inlined` })
    })
  }
}

// D1 rejects BEGIN, and libsql rebuilds a table with foreign keys only through `session.migrate`.
describe('running migrations in one batch', () => {
  it('sends what drizzle runs in its transaction in one session call, and opens no transaction, lock or not', async () => {
    const { db, log } = fakeDb()

    await runMigrations(db, [], { executor: sqliteExecutor(['q1', 'q2']), batch: 'migrate', lock: 'LOCK' })

    expect(log).toEqual(['session.all', 'session.migrate [{"run":{"sql":"q1"}},{"run":{"sql":"q2"}}]'])
  })

  it('writes the values into the SQL for D1\'s session.batch', async () => {
    const { db, log } = fakeDb()

    await runMigrations(db, [], { executor: sqliteExecutor(['q1', 'q2']), batch: 'batch' })

    expect(log).toEqual(['session.all', 'session.batch [{"run":"q1 inlined"},{"run":"q2 inlined"}]'])
  })

  it('sends nothing when there is nothing to apply', async () => {
    const { db, log } = fakeDb()

    await runMigrations(db, [], { executor: sqliteExecutor([]), batch: 'migrate' })

    expect(log).toEqual(['session.all'])
  })

  it('fails when the batch fails', async () => {
    const { db, session } = fakeDb()

    session.migrate = async () => {
      throw new Error('batch failed')
    }

    await expect(runMigrations(db, [], { executor: sqliteExecutor(['q1']), batch: 'migrate' })).rejects.toThrow('batch failed')
  })
})

const INIT = `CREATE TABLE "users" ("id" integer PRIMARY KEY, "name" text NOT NULL);
--> statement-breakpoint
CREATE INDEX "users_name_idx" ON "users" ("name");`

// The embedded drivers this repo can run, with how each reads rows and where drizzle records migrations.
const EMBEDDED = [
  {
    config: { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' },
    connection: 'memory://',
    table: 'drizzle.__drizzle_migrations',
    rows: async (db: unknown, query: string) => (await (db as PgliteDatabase).execute(sql.raw(query))).rows,
  },
  {
    config: { provider: 'drizzle', dialect: 'sqlite', driver: 'node-sqlite' },
    connection: ':memory:',
    table: '__drizzle_migrations',
    rows: async (db: unknown, query: string) => (db as NodeSQLiteDatabase).all(sql.raw(query)),
  },
] as const

// A source migrates through the module capsa generates for it, and a second database through
// drizzle's own migrator for the driver: both have to end up the same.
// Real databases and drizzle's own migrator: a few seconds each on a busy machine, past vitest's default of 5.
describe.each(EMBEDDED)('migrating a real $config.driver', { timeout: 30_000 }, async ({ config, connection, table, rows }) => {
  const folders = await mkdtemp(join(tmpdir(), 'capsa-migrations-'))

  afterAll(() => rm(folders, { recursive: true, force: true }))

  await writeFiles(folders, {
    'good/20260101000000_init/migration.sql': INIT,
    'good/20260102000000_seed/migration.sql': `INSERT INTO "users" ("id", "name") VALUES (1, 'ada');`,
    'broken/20260101000000_init/migration.sql': INIT,
    'broken/20260102000000_broken/migration.sql': 'THIS IS NOT SQL',
  })

  it('records the same rows as drizzle\'s own migrator', async () => {
    const source = await capsaSource(config, connection, join(folders, 'good'))
    const { drizzle } = await importModule(`drizzle-orm/${config.driver}`)
    const { migrate } = await importModule(`drizzle-orm/${config.driver}/migrator`)
    const reference = drizzle({ connection })
    const applied = `select hash, created_at, name from ${table} order by id`

    await source.applyMigrations()
    await migrate(reference, { migrationsFolder: join(folders, 'good') })

    expect(await rows(source.getDb(), applied)).toEqual(await rows(reference, applied))
    expect(await rows(source.getDb(), applied)).toMatchObject([{ name: '20260101000000_init' }, { name: '20260102000000_seed' }])
    expect(await rows(source.getDb(), 'select id, name from users')).toEqual([{ id: 1, name: 'ada' }])
  })

  it('closes the client it built when the server stops', async () => {
    const closing: (() => unknown)[] = []
    const source = await capsaSource(config, connection, join(folders, 'good'), closing)

    await rows(source.getDb(), 'select 1 as one')
    await Promise.all(closing.map(close => close()))

    expect(closing).toHaveLength(1)
    await expect(rows(source.getDb(), 'select 1 as one')).rejects.toThrow()
  })

  it('applies nothing of a run that fails', async () => {
    const source = await capsaSource(config, connection, join(folders, 'broken'))

    await expect(source.applyMigrations()).rejects.toThrow()
    await expect(rows(source.getDb(), 'select id from users')).rejects.toThrow()
  })
})
