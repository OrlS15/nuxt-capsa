import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveSource, type DrizzleSourceConfig } from '../../src/db/drizzle/config'
import { renderConfigTypes, renderKitConfig, renderSourceTypes } from '../../src/db/drizzle/templates'
import { renderDbTypes } from '../../src/db/templates'
import { runModule } from '../helpers/nuxt'
import { typeErrors, typeMessages } from '../helpers/types'
import { fakeSource } from './source'

/**
 * The types capsa generates, compiled against the real drizzle the way an app compiles them, and what capsa's runtime
 * assumes of drizzle's types: a change on either side shows as an error here.
 */

/** Where a file of the repo is, as a path the compiler resolves. */
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const SOURCES = renderDbTypes([
  { name: 'default', moduleId: '#capsa/db/default' },
  { name: 'analytics', moduleId: '#capsa/db/analytics' },
])

// What an app's tsconfig gives: capsa's runtime, and a table file as `#capsa/root/…` reaches it.
const APP = {
  paths: {
    'nuxt-capsa/db': [at('../../src/runtime/db/index.ts')],
    '#capsa/root/tables': [at('./schema.ts')],
  },
  skipLibCheck: true,
}

// A program per test: a few seconds each against drizzle's own types, past vitest's default of 5 on a busy machine.
describe('types of #capsa/db', { timeout: 30_000 }, () => {
  it('type each source by its own getDb, and refuse a name no source has', async () => {
    const errors = await typeErrors({
      'capsa-db.d.ts': SOURCES,
      // What each provider declares for its source: here, a type of its own per source.
      'sources.d.ts': `declare module '#capsa/db/default' { export function getDb(): { kind: 'pg' } }
declare module '#capsa/db/analytics' { export function getDb(): { kind: 'sqlite' } }`,
      'use.ts': `import { useCapsaDb } from '#capsa/db'
export const byDefault: { kind: 'pg' } = useCapsaDb()
export const byName: { kind: 'sqlite' } = useCapsaDb('analytics')
export const wrongName = useCapsaDb('nope')
export const wrongType: { kind: 'sqlite' } = useCapsaDb()`,
    })

    expect(errors).toEqual(['use.ts:4 TS2345', 'use.ts:5 TS2322'])
  })

  it('name the configured sources when a name is wrong', async () => {
    const messages = await typeMessages({
      'capsa-db.d.ts': SOURCES,
      'sources.d.ts': `declare module '#capsa/db/default' { export function getDb(): object }
declare module '#capsa/db/analytics' { export function getDb(): object }`,
      'configs.d.ts': `export {}
declare module 'nuxt-capsa/db' { interface CapsaDbConfigs { default: { options?: () => object }, analytics: { options?: () => object } } }`,
      'use.ts': `import { useCapsaDb } from '#capsa/db'
import { defineDbConfig } from 'nuxt-capsa/db'
useCapsaDb('analytic')
defineDbConfig('analytic', {})`,
    }, APP)

    expect(messages).toEqual([
      `use.ts:3 Argument of type '"analytic"' is not assignable to parameter of type '"default" | "analytics" | undefined'.`,
      `use.ts:4 Argument of type '"analytic"' is not assignable to parameter of type '"default" | "analytics"'.`,
    ])
  })
})

/** The types of a source's module over the table file, and of its `config.ts`. */
function sourceTypes(name: string, options: DrizzleSourceConfig, hasKit = true) {
  const source = resolveSource(fakeSource(name, options))

  return {
    [`${name}.d.ts`]: renderSourceTypes(source, { schema: ['#capsa/root/tables'], relations: [] }),
    [`${name}-config.d.ts`]: renderConfigTypes(source, hasKit),
  }
}

describe('types of a drizzle source', { timeout: 30_000 }, () => {
  it('type a source\'s tables, and its migrations only when it ships them', async () => {
    const errors = await typeErrors({
      ...sourceTypes('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', migrations: 'manual' }),
      ...sourceTypes('logs', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }),
      'use.ts': `import { applyMigrations, ensureMigrations, schema } from '#capsa/db/default'
import { users } from '#capsa/db/default/schema'
import { applyMigrations as none } from '#capsa/db/logs'
export const table: typeof users = schema.users
export const applied: Promise<void> = applyMigrations()
export const ensured: Promise<void> = ensureMigrations()
export const noTable = schema.nope`,
    }, APP)

    expect(errors).toEqual(['use.ts:3 TS2305', 'use.ts:7 TS2339'])
  })

  it('type db.$replica and db.$replicas as the db with its row types, and as possibly missing', async () => {
    const errors = await typeErrors({
      ...sourceTypes('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }),
      'use.ts': `import { getDb } from '#capsa/db/default'
type Row = { id: number, name: string }
const { $replica, $replicas } = getDb()
export const replica: Promise<Row[]> = $replica!.query.users.findMany()
export const replicas: Promise<Row[]> = $replicas![0]!.query.users.findMany()
export const wrongRow: Promise<{ id: string }[]> = $replica!.query.users.findMany()
export const wrongRows: Promise<{ id: string }[]> = $replicas![0]!.query.users.findMany()
export const maybeReplica = $replica.query
export const maybeReplicas = $replicas.length`,
    }, APP)

    expect(errors).toEqual(['use.ts:6 TS2322', 'use.ts:7 TS2322', 'use.ts:8 TS18048', 'use.ts:9 TS18048'])
  })

  it('type relations the way they are spread: the project over its layers, on a table both describe', async () => {
    const source = resolveSource(fakeSource('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }))
    const errors = await typeErrors({
      'default.d.ts': renderSourceTypes(source, { schema: ['#capsa/root/tables'], relations: ['./layer', './project'] }),
      'layer.ts': `export default { users: { from: 'layer' as const }, posts: { from: 'layer' as const } }`,
      'project.ts': `export default { users: { from: 'project' as const } }`,
      'use.ts': `import { relations } from '#capsa/db/default'
export const project: 'project' = relations.users.from
export const layer: 'layer' = relations.posts.from
export const notLayer: 'layer' = relations.users.from`,
    }, APP)

    expect(errors).toEqual(['use.ts:4 TS2322'])
  })

  it('type the hooks of config.ts by the driver: drizzle\'s options, the kit hook where the CLI is, a connection that is not a URL', async () => {
    const errors = await typeErrors({
      ...sourceTypes('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }),
      ...sourceTypes('nokit', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }, false),
      ...sourceTypes('aws', { provider: 'drizzle', dialect: 'postgresql', driver: 'aws-data-api/pg' }),
      'config.ts': `import { defineDbConfig } from 'nuxt-capsa/db'
defineDbConfig('default', { options: ({ connection, relations }) => ({ logger: true, relations, connection: connection.trim() }), kit: config => ({ out: config.out }) })
defineDbConfig('aws', { options: ({ connection }) => ({ connection: { ...connection, database: connection.database } }) })
defineDbConfig('default', { options: () => ({ logger: 'nope' }) })
defineDbConfig('default', { options: ({ nope }) => ({ logger: nope }) })
defineDbConfig('nokit', { kit: () => ({}) })`,
    }, APP)

    expect(errors).toEqual(['config.ts:4 TS2322', 'config.ts:5 TS2339', 'config.ts:6 TS2353'])
  })

  it('take dataDir on a driver that keeps a store, and refuse it on one that connects out', async () => {
    const errors = await typeErrors({
      'sources.ts': `import type { DrizzleSourceConfig } from '${at('../../src/db/drizzle/config.ts')}'
export const local: DrizzleSourceConfig = { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', dataDir: '.storage' }
export const remote: DrizzleSourceConfig = { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres', dataDir: '.storage' }`,
    }, APP)

    expect(errors).toEqual(['sources.ts:3 TS2353'])
  })
})

/** The types capsa's runtime declares, in a file the compiler reads them from. */
const MIGRATIONS = at('../../src/runtime/db/drizzle/migrations.ts')

// What capsa hands drizzle, typed by capsa, must fit what drizzle declares it takes: a change to drizzle's
// declarations that breaks one of capsa's calls shows here, even where no test runs that call.
describe('drizzle\'s types, against what capsa calls', { timeout: 30_000 }, () => {
  // drizzle's pg, mysql, cockroach and singlestore executors declare a migrationsFolder they never read: capsa passes
  // none, and library.test.ts runs drizzle without one. The rest of each call has to fit.
  it('take capsa\'s migrations and config in every executor capsa imports, and in the migrate of the dialects with none', async () => {
    const errors = await typeErrors({
      'executors.ts': `import type { CockroachDialect } from 'drizzle-orm/cockroach-core'
import type { migrate as mysql } from 'drizzle-orm/mysql-core/async/session'
import type { migrate as pg } from 'drizzle-orm/pg-core/async/session'
import type { SingleStoreDialect } from 'drizzle-orm/singlestore-core'
import type { migrateAsync, migrateSync } from 'drizzle-orm/sqlite-core/async/session'
import type { MigrateOptions, readMigrations } from '${MIGRATIONS}'

declare const migrations: Awaited<ReturnType<typeof readMigrations>>
declare const config: Parameters<MigrateOptions['executor']>[2]

/** What capsa hands an executor: the migrations it read, and the config with no folder. */
type Call<F extends (...args: never) => unknown> = [Parameters<F>[0], Omit<Extract<Parameters<F>[2], object>, 'migrationsFolder'>]

export const pgCall: Call<typeof pg> = [migrations, config]
export const mysqlCall: Call<typeof mysql> = [migrations, config]
export const asyncCall: Call<typeof migrateAsync> = [migrations, config]
export const syncCall: Call<typeof migrateSync> = [migrations, config]
// drizzle keeps \`db.dialect\` out of its public types: capsa reaches it where the dialect exports no executor.
export const cockroachCall: Call<CockroachDialect['migrate']> = [migrations, config]
export const singlestoreCall: Call<SingleStoreDialect['migrate']> = [migrations, config]`,
    }, { skipLibCheck: true, types: ['node'] })

    expect(errors).toEqual([])
  })

  it('build an instance from capsa\'s connection and relations, with a client capsa closes by the driver\'s method', async () => {
    const errors = await typeErrors({
      'drivers.ts': `import { drizzle as nodePostgres } from 'drizzle-orm/node-postgres'
import { drizzle as pglite } from 'drizzle-orm/pglite'
import { drizzle as libsql } from 'drizzle-orm/libsql'
import { drizzle as betterSqlite3 } from 'drizzle-orm/better-sqlite3'
import { drizzle as nodeSqlite } from 'drizzle-orm/node-sqlite'
import { drizzle as mysql2 } from 'drizzle-orm/mysql2'
import { drizzle as d1 } from 'drizzle-orm/d1'
import { withReplicas } from 'drizzle-orm/pg-core'

// A client typed as any, where a driver's package is missing, would let every check below through.
type Known<T> = 0 extends 1 & T ? never : T
const relations = {}

// The call capsa makes for every driver but D1: its options, with the connection inside.
const node = nodePostgres({ connection: 'postgres://db', relations })
export const closes: (() => unknown)[] = [
  (node.$client as Known<typeof node.$client>).end,
  pglite({ connection: 'memory://', relations }).$client.close,
  libsql({ connection: 'file:app.db', relations }).$client.close,
  betterSqlite3({ connection: 'app.db', relations }).$client.close,
  nodeSqlite({ connection: ':memory:', relations }).$client.close,
  mysql2({ connection: 'mysql://db', relations }).$client.end,
]

// D1's binding goes first, the options after.
export const binding = (env: Parameters<typeof d1>[0]) => d1(env, { relations })

// What the types of a source with replicas promise: reads on $replica, every replica in $replicas.
const db = withReplicas(node, [node])
export const replica: typeof node = db.$replica
export const replicas: (typeof node)[] = db.$replicas`,
    }, { skipLibCheck: true, types: ['node'] })

    expect(errors).toEqual([])
  })

  // The generated file is run by drizzle-kit, never type-checked: what has to fit is the object it evaluates to.
  it('take the config drizzle.config.ts evaluates to as a config of drizzle-kit', async () => {
    const config = (options: DrizzleSourceConfig) => JSON.stringify(runModule(
      renderKitConfig(resolveSource(fakeSource('default', options)), { schema: [], relations: [] }),
      { 'node:fs': { mkdirSync: () => {} } },
      '__default',
    ))
    const errors = await typeErrors({
      'check.ts': `import type { Config } from 'drizzle-kit'
export const url: Config = ${config({ provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres' })}
export const pglite: Config = ${config({ provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' })}
export const libsql: Config = ${config({ provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' })}
export const mysql: Config = ${config({ provider: 'drizzle', dialect: 'mysql', driver: 'mysql2' })}
export const wrong: Config = { ...url, dialect: 'postgres' }`,
    }, { skipLibCheck: true })

    // The last one, so a check that lets anything through shows.
    expect(errors).toEqual(['check.ts:6 TS2820'])
  })
})
