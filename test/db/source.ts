import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSource } from '../../src/db/drizzle/config'
import type { DrizzleSourceConfig } from '../../src/db/drizzle/config'
import { renderSourceModule } from '../../src/db/drizzle/templates'
import type { DbSource, DbSourceConfigBase } from '../../src/db/provider'
import { defineDbConfig } from '../../src/runtime/db'
import { DRIVERS } from '../../src/runtime/db/drizzle/drivers'
import { defineMigrations } from '../../src/runtime/db/drizzle/migrations'
import { defineSource } from '../../src/runtime/db/drizzle/source'
import { importModule, runModule } from '../helpers/nuxt'

/**
 * A db source as its provider receives it, for an app at `/app` with no layers.
 *
 * @example
 * fakeSource('logs', { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' }).dirs  // ['/app/server/capsa/db/logs']
 */
export function fakeSource<C extends DbSourceConfigBase>(name: string, options: C): DbSource<C> {
  return { name, options, dirs: [`/app/server/capsa/db/${name}`], moduleId: `#capsa/db/${name}`, templateDir: `capsa/db/${name}/` }
}

/** Serves a migrations folder the way Nitro's storage does in dev: every file, keyed `<folder>:<file>`. */
export function folderStorage(folder: string) {
  return {
    getKeys: async () => (await readdir(folder, { recursive: true })).filter(path => path.includes('/')).map(path => path.replaceAll('/', ':')),
    getItem: (key: string) => readFile(join(folder, key.replaceAll(':', '/')), 'utf8'),
  }
}

/** The project's `config.ts` as the generated module imports it. */
const CONFIG = '#capsa/root/server/capsa/db/default/config'

/** Where a source built by `capsaSource` connects, and what the project and Nitro hand it. */
interface SourceOptions {
  connection: string
  /** What `NUXT_CAPSA_DB_DEFAULT_REPLICAS` holds. */
  replicas?: string[]
  /** The folder its migrations are read from, as Nitro's storage serves them. */
  migrations?: string
  /** The hooks of the project's `config.ts`, as `defineDbConfig` takes them. */
  config?: { options?: (base: { connection: unknown }) => object, kit?: (config: object) => object }
  /** What it registers on Nitro's `close` hook lands here. */
  closing?: (() => unknown)[]
}

/**
 * Runs the module capsa generates for a `default` source on the project's real drizzle, and hands back its exports.
 * Only Nitro and the project's files are stood in for.
 *
 * @example
 * const { getDb, applyMigrations } = await capsaSource({ provider: 'drizzle', dialect: 'sqlite', driver: 'node-sqlite' }, { connection: ':memory:', migrations: '/tmp/migrations' })
 */
export async function capsaSource(config: { provider: 'drizzle', dialect: string, driver: string }, { connection, replicas = [], migrations, config: project, closing = [] }: SourceOptions) {
  const resolved = resolveSource(fakeSource('default', { ...config, migrations: migrations && 'manual' } as DrizzleSourceConfig))
  const { core } = resolved.dialect
  const imports = ['node:fs', 'drizzle-orm', 'drizzle-orm/migrator.utils', `drizzle-orm/${config.driver}`, core, `${core}/async/session`]
  const modules = Object.fromEntries(await Promise.all(imports.map(async id => [id, await importModule(id)])))
  const module = renderSourceModule(resolved, { schema: [], relations: [], config: project && CONFIG })

  return runModule(module, {
    ...modules,
    'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { default: { connection, replicas } } } }) },
    'nitro/storage': { useStorage: () => folderStorage(migrations!) },
    'nitro/app': { useNitroHooks: () => ({ hook: (name: string, run: () => unknown) => name === 'close' && closing.push(run) }) },
    'nuxt-capsa/db/drizzle/drivers': { DRIVERS },
    'nuxt-capsa/db/drizzle/source': { defineSource },
    'nuxt-capsa/db/drizzle/migrations': { defineMigrations },
    '#capsa/db/default/schema': {},
    // `defineDbConfig` takes the name of a source the app's types declare: there are none here.
    ...project && { [CONFIG]: { default: defineDbConfig('default' as never, project as never) } },
  }, migrations ? '{ getDb, applyMigrations }' : '{ getDb }') as { getDb: () => unknown, applyMigrations: () => Promise<void> }
}
