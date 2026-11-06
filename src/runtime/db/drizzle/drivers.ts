/**
 * What sets each drizzle driver apart, as capsa needs to know it: the build reads the facts, the server calls the
 * functions. Nothing here imports a driver, so every source ships with the whole list and only its own client.
 */

/** A driver's client, as far as closing it goes: each one is its package's own type, which capsa never imports. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

/**
 * The connection of a source kept on this machine, for a driver that can store one.
 *
 * @example
 * fileUrl('.data/capsa/db', 'logs')  // 'file:.data/capsa/db/logs.db'
 */
export type Store = (dir: string, name: string) => string

/** How a driver's migrations run, when a plain transaction is not it. */
export type Migrate
  /** Its calls are synchronous: drizzle's `migrateSync`, on the session. */
  = | { readonly sync: true }
  /** It runs no interactive transaction: a migration goes out in one call of this session method. */
    | { readonly batch: 'migrate' | 'batch' }
  /** It has no transactions at all: drizzle-kit migrates it over this driver, on a connection of its own. */
    | { readonly over: 'neon-serverless' }

export interface Driver {
  /** Where it keeps a source no connection is set for. Absent: it connects out, and always needs one. */
  readonly store?: Store
  /** What `connection` holds when it is not a URL: the name of a Cloudflare binding, or drizzle's connection object as JSON. */
  readonly connection?: 'binding' | 'json'
  /** The `driver` drizzle-kit needs to reach this one. Absent: the dialect alone is enough. */
  readonly kit?: 'pglite' | 'sqlite-cloud' | 'd1-http' | 'aws-data-api'
  /** Packages Nitro copies beside the server instead of bundling them: they read files next to their own code. */
  readonly traceDeps?: readonly string[]
  /** Closes the client when the server stops. Absent: the driver keeps no connection open. */
  readonly close?: (client: Client) => unknown
  /** How its migrations run. Absent: in a transaction, the way drizzle-kit runs them. */
  readonly migrate?: Migrate
}

const file: Store = (dir, name) => `${dir}/${name}.db`
const fileUrl: Store = (dir, name) => `file:${dir}/${name}.db`
const directory: Store = (dir, name) => `${dir}/${name}`

const end = (client: Client) => client.end()
const close = (client: Client) => client.close()
const destroy = (client: Client) => client.destroy()
// drizzle wraps the mssql pool in an AutoPool of its own, which has no close.
const closePool = (client: Client) => client.pool.close()

// libsql survives a table rebuild with foreign keys only through its own `session.migrate`.
const libsql = { close, migrate: { batch: 'migrate' } } satisfies Driver
const libsqlFile = { ...libsql, store: fileUrl } satisfies Driver
const turso = { close, store: file } satisfies Driver
const syncFile = { close, store: file, migrate: { sync: true } } satisfies Driver

export const DRIVERS = {
  postgresql: {
    'node-postgres': { close: end },
    'postgres-js': { close: end },
    'neon-http': { migrate: { over: 'neon-serverless' } },
    'neon-serverless': { close: end },
    'netlify-db': {},
    'bun-sql/postgres': { close },
    'pglite': { close, store: directory, kit: 'pglite', traceDeps: ['@electric-sql/pglite'] },
    'aws-data-api/pg': { close: destroy, connection: 'json', kit: 'aws-data-api' },
  },
  mysql: {
    'mysql2': { close: end },
    'planetscale-serverless': {},
    'tidb-serverless': {},
    'bun-sql/mysql': { close },
  },
  sqlite: {
    'libsql': libsqlFile,
    'libsql/node': libsqlFile,
    'libsql/sqlite3': libsqlFile,
    'libsql/wasm': libsqlFile,
    'libsql/web': libsql,
    'libsql/http': libsql,
    'libsql/ws': libsql,
    'tursodatabase/database': turso,
    'tursodatabase/wasm': turso,
    'tursodatabase-serverless': { close },
    'tursodatabase-sync': turso,
    'better-sqlite3': syncFile,
    'node-sqlite': syncFile,
    'bun-sqlite': syncFile,
    // drizzle-kit opens Bun's SQLite only from a `file:` URL.
    'bun-sql/sqlite': { close, store: fileUrl },
    'sqlite-cloud': { close, kit: 'sqlite-cloud' },
    // D1 rejects BEGIN: a migration goes out in one batch, with the values written into the SQL.
    'd1': { connection: 'binding', kit: 'd1-http', migrate: { batch: 'batch' } },
  },
  cockroach: {
    cockroach: { close: end },
  },
  mssql: {
    'node-mssql': { close: closePool },
  },
  singlestore: {
    singlestore: { close: end },
  },
} as const satisfies Record<string, Record<string, Driver>>
