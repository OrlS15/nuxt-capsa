import type { DRIVERS } from '../../runtime/db/drizzle/drivers'
import type { MigrateOptions } from '../../runtime/db/drizzle/migrations'

export interface Dialect {
  /** The `drizzle-orm/<dialect>-core` entry point: `withReplicas` is here, the executor in `<core>/async/session`. */
  readonly core: string
  /** The export of `<core>/async/session` that applies migrations. Absent: drizzle's migrators call `db.dialect.migrate`. */
  readonly executor?: 'migrate' | 'migrateAsync'
  /** The SQL that keeps two servers starting together from migrating at once, keyed by the source's name. Absent: nothing to take. */
  readonly lock?: (name: string) => Pick<MigrateOptions, 'lock' | 'unlock'>
}

/**
 * The facts of each dialect.
 *
 * The locks differ on purpose, and each database turns the source's name into its key. Postgres
 * ties an advisory lock to the transaction and the database, so commit releases it. MySQL keeps it
 * in the session until released, which is what survives its implicit DDL commits, and server-wide,
 * so the name carries the database; hashed, because a lock name may not exceed 64 characters. SQL
 * Server keeps an app lock in the session, per database. Cockroach and SingleStore have none that
 * holds across drizzle's DDL.
 *
 * @example
 * DIALECTS.postgresql.lock('default')  // { lock: "select pg_advisory_xact_lock(hashtext('capsa:default'))" }
 */
export const DIALECTS = {
  postgresql: {
    core: 'drizzle-orm/pg-core',
    executor: 'migrate',
    lock: name => ({ lock: `select pg_advisory_xact_lock(hashtext('capsa:${name}'))` }),
  },
  mysql: {
    core: 'drizzle-orm/mysql-core',
    executor: 'migrate',
    lock: name => ({
      lock: `select get_lock(md5(concat(database(), ':capsa:${name}')), -1)`,
      unlock: `select release_lock(md5(concat(database(), ':capsa:${name}')))`,
    }),
  },
  sqlite: {
    core: 'drizzle-orm/sqlite-core',
    executor: 'migrateAsync',
  },
  cockroach: {
    core: 'drizzle-orm/cockroach-core',
  },
  mssql: {
    core: 'drizzle-orm/mssql-core',
    lock: name => ({
      lock: `exec sp_getapplock @Resource = 'capsa:${name}', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = -1`,
      unlock: `exec sp_releaseapplock @Resource = 'capsa:${name}', @LockOwner = 'Session'`,
    }),
  },
  singlestore: {
    core: 'drizzle-orm/singlestore-core',
  },
} satisfies Record<keyof typeof DRIVERS, Dialect>
