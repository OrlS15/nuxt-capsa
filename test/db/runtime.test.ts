import type { defineRelationsPart } from 'drizzle-orm'
import type { drizzle as betterSqlite3 } from 'drizzle-orm/better-sqlite3'
import type { drizzle as cockroach } from 'drizzle-orm/cockroach'
import type { drizzle as d1 } from 'drizzle-orm/d1'
import type { drizzle as libsql } from 'drizzle-orm/libsql'
import type { formatToMillis } from 'drizzle-orm/migrator.utils'
import type { migrate as mysqlMigrate } from 'drizzle-orm/mysql-core/async/session'
import type { drizzle as mysql2 } from 'drizzle-orm/mysql2'
import type { drizzle as neonHttp } from 'drizzle-orm/neon-http'
import type { drizzle as neonServerless } from 'drizzle-orm/neon-serverless'
import type { drizzle as nodeMssql } from 'drizzle-orm/node-mssql'
import type { drizzle as nodePostgres } from 'drizzle-orm/node-postgres'
import type { withReplicas as pgWithReplicas } from 'drizzle-orm/pg-core'
import type { migrate as pgMigrate } from 'drizzle-orm/pg-core/async/session'
import type { drizzle as pglite } from 'drizzle-orm/pglite'
import type { withReplicas as sqliteWithReplicas } from 'drizzle-orm/sqlite-core'
import type { migrateAsync, migrateSync } from 'drizzle-orm/sqlite-core/async/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSource, type DrizzleSourceConfig } from '../../src/db/drizzle/config'
import { renderSourceModule } from '../../src/db/drizzle/templates'
import { renderDbModule } from '../../src/db/templates'
import { defineDbConfig } from '../../src/runtime/db'
import { DRIVERS } from '../../src/runtime/db/drizzle/drivers'
import { defineMigrations, migrateOnStart, readMigrations, runMigrations, type MigrateOptions } from '../../src/runtime/db/drizzle/migrations'
import { defineSource } from '../../src/runtime/db/drizzle/source'
import { runModule } from '../helpers/nuxt'
import { fakeSource } from './source'

/**
 * capsa's own logic at runtime, on stand-ins for drizzle and Nitro: what capsa does with what they hand back. Whether
 * drizzle still behaves the way these stand-ins do is `library.test.ts`'s to check.
 */

/**
 * A stand-in for a function of drizzle, typed by the real one's parameters: when drizzle changes them, the typecheck
 * of this file fails. What it returns is the test's own.
 *
 * @example
 * const migrate = fake<typeof pgMigrate>()
 */
function fake<F extends (...args: never) => unknown>(implementation: (...args: Parameters<F>) => unknown = () => ({})) {
  return vi.fn(implementation)
}

const FILES = { schema: [], relations: [] }
const CONFIG = '#capsa/root/server/capsa/db/default/config'
const NODE_POSTGRES = { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres' } as const

/** A drizzle source of an app at `/app`, as the templates take it. */
function source(name: string, options: DrizzleSourceConfig) {
  return resolveSource(fakeSource(name, options))
}

/** The runtime config of a `default` source, as Nitro serves it. */
function runtimeConfig(connection: unknown, replicas: unknown = [], name = 'default') {
  return { useRuntimeConfig: () => ({ capsa: { db: { [name]: { connection, replicas } } } }) }
}

/**
 * Runs a source's generated module on capsa's own runtime, with a stand-in for everything else it imports, `stubs`
 * over the defaults. Hands back `returns`, evaluated inside it.
 *
 * @example
 * runSource(module, { 'drizzle-orm/node-postgres': { drizzle } }, 'getDb')()
 */
function runSource(module: string, stubs: Record<string, Record<string, unknown>>, returns: string) {
  return runModule(module, {
    'node:fs': { mkdirSync: vi.fn() },
    'drizzle-orm': { defineRelationsPart: fake<typeof defineRelationsPart>() },
    'drizzle-orm/migrator.utils': { formatToMillis: fake<typeof formatToMillis>(() => 0) },
    'drizzle-orm/pg-core': {},
    'drizzle-orm/sqlite-core': {},
    'nuxt/server': runtimeConfig('db://'),
    'nitro/app': { useNitroHooks: () => ({ hook: vi.fn() }) },
    'nitro/storage': { useStorage: () => ({ getKeys: async () => [], getItem: async () => '' }) },
    'nuxt-capsa/db/drizzle/drivers': { DRIVERS },
    'nuxt-capsa/db/drizzle/source': { defineSource },
    'nuxt-capsa/db/drizzle/migrations': { defineMigrations },
    '#capsa/db/default/schema': {},
    ...stubs,
  }, returns)
}

afterEach(() => vi.restoreAllMocks())

describe('useCapsaDb', () => {
  /** Runs the rendered `#capsa/db`, with each source's `getDb` handing back its name. */
  function useCapsaDbFor(names: string[]) {
    const module = renderDbModule(names.map(name => ({ name, moduleId: `#capsa/db/${name}` as const })))
    const modules = Object.fromEntries(names.map(name => [`#capsa/db/${name}`, { getDb: () => `db of ${name}` }]))

    return runModule(module, modules, 'useCapsaDb') as (name?: string) => string
  }

  it('hands out the default with no name, and any source by its name', () => {
    const useCapsaDb = useCapsaDbFor(['default', 'analytics'])

    expect(useCapsaDb()).toBe('db of default')
    expect(useCapsaDb('analytics')).toBe('db of analytics')
  })

  it('refuses a name no source has, and lists the ones there are', () => {
    expect(() => useCapsaDbFor(['default', 'analytics'])('nope')).toThrow('[capsa] unknown db source "nope". Configured: default, analytics.')
  })
})

describe('a source\'s instance', () => {
  it('is built on first use, once, with capsa\'s connection and the relations', () => {
    const drizzle = fake<typeof nodePostgres>()
    const { getDb, relations } = runSource(renderSourceModule(source('default', NODE_POSTGRES), FILES), {
      'drizzle-orm/node-postgres': { drizzle },
      'nuxt/server': runtimeConfig('postgres://db'),
    }, '{ getDb, relations }')

    expect(drizzle).not.toHaveBeenCalled()
    expect(getDb()).toBe(getDb())
    expect(drizzle.mock.calls).toEqual([[{ connection: 'postgres://db', relations }]])
  })

  it('creates the directory of the store only for the connection capsa picked', () => {
    const mkdirSync = vi.fn()
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' }), FILES)
    const open = (connection: string) => runSource(module, {
      'node:fs': { mkdirSync },
      'drizzle-orm/libsql': { drizzle: fake<typeof libsql>() },
      'nuxt/server': runtimeConfig(connection),
    }, 'getDb')()

    open('file:/elsewhere/app.db')
    expect(mkdirSync).not.toHaveBeenCalled()

    open('file:.data/capsa/db/default.db')
    expect(mkdirSync).toHaveBeenCalledExactlyOnceWith('.data/capsa/db', { recursive: true })
  })

  it('names the variables the way Nitro reads them', () => {
    const module = renderSourceModule(source('analyticsDb', NODE_POSTGRES), FILES)
    const getDb = (connection: string, replicas: unknown) => runSource(module, {
      'drizzle-orm/node-postgres': { drizzle: fake<typeof nodePostgres>() },
      'nuxt/server': runtimeConfig(connection, replicas, 'analyticsDb'),
      '#capsa/db/analyticsDb/schema': {},
    }, 'getDb')

    expect(getDb('', [])).toThrow('Set NUXT_CAPSA_DB_ANALYTICS_DB_CONNECTION, or')
    expect(getDb('postgres://db', 'postgres://replica')).toThrow('Set NUXT_CAPSA_DB_ANALYTICS_DB_REPLICAS.')
  })

  it('asks for a connection when the driver cannot store the source', () => {
    const getDb = runSource(renderSourceModule(source('default', NODE_POSTGRES), FILES), {
      'drizzle-orm/node-postgres': { drizzle: fake<typeof nodePostgres>() },
      'nuxt/server': runtimeConfig(''),
    }, 'getDb')

    expect(getDb).toThrow('[capsa] db source "default" has no connection. Set NUXT_CAPSA_DB_DEFAULT_CONNECTION, or return a `client` from `options` in its config.ts.')
  })

  it('hands drizzle a D1 binding first, found by the name in the connection, for the primary and each replica', () => {
    const drizzle = fake<typeof d1>(() => ({}))
    const withReplicas = fake<typeof sqliteWithReplicas>()

    runSource(renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'd1' }), FILES), {
      'cloudflare:workers': { env: { DB: 'the DB binding', DB_REPLICA: 'the replica binding' } },
      'drizzle-orm/d1': { drizzle },
      'drizzle-orm/sqlite-core': { withReplicas },
      'nuxt/server': runtimeConfig('DB', ['DB_REPLICA']),
    }, 'getDb')()

    const [primary, replica] = drizzle.mock.results.map(result => result.value)

    expect(drizzle.mock.calls).toEqual([['the DB binding', { connection: 'DB', relations: {} }], ['the replica binding', { connection: 'DB', relations: {} }]])
    expect(withReplicas).toHaveBeenCalledExactlyOnceWith(primary, [replica])
  })

  it('is the primary itself when there are no replicas', () => {
    const drizzle = fake<typeof nodePostgres>()
    const withReplicas = fake<typeof pgWithReplicas>()
    const db = runSource(renderSourceModule(source('default', NODE_POSTGRES), FILES), {
      'drizzle-orm/node-postgres': { drizzle },
      'drizzle-orm/pg-core': { withReplicas },
    }, 'getDb')()

    expect(db).toBe(drizzle.mock.results[0]!.value)
    expect(withReplicas).not.toHaveBeenCalled()
  })
})

// Nitro hands an environment variable over as the text it is, and replaces the runtime config value with it.
describe('values from the environment', () => {
  it('reads the replicas from the JSON array NUXT_CAPSA_DB_<NAME>_REPLICAS holds', () => {
    const drizzle = fake<typeof nodePostgres>(() => ({}))
    const withReplicas = fake<typeof pgWithReplicas>()

    runSource(renderSourceModule(source('default', NODE_POSTGRES), FILES), {
      'drizzle-orm/node-postgres': { drizzle },
      'drizzle-orm/pg-core': { withReplicas },
      'nuxt/server': runtimeConfig('postgres://primary', '["postgres://replica-1", "postgres://replica-2"]'),
    }, 'getDb')()

    const [primary, ...replicas] = drizzle.mock.results.map(result => result.value)

    expect(drizzle.mock.calls.map(([options]) => (options as { connection: string }).connection)).toEqual(['postgres://primary', 'postgres://replica-1', 'postgres://replica-2'])
    expect(withReplicas).toHaveBeenCalledExactlyOnceWith(primary, replicas)
  })

  it('refuses replicas that are not a JSON array, as text or not', () => {
    const module = renderSourceModule(source('default', NODE_POSTGRES), FILES)
    const getDb = (replicas: unknown) => runSource(module, {
      'drizzle-orm/node-postgres': { drizzle: fake<typeof nodePostgres>() },
      'nuxt/server': runtimeConfig('postgres://primary', replicas),
    }, 'getDb')

    for (const replicas of ['postgres://replica-1', '{"url":"postgres://replica-1"}', '', { url: 'postgres://replica-1' }])
      expect(getDb(replicas)).toThrow('[capsa] db source "default": replicas must be a JSON array of connection strings. Set NUXT_CAPSA_DB_DEFAULT_REPLICAS.')
  })

  it('reads a connection that is drizzle\'s own object from the JSON its variable holds, and leaves a URL as it is', () => {
    const drizzle = fake<typeof nodePostgres>()
    const open = (driver: 'aws-data-api/pg' | 'node-postgres', connection: string) => runSource(renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver }), FILES), {
      [`drizzle-orm/${driver}`]: { drizzle },
      'nuxt/server': runtimeConfig(connection),
    }, 'getDb')()

    open('aws-data-api/pg', '{"database":"app","resourceArn":"arn:aws:rds:cluster"}')
    // Text that happens to be JSON stays text where the driver takes a URL.
    open('node-postgres', '"postgres://db"')

    expect(drizzle.mock.calls).toEqual([
      [{ connection: { database: 'app', resourceArn: 'arn:aws:rds:cluster' }, relations: {} }],
      [{ connection: '"postgres://db"', relations: {} }],
    ])
  })
})

describe('closing with the server', () => {
  /** Builds a node-postgres source on fake clients, and hands back each client with what Nitro's `close` hook got. */
  function closedSource(options: object = {}, replicas: string[] = []) {
    const closing: (() => unknown)[] = []
    const drizzle = fake<typeof nodePostgres>(() => ({ $client: { end: vi.fn() } }))
    const { getDb } = runSource(renderSourceModule(source('default', NODE_POSTGRES), { ...FILES, config: CONFIG }), {
      'drizzle-orm/node-postgres': { drizzle },
      'drizzle-orm/pg-core': { withReplicas: fake<typeof pgWithReplicas>((primary: unknown) => primary) },
      [CONFIG]: { default: { options: (base: object) => ({ ...base, ...options }) } },
      'nuxt/server': runtimeConfig('postgres://db', replicas),
      'nitro/app': { useNitroHooks: () => ({ hook: (name: string, run: () => unknown) => name === 'close' && closing.push(run) }) },
    }, '{ getDb }')

    getDb()

    return { clients: drizzle.mock.results.map(result => (result.value as { $client: { end: () => void } }).$client), closing }
  }

  it('ends the primary and every replica it built, with the driver\'s own method', async () => {
    const { clients, closing } = closedSource({}, ['postgres://replica-1', 'postgres://replica-2'])

    await Promise.all(closing.map(close => close()))

    expect(clients).toHaveLength(3)
    for (const client of clients) expect(client.end).toHaveBeenCalledOnce()
  })

  it('leaves a client the config built to the config', () => {
    expect(closedSource({ client: { pool: true } }).closing).toEqual([])
  })

  it('refuses replicas next to a client the config built, and says how to choose', () => {
    expect(() => closedSource({ client: { pool: true } }, ['postgres://replica-1'])).toThrow(
      '[capsa] db source "default": replicas can\'t be used with a `client` from config.ts. Remove NUXT_CAPSA_DB_DEFAULT_REPLICAS or the client.',
    )
  })

  it('closes each driver\'s client with the method its package has, and drizzle\'s mssql pool through the AutoPool that wraps it', () => {
    const client = { end: vi.fn(), close: vi.fn(), destroy: vi.fn(), pool: { close: vi.fn() } }

    DRIVERS.postgresql['node-postgres'].close(client)
    DRIVERS.postgresql.pglite.close(client)
    DRIVERS.postgresql['aws-data-api/pg'].close(client)
    DRIVERS.mssql['node-mssql'].close(client)

    for (const method of [client.end, client.close, client.destroy, client.pool.close]) expect(method).toHaveBeenCalledOnce()
  })
})

describe('config hooks', () => {
  it('return only what they change, and capsa fills in the rest', () => {
    const client = new URL('postgres://pool')
    const { options, kit } = defineDbConfig('default' as never, {
      options: () => ({ logger: true, client }),
      kit: () => ({ schema: ['/app/extra.ts'], migrations: { table: 'history' } }),
    } as never) as Record<'options' | 'kit', (base: object) => Record<string, unknown>>

    expect(options({ connection: 'postgres://db', relations: { users: {} } })).toEqual({ logger: true, client, connection: 'postgres://db', relations: { users: {} } })
    expect(options({ connection: '' }).client).toBe(client)
    expect(kit({ dialect: 'sqlite', schema: ['/app/schema.ts'] })).toEqual({ dialect: 'sqlite', schema: ['/app/extra.ts', '/app/schema.ts'], migrations: { table: 'history' } })
  })

  it('receive capsa\'s value, win over it, and merge into its nested objects', () => {
    const { options, kit } = defineDbConfig('default' as never, {
      options: ({ connection }: { connection: string }) => ({ connection: `${connection}?ssl=true`, logger: undefined }),
      kit: () => ({ dialect: 'postgresql', migrations: { table: 'history' } }),
    } as never) as Record<'options' | 'kit', (base: object) => Record<string, unknown>>

    expect(options({ connection: 'postgres://db', logger: true })).toEqual({ connection: 'postgres://db?ssl=true', logger: true })
    expect(kit({ dialect: 'sqlite', migrations: { schema: 'drizzle' } })).toEqual({ dialect: 'postgresql', migrations: { table: 'history', schema: 'drizzle' } })
  })

  /** Builds a node-postgres source whose config.ts exports `config`, and hands back what drizzle got. */
  function drizzleOptions(config: object) {
    const drizzle = fake<typeof nodePostgres>()
    const { getDb, relations } = runSource(renderSourceModule(source('default', NODE_POSTGRES), { ...FILES, config: CONFIG }), {
      'drizzle-orm/node-postgres': { drizzle },
      'nuxt/server': runtimeConfig('postgres://db'),
      [CONFIG]: { default: config },
    }, '{ getDb, relations }')

    getDb()

    return { options: drizzle.mock.calls[0]![0], relations }
  }

  it('build the instance with what the options hook returns', () => {
    const { options, relations } = drizzleOptions(defineDbConfig('default' as never, { options: () => ({ logger: true }) } as never))

    expect(options).toEqual({ connection: 'postgres://db', relations, logger: true })
  })

  it('leave the instance alone when config.ts has no options hook', () => {
    const { options, relations } = drizzleOptions(defineDbConfig('default' as never, { kit: () => ({}) } as never))

    expect(options).toEqual({ connection: 'postgres://db', relations })
  })
})

/** A drizzle instance whose transaction runs `run` on `tx` right away. */
const transacting = (tx: object) => ({ transaction: (run: (transaction: object) => unknown) => run(tx) })

describe('a source\'s migrations', () => {
  it('run under the lock, in the table the kit hook picks, and a run that fails is forgotten', async () => {
    const migrate = fake<typeof pgMigrate>().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined)
    const tx = { execute: vi.fn() }
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', migrations: 'manual' }), { ...FILES, config: CONFIG })
    const ensureMigrations = runSource(module, {
      'drizzle-orm/pglite': { drizzle: fake<typeof pglite>(() => transacting(tx)) },
      'drizzle-orm/pg-core/async/session': { migrate },
      [CONFIG]: { default: { kit: () => ({ migrations: { table: 'history' } }) } },
    }, 'ensureMigrations')

    await expect(ensureMigrations()).rejects.toThrow('down')
    await ensureMigrations()
    await ensureMigrations()

    expect(tx.execute).toHaveBeenCalledWith(`select pg_advisory_xact_lock(hashtext('capsa:default'))`)
    expect(migrate).toHaveBeenCalledTimes(2)
    expect(migrate).toHaveBeenLastCalledWith([], tx, { migrationsTable: 'history', migrationsSchema: undefined })
  })

  // What keeps two servers from migrating at once: with a timeout of 1, GET_LOCK returns 0 without an error, and an
  // app lock owned by the transaction would let both in.
  it.each([
    ['postgresql', 'pglite', [`select pg_advisory_xact_lock(hashtext('capsa:logs'))`]],
    ['mysql', 'mysql2', [`select get_lock(md5(concat(database(), ':capsa:logs')), -1)`, `select release_lock(md5(concat(database(), ':capsa:logs')))`]],
    ['mssql', 'node-mssql', [
      `exec sp_getapplock @Resource = 'capsa:logs', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = -1`,
      `exec sp_releaseapplock @Resource = 'capsa:logs', @LockOwner = 'Session'`,
    ]],
  ])('of a %s source run under the lock of its name, released when it outlives the transaction', async (dialect, driver, statements) => {
    const tx = { execute: vi.fn() }
    const resolved = source('logs', { provider: 'drizzle', dialect, driver, migrations: 'manual' } as DrizzleSourceConfig)
    const { core } = resolved.dialect
    const drivers = { 'pglite': fake<typeof pglite>, 'mysql2': fake<typeof mysql2>, 'node-mssql': fake<typeof nodeMssql> }
    const executors = { postgresql: fake<typeof pgMigrate>, mysql: fake<typeof mysqlMigrate>, mssql: undefined }

    await runSource(renderSourceModule(resolved, FILES), {
      [`drizzle-orm/${driver}`]: { drizzle: drivers[driver as keyof typeof drivers](() => ({ dialect: { migrate: vi.fn() }, ...transacting(tx) })) },
      [core]: {},
      [`${core}/async/session`]: { migrate: executors[dialect as keyof typeof executors]?.() },
      'nuxt/server': runtimeConfig('db://', [], 'logs'),
      '#capsa/db/logs/schema': {},
    }, 'applyMigrations')()

    expect(tx.execute.mock.calls.flat()).toEqual(statements)
  })

  // drizzle's sqlite executor runs a migration in one transaction of the session: capsa catches what it runs there.
  it('of libsql and D1 go out in one call of the session method their own migrators use', async () => {
    for (const [driver, method, sent] of [['libsql', 'migrate', 'query'], ['d1', 'batch', 'inlined']] as const) {
      const session = { migrate: vi.fn(), batch: vi.fn() }
      const migrate = fake<typeof migrateAsync>(async (_, db) => {
        const { session } = db as unknown as { session: { transaction: (run: (tx: { run: (query: object) => void }) => unknown) => unknown } }
        await session.transaction(tx => tx.run({ inlineParams: () => 'inlined', toString: () => 'query' }))
      })
      const drizzle = driver === 'libsql' ? fake<typeof libsql> : fake<typeof d1>
      const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver, migrations: 'manual' }), FILES)

      await runSource(module, {
        'cloudflare:workers': { env: { DB: {} } },
        [`drizzle-orm/${driver}`]: { drizzle: drizzle(() => ({ session, run: (query: unknown) => String(query) })) },
        'drizzle-orm/sqlite-core/async/session': { migrateAsync: migrate },
        'nuxt/server': runtimeConfig('DB'),
      }, 'applyMigrations')()

      expect(session[method]).toHaveBeenCalledExactlyOnceWith([sent])
    }
  })

  it('of a synchronous driver run with migrateSync, on the session', async () => {
    const migrate = fake<typeof migrateSync>()
    const applyMigrations = runSource(renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'better-sqlite3', migrations: 'manual' }), FILES), {
      'drizzle-orm/better-sqlite3': { drizzle: fake<typeof betterSqlite3>(() => ({ session: 'session' })) },
      'drizzle-orm/sqlite-core/async/session': { migrateSync: migrate },
    }, 'applyMigrations')

    await applyMigrations()

    expect(migrate).toHaveBeenCalledWith([], 'session', {})
  })

  it('of neon-http run over a neon-serverless instance of their own, closed after', async () => {
    const migrate = fake<typeof pgMigrate>()
    const http = fake<typeof neonHttp>()
    const end = vi.fn()
    const tx = { execute: vi.fn() }
    const serverless = fake<typeof neonServerless>(() => ({ $client: { end }, ...transacting(tx) }))
    const applyMigrations = runSource(renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'neon-http', migrations: 'manual' }), FILES), {
      'drizzle-orm/neon-http': { drizzle: http },
      'drizzle-orm/neon-serverless': { drizzle: serverless },
      'drizzle-orm/pg-core/async/session': { migrate },
      'nuxt/server': runtimeConfig('postgres://neon'),
    }, 'applyMigrations')

    await applyMigrations()

    expect(http).not.toHaveBeenCalled()
    expect(serverless).toHaveBeenCalledExactlyOnceWith('postgres://neon')
    expect(migrate).toHaveBeenCalledWith([], tx, {})
    expect(end).toHaveBeenCalledOnce()
  })

  it('run through drizzle\'s own dialect.migrate where the dialect exports no executor', async () => {
    const migrate = vi.fn()

    await runSource(renderSourceModule(source('default', { provider: 'drizzle', dialect: 'cockroach', driver: 'cockroach', migrations: 'manual' }), FILES), {
      'drizzle-orm/cockroach': { drizzle: fake<typeof cockroach>(() => ({ dialect: { migrate }, session: 'session' })) },
      'drizzle-orm/cockroach-core': {},
    }, 'applyMigrations')()

    expect(migrate).toHaveBeenCalledWith([], 'session', {})
  })
})

describe('migrations on start', () => {
  it('apply as the server starts, hold requests until they are, and stop the server naming the source when they fail', async () => {
    // Nitro's hooks as far as the plugin uses them: hook() hands back the function that removes it.
    const requestHooks = new Set<() => unknown>()
    const nitro = { hooks: { hook: (_: 'request', run: () => unknown) => (requestHooks.add(run), () => void requestHooks.delete(run)) } }
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    // On a server the start applies them: the first request finds them done, and takes the hook away.
    const ensureMigrations = vi.fn(async () => {})
    migrateOnStart(nitro, 'logs', ensureMigrations)
    await [...requestHooks][0]!()

    expect(ensureMigrations).toHaveBeenCalledTimes(2)
    expect(requestHooks.size).toBe(0)
    expect(exit).not.toHaveBeenCalled()

    // Where the start cannot run them, the first request does: when that fails too, the server stops.
    const failing = vi.fn().mockRejectedValueOnce(new Error('at start')).mockRejectedValueOnce(new Error('at the request'))
    migrateOnStart(nitro, 'logs', failing)
    await [...requestHooks][0]!()

    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(logged.mock.calls).toEqual([
      ['[capsa] db source "logs": could not apply migrations, stopping the server'],
      ['On start:', new Error('at start')],
      ['At the first request:', new Error('at the request')],
    ])
  })
})

const tick = () => new Promise(resolve => setTimeout(resolve))

/**
 * Makes a drizzle instance that logs, in order, what `runMigrations` does with it, and an executor that logs whether
 * it ran on the instance or on its transaction. Both end a tick late, like I/O.
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
  // capsa's own type of an executor: that drizzle's fit it is `types.test.ts`'s to check.
  const executor = vi.fn<MigrateOptions['executor']>(async (_migrations, target) => {
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
    const migrations = await readMigrations({ getKeys: async () => ['20260101000000_init:migration.sql'], getItem: async () => 'SELECT 1;' }, () => 0)

    await runMigrations(db, migrations, { executor, kit: { migrations: { table: 'history', schema: 'audit' } } })
    await runMigrations(db, migrations, { executor })

    expect(executor.mock.calls.map(([migrations, , config]) => [migrations.map(({ name }) => name), config])).toEqual([
      [['20260101000000_init'], { migrationsTable: 'history', migrationsSchema: 'audit' }],
      [['20260101000000_init'], { migrationsTable: undefined, migrationsSchema: undefined }],
    ])
  })
})

/** Does what drizzle's sqlite executor does: reads what is applied, then runs `queries` in a transaction. */
function sqliteExecutor(queries: string[]): MigrateOptions['executor'] {
  type Session = { all: () => Promise<void>, transaction: (run: (tx: { run: (query: object) => void }) => Promise<void>) => Promise<void> }

  return async (_migrations, target) => {
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
