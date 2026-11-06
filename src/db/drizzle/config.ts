import { createResolver } from '@nuxt/kit'
// Nuxt hands every path over with forward slashes, on Windows too: joined the same way, they stay so.
import { join } from 'node:path/posix'
import { snakeCase } from 'scule'
import { DIALECTS, type Dialect } from './dialects'
import { DRIVERS, type Driver, type Store } from '../../runtime/db/drizzle/drivers'
import type { DbSource, DbSourceConfigBase } from '../provider'

/** The files a drizzle source is made of, as the globs that find each kind. A new kind is a line here and nothing else. */
export const FILES = {
  schema: ['schema.ts', 'schema/**/*.ts'],
  relations: ['relations.ts'],
  config: ['config.ts'],
}

type DialectName = keyof typeof DRIVERS
type DriverName<D extends DialectName> = keyof (typeof DRIVERS)[D]

/** Db source config for one dialect and one of its drivers. */
export interface DrizzleSourceConfigFor<D extends DialectName, K extends DriverName<D>> extends DbSourceConfigBase {
  readonly provider: 'drizzle'
  readonly dialect: D
  readonly driver: K
  /**
   * Ships the project's migrations with the server, to apply at runtime with no filesystem.
   *
   * `'manual'` exports `applyMigrations` and `ensureMigrations` from `#capsa/db/<name>`; `'onStart'`
   * also applies them when the server starts, before it answers a request.
   *
   * @default false
   * @example 'onStart'
   */
  readonly migrations?: false | 'manual' | 'onStart'
}

/** The same, for a driver that stores the source: only there is there a directory to choose. */
export interface DrizzleLocalConfigFor<D extends DialectName, K extends DriverName<D>> extends DrizzleSourceConfigFor<D, K> {
  /**
   * Directory the driver keeps this source in.
   *
   * @default '.data/capsa/db'
   */
  readonly dataDir?: string
}

/** Union of one config per dialect and driver, so `dataDir` only exists where there is a store. */
export type DrizzleSourceConfig = {
  [D in DialectName]: {
    [K in DriverName<D>]: (typeof DRIVERS)[D][K] extends { store: Store } ? DrizzleLocalConfigFor<D, K> : DrizzleSourceConfigFor<D, K>
  }[DriverName<D>]
}[DialectName]

/**
 * A drizzle source as the build knows it: what the project wrote, the facts of its dialect and driver, and what capsa
 * works out from them.
 */
export interface DrizzleSource extends DbSource<DrizzleSourceConfig> {
  readonly dialect: Dialect
  readonly driver: Driver
  /** The prefix of its `NUXT_*` variables, spelled the way Nitro reads them. */
  readonly env: string
  /** The server assets its migrations ship in. */
  readonly storage: string
  /** The module its tables are re-exported from. */
  readonly schemaModule: string
  /** Its schema files in every layer, as the globs capsa finds them by: drizzle-kit's config stays the same when one comes or goes. */
  readonly schemaGlobs: string[]
  /** Where its migrations are written and read: in the project, never in a layer. */
  readonly migrationsDir: string
  /** The store capsa picks and the directory to create for it. Absent: the driver connects out. */
  readonly local?: { readonly connection: string, readonly dir: string }
}

/**
 * Looks up a source's dialect and driver, and works out its names, its paths and its local store. `dataRoot` makes
 * the data directory absolute.
 *
 * @example
 * resolveSource({ name: 'analyticsDb', options: { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' },
 *   dirs: ['/app/server/capsa/db/analyticsDb'], moduleId: '#capsa/db/analyticsDb', templateDir: 'capsa/db/analyticsDb/' })
 * // { …, dialect: DIALECTS.sqlite, driver: DRIVERS.sqlite.libsql,
 * //   env: 'NUXT_CAPSA_DB_ANALYTICS_DB', storage: 'capsa-db-analyticsDb', schemaModule: '#capsa/db/analyticsDb/schema',
 * //   schemaGlobs: ['/app/server/capsa/db/analyticsDb/schema.ts', '/app/server/capsa/db/analyticsDb/schema/**\/*.ts'],
 * //   migrationsDir: '/app/server/capsa/db/analyticsDb/migrations',
 * //   local: { connection: 'file:.data/capsa/db/analyticsDb.db', dir: '.data/capsa/db' } }
 */
export function resolveSource(source: DbSource<DrizzleSourceConfig>, dataRoot?: string): DrizzleSource {
  const { name, options, dirs } = source
  const drivers: Record<string, Driver> = DRIVERS[options.dialect]
  const driver = drivers[options.driver] ?? {}

  const resolved = {
    ...source,
    dialect: DIALECTS[options.dialect],
    driver,
    // Nitro's spelling of `capsa.db.<name>`, from the same scule function: `analyticsDb` is `NUXT_CAPSA_DB_ANALYTICS_DB`.
    env: `NUXT_${snakeCase<string>(`capsa_db_${name}`).toUpperCase()}`,
    storage: `capsa-db-${name}`,
    schemaModule: `${source.moduleId}/schema`,
    schemaGlobs: dirs.flatMap(dir => FILES.schema.map(pattern => join(dir, pattern))),
    migrationsDir: join(dirs[0]!, 'migrations'),
  }

  if (!driver.store) return resolved

  // Only the config of a driver with a store carries `dataDir`, and this driver has one.
  const { dataDir = '.data/capsa/db' } = options as { dataDir?: string }
  const dir = dataRoot ? createResolver(dataRoot).resolve(dataDir) : dataDir

  return { ...resolved, local: { connection: driver.store(dir, name), dir } }
}
