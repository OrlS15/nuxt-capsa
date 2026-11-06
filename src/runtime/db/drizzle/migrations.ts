/**
 * A source's migrations, read from Nitro's storage and run by drizzle's own executors, so they work
 * where there is no filesystem.
 *
 * `readMigrations` mirrors `readMigrationFiles` of drizzle-orm 1.0.0-rc.5 (`migrator.js`), which only reads from disk.
 * `test/db/migrations.test.ts` fails as soon as drizzle's output drifts.
 */

import type { Source } from './source'

/** A migration as drizzle's executors take it: `MigrationMeta` in `drizzle-orm/migrator`. */
type Migration = Awaited<ReturnType<typeof readMigrations>>[number]

/** `formatToMillis` of `drizzle-orm/migrator.utils`: the 14 digits a migration folder starts with, as UTC millis. */
type FormatToMillis = (date: string) => number

/** The part of a Nitro storage `readMigrations` reads through. */
interface MigrationStorage {
  getKeys: () => Promise<string[]>
  getItem: (key: string) => Promise<unknown>
}

/** What `runMigrations` needs from a drizzle instance; each part only where its options call for it. */
interface Db {
  $client: { end: () => Promise<unknown> }
  session: Record<'batch' | 'migrate', (queries: unknown[]) => Promise<unknown>>
  transaction: <T>(run: (tx: Db) => Promise<T>) => Promise<T>
  execute: (query: string) => Promise<unknown>
  run: (query: unknown) => unknown
}

export interface MigrateOptions {
  /** drizzle's executor for the dialect, called with the instance: e.g. `migrate` from `drizzle-orm/pg-core/async/session`. */
  executor: (migrations: Migration[], db: unknown, config: { migrationsTable?: string, migrationsSchema?: string }) => unknown
  /** The driver runs no transaction: what drizzle would run in one goes out in a single call of this session method. */
  batch?: keyof Db['session']
  /** The SQL that takes the lock. Absent: no lock. */
  lock?: string
  /** The SQL that releases it, for a lock that outlives the transaction (MySQL, SQL Server). */
  unlock?: string
  /** The instance was opened for the migrations alone: its client is ended after. */
  close?: boolean
  /** What the source's `kit` hook made of drizzle-kit's config: it may move the table migrations are recorded in. */
  kit?: { migrations?: { table?: string, schema?: string } }
}

/**
 * What a source's generated module hands over to apply its migrations: Nitro's storage, drizzle's executor for the
 * dialect, and what the dialect and the project's `config.ts` add.
 */
export interface MigrationParts {
  /** The server assets the migrations ship in. */
  storage: () => MigrationStorage
  formatToMillis: FormatToMillis
  /**
   * The export of drizzle's `<core>/async/session` for the dialect: `migrate`, `migrateAsync`, or `migrateSync` for a
   * synchronous driver. Absent: the dialect has none, and drizzle's own migrators call `db.dialect.migrate`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor?: (migrations: Migration[], target: any, config: object) => unknown
  lock?: string
  unlock?: string
  /** What the project's `kit` hook makes of the config drizzle-kit gets. */
  kit?: () => MigrateOptions['kit']
  /** `drizzle` of the driver the migrations run over, for a driver that has no transactions of its own. */
  drizzle?: (connection: unknown) => unknown
}

/**
 * Makes the two functions that apply a source's migrations, each driver the way drizzle-kit migrates it.
 *
 * @example
 * const { applyMigrations, ensureMigrations } = defineMigrations(source, { storage: () => useStorage('assets:capsa-db-default'), formatToMillis, executor: migrate })
 */
export function defineMigrations(source: Source, { storage, formatToMillis, executor, lock, unlock, kit, drizzle }: MigrationParts) {
  const { migrate } = source.driver
  let started: Promise<unknown> | undefined

  /** Applies the migrations that are not in the database yet: a new run on every call. */
  async function applyMigrations() {
    // A driver with no transactions is migrated over another one, on a connection opened for this run alone.
    const db = drizzle ? drizzle(source.resolveOptions().options.connection) : source.getDb()

    return runMigrations(db as Db, await readMigrations(storage(), formatToMillis), {
      executor: migrate && 'sync' in migrate ? onSession(executor!) : executor ?? dialectMigrate,
      batch: migrate && 'batch' in migrate ? migrate.batch : undefined,
      lock,
      unlock,
      close: Boolean(drizzle),
      kit: kit?.(),
    })
  }

  /** Awaits the run under way or the one that succeeded, and starts one when there is none. */
  function ensureMigrations() {
    // A run that fails is forgotten, so the next call makes a new one.
    return started ??= applyMigrations().catch((error) => {
      started = undefined
      throw error
    })
  }

  return { applyMigrations, ensureMigrations }
}

/**
 * Applies a source's migrations as the server starts, and holds every request until they are.
 *
 * They start as the server starts, so on a server the first request finds them done. A Worker allows no I/O while
 * it starts: there that attempt fails, and the first request runs them.
 *
 * A migration that fails stops the server: one that answered requests would do it against a database in a shape
 * its code does not expect.
 *
 * @example
 * export default definePlugin(nitro => migrateOnStart(nitro, 'default', ensureMigrations))
 */
export function migrateOnStart(nitro: { hooks: { hook: (name: 'request', run: () => unknown) => () => void } }, name: string, ensureMigrations: () => Promise<unknown>) {
  let startError: unknown

  // A Worker's attempt fails here, and the first request makes a new one. Its error is kept: where DDL commits on
  // its own (MySQL), a failed run leaves tables behind, and the next one fails on those.
  const early = ensureMigrations().catch((error) => {
    startError = error
  })
  const unhook = nitro.hooks.hook('request', () => early.then(ensureMigrations).then(unhook, stop))

  function stop(error: unknown) {
    console.error(`[capsa] db source "${name}": could not apply migrations, stopping the server`)
    if (startError) console.error('On start:', startError)
    console.error('At the first request:', error)
    process.exit(1)
  }
}

/** drizzle's executor, as far as capsa calls it, and the instance it runs on. */
type Executor = NonNullable<MigrationParts['executor']>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Target = any

/** A synchronous driver: drizzle's own migrators for it hand `migrateSync` the session, not the instance. */
function onSession(executor: Executor): Executor {
  return (migrations, db: Target, config) => executor(migrations, db.session, config)
}

/** A dialect whose `<core>/async/session` exports no executor: what drizzle's own migrators call instead. */
function dialectMigrate(migrations: Migration[], db: Target, config: object) {
  return db.dialect.migrate(migrations, db.session, config)
}

/**
 * Reads a source's migrations from its server assets, exactly as drizzle reads them from disk.
 *
 * @example
 * await readMigrations(useStorage('assets:capsa-db-default'), formatToMillis)
 * // [{ name: '20260922125737_mysterious_vapor', sql: ['CREATE TABLE …'], bps: true, hash: '6f1c…', folderMillis: 1790081857000 }]
 */
export async function readMigrations(storage: MigrationStorage, formatToMillis: FormatToMillis) {
  // Dev and prerender read the folder through a driver that ignores `pattern`: snapshots show up too.
  const names = (await storage.getKeys())
    .filter(key => key.endsWith(':migration.sql'))
    .map(key => key.slice(0, -':migration.sql'.length))
    .sort((a, b) => a.localeCompare(b))

  return Promise.all(names.map(async (name) => {
    const query = String(await storage.getItem(`${name}:migration.sql`))
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(query))

    return {
      sql: query.split('--> statement-breakpoint'),
      bps: true,
      folderMillis: formatToMillis(name.slice(0, 14)),
      hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      name,
    }
  }))
}

/**
 * Applies a source's migrations with drizzle's own executor, the way drizzle-kit applies them for
 * the driver: in a transaction, holding the lock when the dialect has one, or in one batch.
 *
 * @example
 * await runMigrations(getDb(), migrations, { executor: migrate, lock: "select pg_advisory_xact_lock(hashtext('capsa:default'))" })
 */
export async function runMigrations(db: Db, migrations: Migration[], { executor, batch, lock, unlock, close, kit }: MigrateOptions) {
  // The table the CLI records migrations in: without the `kit` hook's, the default one is empty and everything applies again.
  const { table, schema } = kit?.migrations ?? {}
  const run = (target: Db) => executor(migrations, target, { migrationsTable: table, migrationsSchema: schema })

  try {
    if (batch) return await run(batched(db, batch))

    if (!lock) return await run(db)

    return await db.transaction(async (tx) => {
      await tx.execute(lock)

      // Postgres: the lock ends with `tx`, so the executor runs in it and its own transaction becomes a savepoint.
      // MySQL: DDL commits implicitly and drops savepoints, so the executor runs on `db` and `tx` only pins the locked connection.
      // SQL Server: node-mssql opens no transaction from a transaction's session, so the executor runs on `db` too.
      try {
        return await run(unlock ? db : tx)
      }
      finally {
        if (unlock) await tx.execute(unlock)
      }
    })
  }
  finally {
    if (close) await db.$client.end()
  }
}

/**
 * The same instance, with a transaction that only collects what drizzle runs in it and sends it all
 * in one call of `method`: D1 rejects `BEGIN`, and D1's and libsql's own migrators send a migration
 * that way, `migrate` being libsql's, which turns foreign keys off around it as a table rebuild needs.
 *
 * @example
 * await executor(migrations, batched(db, 'migrate'), config)  // one `db.session.migrate([...])`
 */
function batched(db: Db, method: keyof Db['session']): Db {
  const session = Object.create(db.session, {
    transaction: {
      async value(run: (tx: { run: (query: { inlineParams: () => unknown }) => void }) => Promise<void>) {
        const queries: unknown[] = []

        // D1's migrator writes the values into the SQL, libsql's binds them.
        await run({ run: query => void queries.push(db.run(method === 'batch' ? query.inlineParams() : query)) })

        if (queries.length) await db.session[method](queries)
      },
    },
  })

  return Object.create(db, { session: { value: session } })
}
