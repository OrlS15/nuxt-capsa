import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithNuxtContext } from '@nuxt/kit'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveSource } from '../../src/db/drizzle/config'
import type { DrizzleSourceConfig } from '../../src/db/drizzle/config'
import { setupDrizzle } from '../../src/db/drizzle/setup'
import { renderKitConfig, renderMigrationsPlugin, renderSourceModule } from '../../src/db/drizzle/templates'
import { createDbSource } from '../../src/db/provider'
import { log } from '../../src/utils'
import { defineDbConfig } from '../../src/runtime/db'
import { DRIVERS } from '../../src/runtime/db/drizzle/drivers'
import { defineMigrations, migrateOnStart } from '../../src/runtime/db/drizzle/migrations'
import { defineSource } from '../../src/runtime/db/drizzle/source'
import { fakeNuxt, fakeSource, runModule, writeFiles } from './nuxt'

const FILES = { schema: [], relations: [] }
const NODE_POSTGRES = { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres' } as const

/** A drizzle source of an app at `/app`, as the templates take it. */
function source(name: string, options: DrizzleSourceConfig, dataRoot?: string) {
  return resolveSource(fakeSource(name, options), dataRoot)
}

// What capsa warns about and reports is asserted, not printed.
beforeEach(() => {
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.spyOn(log, 'error').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

/**
 * Runs a source's generated module on capsa's own runtime, with a stub for everything else it imports, `stubs` over
 * the defaults, and its runtime config holding `connection`. Hands back `returns`, evaluated inside it.
 *
 * @example
 * runSource(module, 'postgres://db', { 'drizzle-orm/node-postgres': { drizzle } }, 'getDb')()
 * // drizzle was called with { connection: 'postgres://db', relations }
 */
function runSource(module: string, connection: string, stubs: Record<string, Record<string, unknown>>, returns: string) {
  return runModule(module, {
    'node:fs': { mkdirSync: vi.fn() },
    'drizzle-orm': { defineRelationsPart: () => ({}) },
    'drizzle-orm/migrator.utils': { formatToMillis: () => 0 },
    'drizzle-orm/pg-core': {},
    'drizzle-orm/sqlite-core': {},
    'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { default: { connection, replicas: [] } } } }) },
    'nitro/app': { useNitroHooks: () => ({ hook: vi.fn() }) },
    'nitro/storage': { useStorage: () => ({ getKeys: async () => [], getItem: async () => '' }) },
    'nuxt-capsa/db/drizzle/drivers': { DRIVERS },
    'nuxt-capsa/db/drizzle/source': { defineSource },
    'nuxt-capsa/db/drizzle/migrations': { defineMigrations },
    '#capsa/db/default/schema': {},
    ...stubs,
  }, returns)
}

describe('a source', () => {
  it('names a source\'s variables, assets, schema module and paths after it', () => {
    expect(source('logs', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' })).toMatchObject({
      name: 'logs',
      env: 'NUXT_CAPSA_DB_LOGS',
      storage: 'capsa-db-logs',
      schemaModule: '#capsa/db/logs/schema',
      schemaGlobs: ['/app/server/capsa/db/logs/schema.ts', '/app/server/capsa/db/logs/schema/**/*.ts'],
      migrationsDir: '/app/server/capsa/db/logs/migrations',
    })
  })
})

describe('local stores', () => {
  it('gives pglite a directory and libsql a prefixed file', () => {
    expect(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }).local)
      .toEqual({ connection: '.data/capsa/db/default', dir: '.data/capsa/db' })

    expect(source('cache', { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' }).local)
      .toEqual({ connection: 'file:.data/capsa/db/cache.db', dir: '.data/capsa/db' })
  })

  it('honours dataDir, and leaves a driver that connects out with nothing', () => {
    expect(source('cache', { provider: 'drizzle', dialect: 'sqlite', driver: 'bun-sqlite', dataDir: '.storage' }).local)
      .toEqual({ connection: '.storage/cache.db', dir: '.storage' })

    expect(source('main', { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres' }).local).toBeUndefined()
  })

  it('anchors the data directory where it is asked to, as Nitro does with its own in dev', () => {
    expect(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' }, '/app').local)
      .toEqual({ connection: 'file:/app/.data/capsa/db/default.db', dir: '/app/.data/capsa/db' })
  })

  it('creates the directory only for the connection capsa picked', () => {
    const mkdirSync = vi.fn()
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' }), FILES)
    const open = (connection: string) => runSource(module, connection, { 'node:fs': { mkdirSync }, 'drizzle-orm/libsql': { drizzle: () => ({}) } }, 'getDb')()

    open('file:/elsewhere/app.db')
    expect(mkdirSync).not.toHaveBeenCalled()

    open('file:.data/capsa/db/default.db')
    expect(mkdirSync).toHaveBeenCalledExactlyOnceWith('.data/capsa/db', { recursive: true })
  })

  it('names the variables the way Nitro reads them', () => {
    const module = renderSourceModule(source('analyticsDb', { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres' }), FILES)
    const getDb = (config: object) => runSource(module, '', {
      'drizzle-orm/node-postgres': { drizzle: vi.fn() },
      'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { analyticsDb: config } } }) },
      '#capsa/db/analyticsDb/schema': {},
    }, 'getDb')

    expect(getDb({ connection: '', replicas: [] })).toThrow('Set NUXT_CAPSA_DB_ANALYTICS_DB_CONNECTION, or')
    expect(getDb({ connection: 'postgres://db', replicas: 'postgres://replica' })).toThrow('Set NUXT_CAPSA_DB_ANALYTICS_DB_REPLICAS.')
  })

  it('asks for a connection when the driver cannot store the source', () => {
    const remote = renderSourceModule(source('default', NODE_POSTGRES), FILES)

    expect(remote).not.toContain('mkdirSync')
    expect(runSource(remote, '', { 'drizzle-orm/node-postgres': { drizzle: vi.fn() } }, 'getDb'))
      .toThrow('[capsa] db source "default" has no connection. Set NUXT_CAPSA_DB_DEFAULT_CONNECTION, or return a `client` from `options` in its config.ts.')
  })
})

describe('clients', () => {
  it('hands drizzle a D1 binding first, found by the name in the connection', () => {
    const drizzle = vi.fn((binding: string) => ({ on: binding }))
    const withReplicas = vi.fn()
    const d1 = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'd1' }), FILES)

    runSource(d1, 'DB', {
      'cloudflare:workers': { env: { DB: 'the DB binding', DB_REPLICA: 'the replica binding' } },
      'drizzle-orm/d1': { drizzle },
      'drizzle-orm/sqlite-core': { withReplicas },
      'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { default: { connection: 'DB', replicas: ['DB_REPLICA'] } } } }) },
    }, 'getDb')()

    expect(drizzle.mock.calls).toEqual([['the DB binding', { connection: 'DB', relations: {} }], ['the replica binding', { connection: 'DB', relations: {} }]])
    expect(withReplicas).toHaveBeenCalledWith({ on: 'the DB binding' }, [{ on: 'the replica binding' }])
  })

  it('imports cloudflare:workers for a D1 binding only', () => {
    expect(renderSourceModule(source('default', NODE_POSTGRES), FILES)).not.toContain('cloudflare:workers')
  })
})

// Nitro hands an environment variable over as the text it is, and replaces the runtime config value with it.
describe('values from the environment', () => {
  it('reads the replicas from the JSON array NUXT_CAPSA_DB_<NAME>_REPLICAS holds', () => {
    const drizzle = vi.fn(({ connection }: { connection: string }) => ({ on: connection }))
    const withReplicas = vi.fn()
    const module = renderSourceModule(source('default', NODE_POSTGRES), FILES)

    runSource(module, '', {
      'drizzle-orm/node-postgres': { drizzle },
      'drizzle-orm/pg-core': { withReplicas },
      'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { default: { connection: 'postgres://primary', replicas: '["postgres://replica-1", "postgres://replica-2"]' } } } }) },
    }, 'getDb')()

    expect(withReplicas).toHaveBeenCalledWith({ on: 'postgres://primary' }, [{ on: 'postgres://replica-1' }, { on: 'postgres://replica-2' }])
  })

  it('refuses replicas that are not a JSON array, as text or not', () => {
    const module = renderSourceModule(source('default', NODE_POSTGRES), FILES)
    const getDb = (replicas: unknown) => runSource(module, '', {
      'drizzle-orm/node-postgres': { drizzle: vi.fn() },
      'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { default: { connection: 'postgres://primary', replicas } } } }) },
    }, 'getDb')

    for (const replicas of ['postgres://replica-1', '{"url":"postgres://replica-1"}', ''])
      expect(getDb(replicas)).toThrow('[capsa] db source "default": replicas must be a JSON array of connection strings. Set NUXT_CAPSA_DB_DEFAULT_REPLICAS.')
  })

  it('reads a connection that is drizzle\'s own object from the JSON its variable holds, and leaves a URL as it is', () => {
    const drizzle = vi.fn(() => ({ $client: {} }))
    const open = (driver: 'aws-data-api/pg' | 'node-postgres', connection: string) => runSource(renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver }), FILES), connection, { [`drizzle-orm/${driver}`]: { drizzle } }, 'getDb')()

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
    const drizzle = vi.fn(() => ({ $client: { end: vi.fn() } }))
    const module = renderSourceModule(source('default', NODE_POSTGRES), { ...FILES, config: '#capsa/root/server/capsa/db/default/config' })
    const { getDb } = runSource(module, 'postgres://db', {
      'drizzle-orm/node-postgres': { drizzle },
      'drizzle-orm/pg-core': { withReplicas: (primary: object) => primary },
      '#capsa/root/server/capsa/db/default/config': { default: { options: (base: object) => ({ ...base, ...options }) } },
      'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { default: { connection: 'postgres://db', replicas } } } }) },
      'nitro/app': { useNitroHooks: () => ({ hook: (name: string, run: () => unknown) => name === 'close' && closing.push(run) }) },
    }, '{ getDb }')

    getDb()

    return { clients: drizzle.mock.results.map(result => result.value.$client), closing }
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

  it('closes nothing for a driver that keeps no connection, and imports nothing for it', () => {
    const http = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'neon-http' }), FILES)

    expect(http).not.toContain('useNitroHooks')
    expect(http).not.toContain('onClose')
  })

  it('closes drizzle\'s mssql pool through the AutoPool that wraps it', () => {
    const close = vi.fn()

    DRIVERS.mssql['node-mssql'].close({ pool: { close } })

    expect(close).toHaveBeenCalledOnce()
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
    const drizzle = vi.fn()
    const module = renderSourceModule(source('default', NODE_POSTGRES), { ...FILES, config: '#capsa/root/server/capsa/db/default/config' })
    const { getDb, relations } = runSource(module, 'postgres://db', {
      'drizzle-orm/node-postgres': { drizzle },
      '#capsa/root/server/capsa/db/default/config': { default: config },
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

describe('migrations', () => {
  it('adds nothing to a source that does not ship them', () => {
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }), FILES)

    expect(module).not.toContain('defineMigrations')
    expect(module).toContain(`import { useNitroHooks } from 'nitro/app'\nimport { useRuntimeConfig } from 'nuxt/server'`)
  })

  it('runs under the lock, in the table the kit hook picks, and forgets a run that fails', async () => {
    const migrate = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined)
    const tx = { execute: vi.fn() }
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', migrations: 'manual' }), { ...FILES, config: '#capsa/root/server/capsa/db/default/config' })
    const ensureMigrations = runSource(module, 'memory://', {
      'drizzle-orm/pglite': { drizzle: () => ({ transaction: (run: (transaction: object) => unknown) => run(tx) }) },
      'drizzle-orm/pg-core/async/session': { migrate },
      '#capsa/root/server/capsa/db/default/config': { default: { kit: () => ({ migrations: { table: 'history' } }) } },
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
  ])('migrates a %s source under the lock of its name, and releases one that outlives the transaction', async (dialect, driver, statements) => {
    const tx = { execute: vi.fn() }
    const resolved = source('logs', { provider: 'drizzle', dialect, driver, migrations: 'manual' } as DrizzleSourceConfig)
    const { core } = resolved.dialect

    await runSource(renderSourceModule(resolved, FILES), '', {
      [`drizzle-orm/${driver}`]: { drizzle: () => ({ dialect: { migrate: vi.fn() }, transaction: (run: (transaction: object) => unknown) => run(tx) }) },
      [core]: {},
      [`${core}/async/session`]: { migrate: vi.fn() },
      'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { logs: { connection: 'db://', replicas: [] } } } }) },
      '#capsa/db/logs/schema': {},
    }, 'applyMigrations')()

    expect(tx.execute.mock.calls.flat()).toEqual(statements)
  })

  it('sends libsql\'s and D1\'s migrations in one call of the session method their own migrators use', async () => {
    for (const [driver, method, sent] of [['libsql', 'migrate', 'query'], ['d1', 'batch', 'inlined']] as const) {
      const session = { migrate: vi.fn(), batch: vi.fn() }
      // What drizzle's executor does with the instance: one transaction, a query run in it.
      const migrateAsync = (_: unknown, db: { session: { transaction: (run: (tx: { run: (query: object) => void }) => unknown) => unknown } }) =>
        db.session.transaction(tx => tx.run({ inlineParams: () => 'inlined', toString: () => 'query' }))
      const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver, migrations: 'manual' }), FILES)

      await runSource(module, 'DB', {
        'cloudflare:workers': { env: { DB: {} } },
        [`drizzle-orm/${driver}`]: { drizzle: () => ({ session, run: (query: unknown) => String(query) }) },
        'drizzle-orm/sqlite-core/async/session': { migrateAsync },
      }, 'applyMigrations')()

      expect(session[method]).toHaveBeenCalledExactlyOnceWith([sent])
    }
  })

  it('applies a sync driver\'s migrations with migrateSync, on the session', async () => {
    const migrateSync = vi.fn()
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'better-sqlite3', migrations: 'manual' }), FILES)
    const applyMigrations = runSource(module, 'app.db', {
      'drizzle-orm/better-sqlite3': { drizzle: () => ({ session: 'session' }) },
      'drizzle-orm/sqlite-core/async/session': { migrateSync },
    }, 'applyMigrations')

    await applyMigrations()

    expect(migrateSync).toHaveBeenCalledWith([], 'session', {})
  })

  it('migrates neon-http over a neon-serverless instance of its own, closed after', async () => {
    const migrate = vi.fn()
    const http = vi.fn()
    const end = vi.fn()
    const tx = { execute: vi.fn() }
    const serverless = vi.fn(() => ({ $client: { end }, transaction: (run: (transaction: object) => unknown) => run(tx) }))
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'neon-http', migrations: 'manual' }), FILES)
    const applyMigrations = runSource(module, 'postgres://neon', {
      'drizzle-orm/neon-http': { drizzle: http },
      'drizzle-orm/neon-serverless': { drizzle: serverless },
      'drizzle-orm/pg-core/async/session': { migrate },
    }, 'applyMigrations')

    await applyMigrations()

    expect(http).not.toHaveBeenCalled()
    expect(serverless).toHaveBeenCalledExactlyOnceWith('postgres://neon')
    expect(migrate).toHaveBeenCalledWith([], tx, {})
    expect(end).toHaveBeenCalledOnce()
  })

  it('calls drizzle\'s own migrate where the dialect exports no executor', async () => {
    const migrate = vi.fn()
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'cockroach', driver: 'cockroach', migrations: 'manual' }), FILES)

    expect(module).not.toContain('/async/session')
    expect(module).not.toContain('executor:')

    await runSource(module, 'postgres://roach', {
      'drizzle-orm/cockroach': { drizzle: () => ({ dialect: { migrate }, session: 'session' }) },
      'drizzle-orm/cockroach-core': {},
    }, 'applyMigrations')()

    expect(migrate).toHaveBeenCalledWith([], 'session', {})
  })

  it('gives a source that migrates on start a plugin of its own, which a prerender skips', () => {
    const plugin = renderMigrationsPlugin(source('logs', { provider: 'drizzle', dialect: 'sqlite', driver: 'better-sqlite3', migrations: 'onStart' }))

    expect(plugin).toContain(`import { ensureMigrations } from '#capsa/db/logs'`)
    expect(plugin).toContain(`if (!import.meta.prerender) migrateOnStart(nitro, "logs", ensureMigrations)`)
  })

  it('applies them on start, holds requests until they are, and stops the server naming the source when they fail', async () => {
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

const LIBSQL = { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' } as const

/** Sets a drizzle source up over a fake Nuxt. */
function setup(nuxt: ReturnType<typeof fakeNuxt>, config: DrizzleSourceConfig, name = 'default') {
  return runWithNuxtContext(nuxt as never, () => setupDrizzle(nuxt as never, createDbSource(nuxt as never, name, config)))
}

/** A project with one layer, `layers/base`. */
const layered = (root: string) => ({ layers: [root, join(root, 'layers/base')] })

/** Finds a template the setup registered, by its path in the build directory. */
function template(nuxt: ReturnType<typeof fakeNuxt>, filename: string) {
  return nuxt.options.build.templates.find(template => template.filename === filename)
}

// Measured against drizzle: the base carries an entry for every table, so spread last it erases
// every relation, and a later part replaces a table's whole set rather than merging into it.
describe('relations order', () => {
  const root = join(import.meta.dirname, '.tmp-relations')

  afterEach(() => rm(root, { recursive: true, force: true }))

  it('spreads the base first and the project last', async () => {
    const nuxt = fakeNuxt(root, layered(root))

    await writeFiles(root, {
      'server/capsa/db/default/schema.ts': '',
      'server/capsa/db/default/relations.ts': '',
      'layers/base/server/capsa/db/default/relations.ts': '',
    })
    await setup(nuxt, LIBSQL)

    const module = nuxt.options.nitro.virtual['#capsa/db/default']!()

    expect(module).toContain(`import relations_0 from '#capsa/root/layers/base/server/capsa/db/default/relations'`)
    expect(module).toContain(`import relations_1 from '#capsa/root/server/capsa/db/default/relations'`)
    expect(module).toContain(`export const relations = { ...defineRelationsPart(tables), ...relations_0, ...relations_1 }`)
  })
})

describe('source files', () => {
  const root = join(import.meta.dirname, '.tmp-source-files')

  afterEach(() => rm(root, { recursive: true, force: true }))

  it('takes the project\'s config.ts, and warns about a layer\'s', async () => {
    const nuxt = fakeNuxt(root, layered(root))

    await writeFiles(root, {
      'server/capsa/db/default/schema.ts': '',
      'server/capsa/db/default/config.ts': '',
      'layers/base/server/capsa/db/default/config.ts': '',
    })
    await setup(nuxt, LIBSQL)

    expect(nuxt.options.nitro.virtual['#capsa/db/default']!()).toContain(`import config from '#capsa/root/server/capsa/db/default/config'`)
    expect(vi.mocked(log.warn).mock.calls).toEqual([[`\`${root}/layers/base/server/capsa/db/default/config.ts\` is ignored: a db source takes its config from the project, not from a layer.`]])
  })

  it('looks for a source under its own dir in every layer', () => {
    const nuxt = fakeNuxt(root, layered(root))
    const { dirs } = createDbSource(nuxt as never, 'default', { ...LIBSQL, dir: 'database/main/' })

    expect(dirs).toEqual([`${root}/server/database/main`, `${root}/layers/base/server/database/main`])
  })

  it('re-exports every table file at #capsa/db/<name>/schema, the project\'s first', async () => {
    const nuxt = fakeNuxt(root, layered(root))

    await writeFiles(root, {
      'server/capsa/db/default/schema.ts': '',
      'layers/base/server/capsa/db/default/schema/products.ts': '',
    })
    await setup(nuxt, LIBSQL)

    expect(nuxt.options.nitro.virtual['#capsa/db/default/schema']!()).toBe(`export * from '#capsa/root/server/capsa/db/default/schema'
export * from '#capsa/root/layers/base/server/capsa/db/default/schema/products'`)
    expect(nuxt.options.nitro.virtual['#capsa/db/default']!()).toContain(`import * as tables from '#capsa/db/default/schema'`)
    expect(template(nuxt, 'capsa/db/default/types.d.ts')!.getContents({})).toMatch(/^declare module '#capsa\/db\/default\/schema' \{/)
  })

  it('warns when a source has no schema file', async () => {
    const nuxt = fakeNuxt(root)

    await setup(nuxt, LIBSQL)

    expect(vi.mocked(log.warn).mock.calls).toEqual([[`no schema files for db source "default" in \`${root}/server/capsa/db/default\`.`]])
  })

  it('stops the server build when two schema files export one name, and hands every other warning on', async () => {
    const nuxt = fakeNuxt(root)
    const nitroOnwarn = vi.fn()
    const config = { onwarn: nitroOnwarn as (warning: object, warn: unknown) => void }

    await writeFiles(root, { 'server/capsa/db/default/schema.ts': '' })
    await setup(nuxt, LIBSQL)
    // Nitro's hooks as far as capsa uses them: the rollup config it is about to build with.
    await nuxt.callHook('nitro:init', { hooks: { hook: (name: string, handler: (nitro: unknown, rollup: unknown) => void) => name === 'rollup:before' && handler({}, config) } })

    // rolldown's shape: the re-exporting module in `exporter`, the binding only in the message.
    const conflict = {
      code: 'NAMESPACE_CONFLICT',
      exporter: '#capsa/db/default/schema',
      ids: ['/app/a/posts.ts', '/app/b/posts.ts'],
      message: 'Conflicting namespaces: "#capsa/db/default/schema" re-exports "posts" from one of the modules "/app/a/posts.ts" and "/app/b/posts.ts" (will be ignored).',
    }
    const warn = vi.fn()

    expect(() => config.onwarn(conflict, warn)).toThrow('[capsa] db source "default": `posts` is exported by more than one schema file (`/app/a/posts.ts`, `/app/b/posts.ts`). Rename all but one.')

    config.onwarn({ ...conflict, exporter: '/app/server/utils/index.ts' }, warn)
    config.onwarn({ code: 'EVAL', message: '' }, warn)

    expect(nitroOnwarn.mock.calls).toEqual([[{ ...conflict, exporter: '/app/server/utils/index.ts' }, warn], [{ code: 'EVAL', message: '' }, warn]])
  })

  // `nuxt generate` builds no server but the one Nitro prerenders with, which is a Nitro of its own.
  it('stops the build of the server Nitro prerenders with, too', async () => {
    const nuxt = fakeNuxt(root)
    const config = { onwarn: undefined as ((warning: object, warn: unknown) => void) | undefined }
    const hooksOf = (handlers: Record<string, (...args: never[]) => void>) => ({ hooks: { hook: (name: string, handler: (...args: never[]) => void) => void (handlers[name] = handler) } })
    const server: Record<string, (...args: never[]) => void> = {}
    const prerenderer: Record<string, (...args: never[]) => void> = {}

    await writeFiles(root, { 'server/capsa/db/default/schema.ts': '' })
    await setup(nuxt, LIBSQL)
    await nuxt.callHook('nitro:init', hooksOf(server))
    server['prerender:init']!(hooksOf(prerenderer) as never)
    prerenderer['rollup:before']!({} as never, config as never)

    expect(() => config.onwarn!({ code: 'NAMESPACE_CONFLICT', exporter: '#capsa/db/default/schema', ids: ['/app/a.ts', '/app/b.ts'], message: 're-exports "posts"' }, vi.fn()))
      .toThrow('[capsa] db source "default": `posts` is exported by more than one schema file (`/app/a.ts`, `/app/b.ts`). Rename all but one.')
  })
})

// Nitro replaces a runtime config key from `NUXT_*` only when the key exists.
describe('runtime config', () => {
  const root = join(import.meta.dirname, '.tmp-runtime-config')

  it('gives every source its connection and replicas, and keeps what the project set', async () => {
    const nuxt = fakeNuxt(root)

    nuxt.options.runtimeConfig = { capsa: { other: 1, db: { default: { connection: 'libsql://mine' } } } }
    await setup(nuxt, LIBSQL)
    await setup(nuxt, NODE_POSTGRES, 'analytics')

    expect(nuxt.options.runtimeConfig).toEqual({ capsa: {
      other: 1,
      db: { default: { connection: 'libsql://mine', replicas: [] }, analytics: { connection: '', replicas: [] } },
    } })
  })

  // Like Nitro's own `.data`: the built server may be moved, so its store follows where it starts.
  it('points a local store at capsa\'s default, anchored to the project only in dev', async () => {
    const build = fakeNuxt(root)
    const dev = fakeNuxt(root, { dev: true })

    await setup(build, LIBSQL)
    await setup(dev, LIBSQL)

    expect(build.options.runtimeConfig).toEqual({ capsa: { db: { default: { connection: 'file:.data/capsa/db/default.db', replicas: [] } } } })
    expect(dev.options.runtimeConfig).toEqual({ capsa: { db: { default: { connection: `file:${root}/.data/capsa/db/default.db`, replicas: [] } } } })
  })
})

describe('migrations in the project', () => {
  const root = join(import.meta.dirname, '.tmp-migrations')

  afterEach(() => rm(root, { recursive: true, force: true }))

  it('ships their SQL with the server, and adds the plugin only for \'onStart\'', async () => {
    const assets = [{ baseName: 'capsa-db-default', dir: `${root}/server/capsa/db/default/migrations`, pattern: '*/migration.sql' }]

    const manual = fakeNuxt(root)
    await setup(manual, { ...LIBSQL, migrations: 'manual' })

    expect(manual.options.nitro.serverAssets).toEqual(assets)
    expect(manual.options._serverPlugins).toEqual([])

    const onStart = fakeNuxt(root)
    await setup(onStart, { ...LIBSQL, migrations: 'onStart' })

    expect(onStart.options.nitro.serverAssets).toEqual(assets)
    expect(onStart.options._serverPlugins.map(entry => entry.plugin)).toEqual([`${root}/.nuxt/capsa/db/default/migrations.plugin.mjs`])
    expect(onStart.options.nitro.virtual[`${root}/.nuxt/capsa/db/default/migrations.plugin.mjs`]!()).toContain(`import { ensureMigrations } from '#capsa/db/default'`)
  })

  it('ships and writes the project\'s migrations, never a layer\'s', async () => {
    const nuxt = fakeNuxt(root, layered(root))

    await writeFiles(root, {
      'server/capsa/db/default/config.ts': '',
      // In drizzle-kit's old format: read, it would stop the build.
      'layers/base/server/capsa/db/default/migrations/meta/_journal.json': '{}',
    })
    await setup(nuxt, { ...LIBSQL, migrations: 'manual' })

    expect(nuxt.options.nitro.serverAssets).toEqual([{ baseName: 'capsa-db-default', dir: `${root}/server/capsa/db/default/migrations`, pattern: '*/migration.sql' }])
    expect(nuxt.options.nitro.virtual['#capsa/db/default']!()).toContain(`out: "${root}/server/capsa/db/default/migrations",`)
  })

  it('adds the server assets of each source after the ones already there', async () => {
    const nuxt = fakeNuxt(root)

    nuxt.options.nitro.serverAssets = [{ baseName: 'mine', dir: '/mine' }]
    await setup(nuxt, { ...LIBSQL, migrations: 'manual' })
    await setup(nuxt, { ...LIBSQL, migrations: 'manual' }, 'logs')

    expect(nuxt.options.nitro.serverAssets).toMatchObject([{ baseName: 'mine' }, { baseName: 'capsa-db-default' }, { baseName: 'capsa-db-logs' }])
  })

  it('stops on migrations in drizzle-kit\'s old format, and on a folder Nitro cannot read back', async () => {
    const nuxt = fakeNuxt(root)

    await writeFiles(root, { 'server/capsa/db/default/migrations/meta/_journal.json': '{}' })
    await expect(setup(nuxt, { ...LIBSQL, migrations: 'manual' })).rejects.toThrow('holds migrations in the old drizzle-kit format. Run `drizzle-kit up`.')

    await rm(root, { recursive: true, force: true })
    await writeFiles(root, { 'server/capsa/db/default/migrations/20260101000000_what?/migration.sql': '' })
    await expect(setup(nuxt, { ...LIBSQL, migrations: 'manual' })).rejects.toThrow('rename the migration folder "20260101000000_what?"')
  })

  // A path library reads the "\\" as a separator and would hand back half the name. Windows allows none in a name.
  it.skipIf(process.platform === 'win32')('names the whole folder when its name holds a backslash', async () => {
    const nuxt = fakeNuxt(root)

    await writeFiles(root, { 'server/capsa/db/default/migrations/20260101000000_a\\b/migration.sql': '' })
    await expect(setup(nuxt, { ...LIBSQL, migrations: 'manual' })).rejects.toThrow('rename the migration folder "20260101000000_a\\b"')
  })
})

describe('drizzle-kit', () => {
  const root = join(import.meta.dirname, '.tmp-kit')

  afterEach(() => rm(root, { recursive: true, force: true }))

  it('gets capsa\'s own config when the source has no config.ts', () => {
    const config = runModule(renderKitConfig(source('default', NODE_POSTGRES), FILES), {}, '__default')

    expect(config).toMatchObject({
      dialect: 'postgresql',
      schema: ['/app/server/capsa/db/default/schema.ts', '/app/server/capsa/db/default/schema/**/*.ts'],
      out: '/app/server/capsa/db/default/migrations',
    })
  })

  it('stores a source with no connection where the server does, and leaves one its variable names to the project', () => {
    const mkdirSync = vi.fn()
    const credentials = () => runModule(renderKitConfig(source('default', LIBSQL), FILES), { 'node:fs': { mkdirSync } }, '__default').dbCredentials

    onTestFinished(() => void vi.unstubAllEnvs())

    expect(credentials()).toEqual({ url: 'file:.data/capsa/db/default.db' })
    expect(mkdirSync).toHaveBeenCalledExactlyOnceWith('.data/capsa/db', { recursive: true })

    vi.stubEnv('NUXT_CAPSA_DB_DEFAULT_CONNECTION', 'file:/elsewhere/app.db')
    mkdirSync.mockClear()

    expect(credentials()).toEqual({ url: 'file:/elsewhere/app.db' })
    expect(mkdirSync).not.toHaveBeenCalled()
  })

  // drizzle-kit is a devDependency of this repo, so it resolves from any root inside it.
  it('gets a drizzle.config.ts on disk, with every layer\'s tables and the project\'s migrations and config.ts', async () => {
    const nuxt = fakeNuxt(root, layered(root))

    await writeFiles(root, { 'server/capsa/db/default/schema.ts': '', 'server/capsa/db/default/config.ts': '' })
    await setup(nuxt, LIBSQL)

    const kit = template(nuxt, 'capsa/db/default/drizzle.config.ts')!
    const schema = ['server', 'layers/base/server'].flatMap(server => [`${root}/${server}/capsa/db/default/schema.ts`, `${root}/${server}/capsa/db/default/schema/**/*.ts`])

    expect(kit).toMatchObject({ write: true, dst: `${root}/.nuxt/capsa/db/default/drizzle.config.ts` })
    expect(kit.getContents({})).toContain(`import config from '${root}/server/capsa/db/default/config'\n`)
    expect(kit.getContents({})).toContain(`  schema: ${JSON.stringify(schema)},\n  out: "${root}/server/capsa/db/default/migrations",`)
    expect(template(nuxt, 'capsa/db/default/types-config.d.ts')!.getContents({})).toContain(`kit?: (config: import('drizzle-kit').Config) => Partial<import('drizzle-kit').Config>`)
  })

  it('gets no drizzle.config.ts and no kit hook where it is not installed', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'capsa-no-kit-'))
    const nuxt = fakeNuxt(outside)

    onTestFinished(() => rm(outside, { recursive: true, force: true }))
    await setup(nuxt, LIBSQL)

    expect(template(nuxt, 'capsa/db/default/drizzle.config.ts')).toBeUndefined()
    expect(template(nuxt, 'capsa/db/default/types-config.d.ts')!.getContents({})).not.toContain('kit?:')
  })
})

// Everything this source generated has to be written again, not only the types: a CLI reads the
// file list from disk, so a stale one makes `drizzle-kit generate` miss a table added in dev.
describe('watching in dev', () => {
  const root = join(import.meta.dirname, '.tmp-watch')

  afterEach(() => rm(root, { recursive: true, force: true }))

  it('writes the types and the CLI config again when a table appears, and reloads Nitro', async () => {
    const nuxt = fakeNuxt(root, { dev: true })
    const rebuilt: string[] = []
    // `default_x` starts like `default`: its files must be left alone.
    const generated = ['capsa/db/default/types.d.ts', 'capsa/db/default/types-config.d.ts', 'capsa/db/default/drizzle.config.ts', 'capsa/db/default_x/types.d.ts', 'capsa/db/other/types.d.ts', 'capsa/db/other/drizzle.config.ts']

    nuxt.hook('builder:generateApp', ((options: { filter?: (template: { filename: string }) => boolean }) => {
      rebuilt.push(...generated.filter(filename => options.filter?.({ filename })))
    }) as never)

    await writeFiles(root, { 'server/capsa/db/default/schema/users.ts': '' })
    await setup(nuxt, LIBSQL)

    await writeFiles(root, { 'server/capsa/db/default/schema/posts.ts': '' })
    await nuxt.callHook('builder:watch', 'add', join(root, 'server/capsa/db/default/schema/posts.ts'))

    await vi.waitFor(() => expect(rebuilt).toEqual([
      'capsa/db/default/types.d.ts',
      'capsa/db/default/types-config.d.ts',
      'capsa/db/default/drizzle.config.ts',
    ]))
    expect(nuxt.reloads).toBe(1)
  })

  it('reports an error of the refresh instead of crashing the dev server, and recovers on the next change', async () => {
    const nuxt = fakeNuxt(root, { dev: true })

    await writeFiles(root, { 'server/capsa/db/default/schema.ts': '' })
    await setup(nuxt, { ...LIBSQL, migrations: 'manual' })

    await writeFiles(root, { 'server/capsa/db/default/migrations/20260101000000_bad?name/migration.sql': '' })
    await nuxt.callHook('builder:watch', 'add', join(root, 'server/capsa/db/default/migrations/20260101000000_bad?name/migration.sql'))

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('rename the migration folder "20260101000000_bad?name"') })))
    expect(nuxt.reloads).toBe(0)

    await rm(join(root, 'server/capsa/db/default/migrations/20260101000000_bad?name'), { recursive: true })
    await nuxt.callHook('builder:watch', 'unlink', join(root, 'server/capsa/db/default/migrations/20260101000000_bad?name/migration.sql'))

    await vi.waitFor(() => expect(nuxt.reloads).toBe(1))
  })

  it('leaves the source alone for an edit inside a file, and for a source whose name starts the same', async () => {
    const nuxt = fakeNuxt(root, { dev: true })

    await writeFiles(root, { 'server/capsa/db/default/schema.ts': '', 'server/capsa/db/default_x/schema.ts': '' })
    await setup(nuxt, LIBSQL)

    await nuxt.callHook('builder:watch', 'change', join(root, 'server/capsa/db/default/schema.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'server/capsa/db/default_x/schema.ts'))
    // Past the debounce: a refresh would have run by now.
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(nuxt.reloads).toBe(0)
  })
})
