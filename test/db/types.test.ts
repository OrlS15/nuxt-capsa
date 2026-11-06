import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveSource, type DrizzleSourceConfig } from '../../src/db/drizzle/config'
import { renderConfigTypes, renderSourceTypes } from '../../src/db/drizzle/templates'
import { renderDbTypes } from '../../src/db/templates'
import { fakeSource, typeErrors, typeMessages } from './nuxt'

const SOURCES = renderDbTypes([
  { name: 'default', moduleId: '#capsa/db/default' },
  { name: 'analytics', moduleId: '#capsa/db/analytics' },
])

// A program per test: under the e2e suites' load, one can take longer than vitest's 5 s.
describe('types of #capsa/db', { timeout: 30_000 }, () => {
  it('types each source by its own getDb, and refuses a name no source has', async () => {
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

  it('names the configured sources when a name is wrong', async () => {
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
    }, { paths: { 'nuxt-capsa/db': [fileURLToPath(new URL('../../src/runtime/db/index.ts', import.meta.url))] } })

    expect(messages).toEqual([
      `use.ts:3 Argument of type '"analytic"' is not assignable to parameter of type '"default" | "analytics" | undefined'.`,
      `use.ts:4 Argument of type '"analytic"' is not assignable to parameter of type '"default" | "analytics"'.`,
    ])
  })
})

// What an app's tsconfig gives: capsa's runtime, and a table file as `#capsa/root/…` reaches it.
const CONFIG = {
  paths: {
    'nuxt-capsa/db': [fileURLToPath(new URL('../../src/runtime/db/index.ts', import.meta.url))],
    '#capsa/root/tables': [fileURLToPath(new URL('../fixtures/db-pglite/server/capsa/db/default/schema.ts', import.meta.url))],
  },
  skipLibCheck: true,
}

/** The types of a source's module over one table file, and of its `config.ts`. */
function sourceTypes(name: string, options: DrizzleSourceConfig, hasKit = true) {
  const source = resolveSource(fakeSource(name, options))

  return {
    [`${name}.d.ts`]: renderSourceTypes(source, { schema: ['#capsa/root/tables'], relations: [] }),
    [`${name}-config.d.ts`]: renderConfigTypes(source, hasKit),
  }
}

describe('types of a drizzle source', { timeout: 30_000 }, () => {
  it('types a source\'s tables, and its migrations only when it ships them', async () => {
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
    }, CONFIG)

    expect(errors).toEqual(['use.ts:3 TS2305', 'use.ts:7 TS2339'])
  })

  it('types db.$replica and db.$replicas as the db with its row types, and as possibly missing', async () => {
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
    }, CONFIG)

    expect(errors).toEqual(['use.ts:6 TS2322', 'use.ts:7 TS2322', 'use.ts:8 TS18048', 'use.ts:9 TS18048'])
  })

  it('types relations the way they are spread: the project over its layers, on a table both describe', async () => {
    const source = resolveSource(fakeSource('default', { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' }))
    const errors = await typeErrors({
      'default.d.ts': renderSourceTypes(source, { schema: ['#capsa/root/tables'], relations: ['./layer', './project'] }),
      'layer.ts': `export default { users: { from: 'layer' as const }, posts: { from: 'layer' as const } }`,
      'project.ts': `export default { users: { from: 'project' as const } }`,
      'use.ts': `import { relations } from '#capsa/db/default'
export const project: 'project' = relations.users.from
export const layer: 'layer' = relations.posts.from
export const notLayer: 'layer' = relations.users.from`,
    }, CONFIG)

    expect(errors).toEqual(['use.ts:4 TS2322'])
  })

  it('types the hooks of config.ts by the driver: drizzle\'s options, the kit hook where the CLI is, a connection that is not a URL', async () => {
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
    }, CONFIG)

    expect(errors).toEqual(['config.ts:4 TS2322', 'config.ts:5 TS2339', 'config.ts:6 TS2353'])
  })

  it('takes dataDir on a driver that keeps a store, and refuses it on one that connects out', async () => {
    const errors = await typeErrors({
      'sources.ts': `import type { DrizzleSourceConfig } from '${fileURLToPath(new URL('../../src/db/drizzle/config.ts', import.meta.url))}'
export const local: DrizzleSourceConfig = { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', dataDir: '.storage' }
export const remote: DrizzleSourceConfig = { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres', dataDir: '.storage' }`,
    }, CONFIG)

    expect(errors).toEqual(['sources.ts:3 TS2353'])
  })
})
