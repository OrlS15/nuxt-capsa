import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWithNuxtContext } from '@nuxt/kit'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import capsa from '../../src/module'
import { resolveSource, type DrizzleSourceConfig } from '../../src/db/drizzle/config'
import { setupDrizzle } from '../../src/db/drizzle/setup'
import { renderConfigTypes, renderKitConfig, renderMigrationsPlugin, renderSchemaModule, renderSourceModule, renderSourceTypes } from '../../src/db/drizzle/templates'
import { createDbSource } from '../../src/db/provider'
import { setupDbFeature, type DbFeatureOptions } from '../../src/db/setup'
import { renderDbModule, renderDbTypes } from '../../src/db/templates'
import { log } from '../../src/utils'
import { fakeNuxt, runModule, writeFiles } from '../helpers/nuxt'
import { fakeSource } from './source'

/**
 * What the db feature generates, and what its setup registers on Nuxt. The generated modules are kept as files in
 * `__snapshots__/`: a change to one shows as a diff to review, and `vitest -u` takes it once it is the intended one.
 */

const FILES = { schema: [], relations: [] }
const CONFIG = '#capsa/root/server/capsa/db/default/config'
const PGLITE = { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' } as const
const LIBSQL = { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' } as const
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
 * An empty project in the repo's `.tmp`, removed after the test: inside the repo, drizzle-kit resolves from it as
 * it does from an app that installs it.
 */
async function project() {
  const tmp = fileURLToPath(new URL('../../.tmp', import.meta.url))

  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'db-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))

  return root
}

/** A project with one layer, `layers/base`. */
const layered = (root: string) => ({ layers: [root, join(root, 'layers/base')] })

/** Sets a drizzle source up over a fake Nuxt. */
function setup(nuxt: ReturnType<typeof fakeNuxt>, config: DrizzleSourceConfig, name = 'default') {
  return runWithNuxtContext(nuxt as never, () => setupDrizzle(nuxt as never, createDbSource(nuxt as never, name, config)))
}

/** Finds a template the setup registered, by its path in the build directory. */
function template(nuxt: ReturnType<typeof fakeNuxt>, filename: string) {
  return nuxt.options.build.templates.find(template => template.filename === filename)
}

describe('the module', () => {
  it('reads its options from the `capsa` key of nuxt.config', async () => {
    const root = await project()
    const nuxt = fakeNuxt(root)

    Object.assign(nuxt.options, { capsa: { db: { default: PGLITE } } })
    await writeFiles(root, { 'server/capsa/db/default/schema.ts': '' })
    await runWithNuxtContext(nuxt as never, () => capsa({}, nuxt as never))

    expect(Object.keys(nuxt.options.nitro.virtual)).toContain('#capsa/db/default')
  })
})

describe('sources', () => {
  /** Runs the db feature's setup over a fake Nuxt, which it hands back to look at what was registered. */
  async function setupDb(options: Record<string, unknown>) {
    const nuxt = fakeNuxt(await project())
    const error = await runWithNuxtContext(nuxt as never, () => setupDbFeature(nuxt as never, options as DbFeatureOptions)).catch((error: Error) => error)

    return { nuxt, error }
  }

  it('take names of letters, numbers and "_", camelCase included', async () => {
    const { nuxt, error } = await setupDb({ default: PGLITE, analyticsDb: PGLITE, logs_2: PGLITE })

    expect(error).toBeUndefined()
    expect(Object.keys(nuxt.options.nitro.virtual)).toEqual(expect.arrayContaining(['#capsa/db', '#capsa/db/default', '#capsa/db/analyticsDb', '#capsa/db/logs_2']))
  })

  it.each(['my-db', 'my db', 'db.2'])('refuse the name "%s"', async (name) => {
    const { error } = await setupDb({ default: PGLITE, [name]: PGLITE })

    expect(error).toEqual(new Error(`[capsa] invalid db source name "${name}": use only letters, numbers and "_".`))
  })

  // `constructor` is a key every object answers to: only a provider of the registry's own counts.
  it.each(['prisma', 'constructor'])('refuse the provider "%s" capsa does not know, and name the ones it has', async (provider) => {
    const { error } = await setupDb({ default: { provider } })

    expect(error).toEqual(new Error(`[capsa] db source "default" names an unknown provider "${provider}". Available: drizzle.`))
  })

  it('stop the build on a wrong source before anything is registered', async () => {
    const { nuxt, error } = await setupDb({ default: PGLITE, logs: { ...PGLITE, dir: '/abs/logs' } })

    expect(error?.message).toContain('`dir` is a path inside the server directory')
    expect(nuxt.options.nitro.virtual).toEqual({})
    expect(nuxt.options.build.templates).toEqual([])
  })

  it('are looked for under their own dir in every layer', async () => {
    const root = await project()
    const { dirs } = createDbSource(fakeNuxt(root, layered(root)) as never, 'default', { ...LIBSQL, dir: 'database/main/' })

    expect(dirs).toEqual([`${root}/server/database/main`, `${root}/layers/base/server/database/main`])
  })

  it('name their variables, assets, schema module and paths after themselves', () => {
    expect(source('logs', PGLITE)).toMatchObject({
      name: 'logs',
      env: 'NUXT_CAPSA_DB_LOGS',
      storage: 'capsa-db-logs',
      schemaModule: '#capsa/db/logs/schema',
      schemaGlobs: ['/app/server/capsa/db/logs/schema.ts', '/app/server/capsa/db/logs/schema/**/*.ts'],
      migrationsDir: '/app/server/capsa/db/logs/migrations',
    })
    expect(source('analyticsDb', PGLITE).env).toBe('NUXT_CAPSA_DB_ANALYTICS_DB')
  })
})

describe('local stores', () => {
  it('give pglite a directory and libsql a prefixed file', () => {
    expect(source('default', PGLITE).local).toEqual({ connection: '.data/capsa/db/default', dir: '.data/capsa/db' })
    expect(source('cache', LIBSQL).local).toEqual({ connection: 'file:.data/capsa/db/cache.db', dir: '.data/capsa/db' })
  })

  it('honour dataDir, and leave a driver that connects out with nothing', () => {
    expect(source('cache', { provider: 'drizzle', dialect: 'sqlite', driver: 'bun-sqlite', dataDir: '.storage' }).local)
      .toEqual({ connection: '.storage/cache.db', dir: '.storage' })

    expect(source('main', NODE_POSTGRES).local).toBeUndefined()
  })

  it('anchor the data directory where they are asked to, as Nitro does with its own in dev', () => {
    expect(source('default', LIBSQL, '/app').local).toEqual({ connection: 'file:/app/.data/capsa/db/default.db', dir: '/app/.data/capsa/db' })
  })
})

// One module per way a driver differs: its connection, its migrations, its lock, closing its client.
const MODULES: [string, DrizzleSourceConfig, config?: boolean][] = [
  ['node-postgres', NODE_POSTGRES],
  ['pglite-migrations-config', { ...PGLITE, migrations: 'manual' }, true],
  ['libsql-migrations', { ...LIBSQL, migrations: 'manual' }],
  ['d1-migrations', { provider: 'drizzle', dialect: 'sqlite', driver: 'd1', migrations: 'manual' }],
  ['better-sqlite3-migrations', { provider: 'drizzle', dialect: 'sqlite', driver: 'better-sqlite3', migrations: 'manual' }],
  ['neon-http-migrations', { provider: 'drizzle', dialect: 'postgresql', driver: 'neon-http', migrations: 'manual' }],
  ['mysql2-migrations', { provider: 'drizzle', dialect: 'mysql', driver: 'mysql2', migrations: 'manual' }],
  ['cockroach-migrations', { provider: 'drizzle', dialect: 'cockroach', driver: 'cockroach', migrations: 'manual' }],
  ['aws-data-api', { provider: 'drizzle', dialect: 'postgresql', driver: 'aws-data-api/pg' }],
]

describe('the module of a source', () => {
  it.each(MODULES)('is generated for %s', async (name, options, config) => {
    const module = renderSourceModule(source('default', options), { ...FILES, config: config ? CONFIG : undefined })

    await expect(module).toMatchFileSnapshot(`__snapshots__/source/${name}.mjs`)
  })

  it('imports cloudflare:workers for a D1 binding only', () => {
    expect(renderSourceModule(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'd1' }), FILES)).toContain(`import { env } from 'cloudflare:workers'`)
    expect(renderSourceModule(source('default', NODE_POSTGRES), FILES)).not.toContain('cloudflare:workers')
  })

  it('closes nothing for a driver that keeps no connection, and imports nothing for it', () => {
    const http = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'neon-http' }), FILES)

    expect(http).not.toContain('useNitroHooks')
    expect(http).not.toContain('onClose')
  })

  it('adds nothing about migrations to a source that does not ship them', () => {
    expect(renderSourceModule(source('default', PGLITE), FILES)).not.toContain('defineMigrations')
  })

  it('imports no executor where the dialect exports none', () => {
    const module = renderSourceModule(source('default', { provider: 'drizzle', dialect: 'cockroach', driver: 'cockroach', migrations: 'manual' }), FILES)

    expect(module).not.toContain('/async/session')
    expect(module).not.toContain('executor:')
  })
})

describe('the other generated modules', () => {
  it('re-export every table file as the schema, or nothing', () => {
    expect(renderSchemaModule({ ...FILES, schema: ['#capsa/root/server/capsa/db/default/schema', '#capsa/root/layers/base/server/capsa/db/default/schema/products'] }))
      .toBe(`export * from '#capsa/root/server/capsa/db/default/schema'\nexport * from '#capsa/root/layers/base/server/capsa/db/default/schema/products'`)
    expect(renderSchemaModule(FILES)).toBe('export {}\n')
  })

  it('give a source that migrates on start a plugin of its own, which a prerender skips', async () => {
    await expect(renderMigrationsPlugin(source('logs', { provider: 'drizzle', dialect: 'sqlite', driver: 'better-sqlite3', migrations: 'onStart' })))
      .toMatchFileSnapshot('__snapshots__/migrations.plugin.mjs')
  })

  it('hand out each source in #capsa/db', async () => {
    const sources = [{ name: 'default', moduleId: '#capsa/db/default' as const }, { name: 'analytics', moduleId: '#capsa/db/analytics' as const }]

    await expect(renderDbModule(sources)).toMatchFileSnapshot('__snapshots__/db.mjs')
    await expect(renderDbTypes(sources)).toMatchFileSnapshot('__snapshots__/db.d.ts')
  })

  it('type a source, its relations and its config.ts', async () => {
    const files = { schema: ['#capsa/root/server/capsa/db/default/schema'], relations: ['#capsa/root/layers/base/relations', '#capsa/root/relations'] }

    await expect(renderSourceTypes(source('default', { ...PGLITE, migrations: 'manual' }), files)).toMatchFileSnapshot('__snapshots__/source.d.ts')
    await expect(renderConfigTypes(source('default', PGLITE), true)).toMatchFileSnapshot('__snapshots__/config/pglite.d.ts')
    await expect(renderConfigTypes(source('default', PGLITE), false)).toMatchFileSnapshot('__snapshots__/config/pglite-no-kit.d.ts')
    await expect(renderConfigTypes(source('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'aws-data-api/pg' }), true)).toMatchFileSnapshot('__snapshots__/config/aws-data-api.d.ts')
    await expect(renderConfigTypes(source('default', { provider: 'drizzle', dialect: 'sqlite', driver: 'd1' }), true)).toMatchFileSnapshot('__snapshots__/config/d1.d.ts')
  })
})

describe('drizzle.config.ts', () => {
  it.each([
    ['node-postgres', NODE_POSTGRES, false],
    ['libsql-config', LIBSQL, true],
    ['pglite', PGLITE, false],
    ['aws-data-api', { provider: 'drizzle', dialect: 'postgresql', driver: 'aws-data-api/pg' }, false],
  ] as const)('is generated for %s', async (name, options, config) => {
    const kit = renderKitConfig(source('default', options as DrizzleSourceConfig), { ...FILES, kitConfig: config ? '/app/server/capsa/db/default/config' : undefined })

    await expect(kit).toMatchFileSnapshot(`__snapshots__/kit/${name}.ts`)
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

  it('hands the kit hook capsa\'s config, and takes what it returns', () => {
    const kit = vi.fn((config: object) => ({ ...config, out: '/elsewhere' }))
    const config = runModule(renderKitConfig(source('default', NODE_POSTGRES), { ...FILES, kitConfig: '/app/config' }), { '/app/config': { default: { kit } } }, '__default')

    expect(kit).toHaveBeenCalledWith(expect.objectContaining({ dialect: 'postgresql', out: '/app/server/capsa/db/default/migrations' }))
    expect(config.out).toBe('/elsewhere')
  })
})

describe('a source\'s setup', () => {
  // Measured against drizzle: the base carries an entry for every table, so spread last it erases every relation,
  // and a later part replaces a table's whole set rather than merging into it.
  it('spreads the relations of the base first and the project\'s last', async () => {
    const root = await project()
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

  it('takes the project\'s config.ts, and warns about a layer\'s', async () => {
    const root = await project()
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

  it('re-exports every table file at #capsa/db/<name>/schema, the project\'s first', async () => {
    const root = await project()
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
    const root = await project()

    await setup(fakeNuxt(root), LIBSQL)

    expect(vi.mocked(log.warn).mock.calls).toEqual([[`no schema files for db source "default" in \`${root}/server/capsa/db/default\`.`]])
  })

  it('stops the server build when two schema files export one name, and hands every other warning on', async () => {
    const nuxt = fakeNuxt(await project())
    const nitroOnwarn = vi.fn()
    const config = { onwarn: nitroOnwarn as (warning: object, warn: unknown) => void }

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
    const nuxt = fakeNuxt(await project())
    const config = { onwarn: undefined as ((warning: object, warn: unknown) => void) | undefined }
    const hooksOf = (handlers: Record<string, (...args: never[]) => void>) => ({ hooks: { hook: (name: string, handler: (...args: never[]) => void) => void (handlers[name] = handler) } })
    const server: Record<string, (...args: never[]) => void> = {}
    const prerenderer: Record<string, (...args: never[]) => void> = {}

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
  it('gives every source its connection and replicas, and keeps what the project set', async () => {
    const nuxt = fakeNuxt(await project())

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
    const root = await project()
    const build = fakeNuxt(root)
    const dev = fakeNuxt(root, { dev: true })

    await setup(build, LIBSQL)
    await setup(dev, LIBSQL)

    expect(build.options.runtimeConfig).toEqual({ capsa: { db: { default: { connection: 'file:.data/capsa/db/default.db', replicas: [] } } } })
    expect(dev.options.runtimeConfig).toEqual({ capsa: { db: { default: { connection: `file:${root}/.data/capsa/db/default.db`, replicas: [] } } } })
  })
})

describe('migrations in the project', () => {
  it('ship their SQL with the server, and get the plugin only for \'onStart\'', async () => {
    const root = await project()
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

  it('are the project\'s alone, never a layer\'s', async () => {
    const root = await project()
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

  it('add the server assets of each source after the ones already there', async () => {
    const nuxt = fakeNuxt(await project())

    nuxt.options.nitro.serverAssets = [{ baseName: 'mine', dir: '/mine' }]
    await setup(nuxt, { ...LIBSQL, migrations: 'manual' })
    await setup(nuxt, { ...LIBSQL, migrations: 'manual' }, 'logs')

    expect(nuxt.options.nitro.serverAssets).toMatchObject([{ baseName: 'mine' }, { baseName: 'capsa-db-default' }, { baseName: 'capsa-db-logs' }])
  })

  it('stop the build in drizzle-kit\'s old format, and in a folder Nitro cannot read back', async () => {
    const root = await project()
    const nuxt = fakeNuxt(root)

    await writeFiles(root, { 'server/capsa/db/default/migrations/meta/_journal.json': '{}' })
    await expect(setup(nuxt, { ...LIBSQL, migrations: 'manual' })).rejects.toThrow('holds migrations in the old drizzle-kit format. Run `drizzle-kit up`.')

    await rm(join(root, 'server'), { recursive: true, force: true })
    await writeFiles(root, { 'server/capsa/db/default/migrations/20260101000000_what?/migration.sql': '' })
    await expect(setup(nuxt, { ...LIBSQL, migrations: 'manual' })).rejects.toThrow('rename the migration folder "20260101000000_what?"')
  })

  // A path library reads the "\\" as a separator and would hand back half the name. Windows allows none in a name.
  it.skipIf(process.platform === 'win32')('name the whole folder when its name holds a backslash', async () => {
    const root = await project()

    await writeFiles(root, { 'server/capsa/db/default/migrations/20260101000000_a\\b/migration.sql': '' })
    await expect(setup(fakeNuxt(root), { ...LIBSQL, migrations: 'manual' })).rejects.toThrow('rename the migration folder "20260101000000_a\\b"')
  })
})

describe('drizzle-kit in the project', () => {
  it('gets a drizzle.config.ts on disk, with every layer\'s tables and the project\'s migrations and config.ts', async () => {
    const root = await project()
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

// Everything this source generated has to be written again, not only the types: a CLI reads the file list from disk,
// so a stale one makes `drizzle-kit generate` miss a table added in dev.
describe('a source in dev', () => {
  it('writes the types and the CLI config again when a table appears, and reloads Nitro', async () => {
    const root = await project()
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
    const root = await project()
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
    const root = await project()
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
