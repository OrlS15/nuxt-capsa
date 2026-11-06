import type { DrizzleSource } from './config'

/**
 * A source's files, as generated code imports them.
 *
 * @example
 * {
 *   schema: ['#capsa/root/server/capsa/db/default/schema/users'],
 *   relations: ['#capsa/root/server/capsa/db/default/relations'],
 *   config: '#capsa/root/server/capsa/db/default/config',
 *   kitConfig: '/app/server/capsa/db/default/config',
 * }
 */
export interface SourceFiles {
  /** One specifier per table file, project first. */
  readonly schema: string[]
  /** One specifier per `relations.ts`, in the order they are spread: layers first, the project last. */
  readonly relations: string[]
  /** The project's `config.ts`, when it has one. */
  readonly config?: string
  /** The same file as drizzle-kit imports it: by its path, since a CLI knows none of capsa's aliases. */
  readonly kitConfig?: string
}

/**
 * Renders `#capsa/db/<name>/schema`, which re-exports the source's tables from every layer.
 *
 * It stays a re-export and is never built inside the source module, so that a `relations.ts` can
 * import the tables back without importing the module that imports it.
 *
 * @example
 * With a `schema/users.ts` in the project and a `schema/products.ts` in a layer:
 * ```js
 * export * from '#capsa/root/server/capsa/db/default/schema/users'
 * export * from '#capsa/root/layers/base/server/capsa/db/default/schema/products'
 * ```
 */
export function renderSchemaModule(files: SourceFiles) {
  return files.schema.map(file => `export * from '${file}'`).join('\n') || 'export {}\n'
}

/**
 * Renders `#capsa/db/<name>`: the tables, the relations, and the source `defineSource` builds from the project's own
 * drizzle. The module only imports and hands over: what a source does lives in `runtime/db/drizzle/source.ts`.
 *
 * `relations` is what parameterises the instance in drizzle 1: `drizzle<TRelations>` is where
 * `db.query` comes from, so an instance built without it knows no tables.
 *
 * The parts are spread with `defineRelationsPart(tables)` first, because it carries an entry for
 * every table and would erase whatever it was spread over, and the project's file last, so the
 * project wins on a table a layer also describes.
 *
 * @example
 * With `default: { driver: 'pglite', migrations: 'manual' }`, a `config.ts`, a `relations.ts` in the project and one in a layer:
 * ```js
 * import { mkdirSync } from 'node:fs'
 * import { defineRelationsPart } from 'drizzle-orm'
 * import { drizzle } from 'drizzle-orm/pglite'
 * import { withReplicas } from 'drizzle-orm/pg-core'
 * import { formatToMillis } from 'drizzle-orm/migrator.utils'
 * import { migrate } from 'drizzle-orm/pg-core/async/session'
 * import { useStorage } from 'nitro/storage'
 * import { defineMigrations } from 'nuxt-capsa/db/drizzle/migrations'
 * import { useNitroHooks } from 'nitro/app'
 * import { useRuntimeConfig } from 'nuxt/server'
 * import { DRIVERS } from 'nuxt-capsa/db/drizzle/drivers'
 * import { defineSource } from 'nuxt-capsa/db/drizzle/source'
 * import * as tables from '#capsa/db/default/schema'
 * import relations_0 from '#capsa/root/layers/base/server/capsa/db/default/relations'
 * import relations_1 from '#capsa/root/server/capsa/db/default/relations'
 * import config from '#capsa/root/server/capsa/db/default/config'
 *
 * export * as schema from '#capsa/db/default/schema'
 *
 * export const relations = { ...defineRelationsPart(tables), ...relations_0, ...relations_1 }
 *
 * const source = defineSource({
 *   name: "default",
 *   env: "NUXT_CAPSA_DB_DEFAULT",
 *   driver: DRIVERS["postgresql"]["pglite"],
 *   drizzle,
 *   withReplicas,
 *   relations,
 *   runtimeConfig: () => useRuntimeConfig().capsa.db["default"],
 *   config,
 *   local: { connection: ".data/capsa/db/default", dir: ".data/capsa/db", mkdirSync },
 *   onClose: close => useNitroHooks().hook('close', close),
 * })
 *
 * export const getDb = source.getDb
 *
 * export const { applyMigrations, ensureMigrations } = defineMigrations(source, {
 *   storage: () => useStorage("assets:capsa-db-default"),
 *   formatToMillis,
 *   executor: migrate,
 *   lock: "select pg_advisory_xact_lock(hashtext('capsa:default'))",
 *   kit: () => config.kit?.({
 *     dialect: "postgresql",
 *     driver: "pglite",
 *     schema: ["/app/server/capsa/db/default/schema.ts","/app/server/capsa/db/default/schema/**\/*.ts"],
 *     out: "/app/server/capsa/db/default/migrations",
 *     dbCredentials: { url: process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? ".data/capsa/db/default" },
 *   }),
 * })
 * ```
 */
export function renderSourceModule(source: DrizzleSource, files: SourceFiles) {
  const { name, options, dialect, driver, local } = source
  const binding = driver.connection === 'binding'
  const migrations = options.migrations ? migrationParts(source, files) : undefined

  const imports = [
    local && `import { mkdirSync } from 'node:fs'`,
    binding && `import { env } from 'cloudflare:workers'`,
    `import { defineRelationsPart } from 'drizzle-orm'`,
    `import { drizzle } from 'drizzle-orm/${options.driver}'`,
    `import { withReplicas } from '${dialect.core}'`,
    ...migrations?.imports ?? [],
    driver.close && `import { useNitroHooks } from 'nitro/app'`,
    `import { useRuntimeConfig } from 'nuxt/server'`,
    `import { DRIVERS } from 'nuxt-capsa/db/drizzle/drivers'`,
    `import { defineSource } from 'nuxt-capsa/db/drizzle/source'`,
    `import * as tables from '${source.schemaModule}'`,
    ...files.relations.map((file, index) => `import relations_${index} from '${file}'`),
    files.config && `import config from '${files.config}'`,
  ]

  const parts = [
    `name: ${JSON.stringify(name)},`,
    `env: ${JSON.stringify(source.env)},`,
    `driver: DRIVERS[${JSON.stringify(options.dialect)}][${JSON.stringify(options.driver)}],`,
    'drizzle,',
    'withReplicas,',
    'relations,',
    `runtimeConfig: () => useRuntimeConfig().capsa.db[${JSON.stringify(name)}],`,
    files.config && 'config,',
    local && `local: { connection: ${JSON.stringify(local.connection)}, dir: ${JSON.stringify(local.dir)}, mkdirSync },`,
    binding && 'bindings: env,',
    driver.close && `onClose: close => useNitroHooks().hook('close', close),`,
  ]

  return sections([
    lines(imports),
    `export * as schema from '${source.schemaModule}'`,
    `export const relations = { ...defineRelationsPart(tables)${files.relations.map((_, index) => `, ...relations_${index}`).join('')} }`,
    `const source = defineSource({\n${lines(parts, '  ')}\n})`,
    'export const getDb = source.getDb',
    migrations && `export const { applyMigrations, ensureMigrations } = defineMigrations(source, {\n${lines(migrations.parts, '  ')}\n})`,
  ])
}

/**
 * What a source that ships its migrations adds to its module: drizzle's own reader of a migration's date and its
 * executor for the dialect and driver, Nitro's storage, the lock of the dialect, and the config drizzle-kit gets, so
 * the `kit` hook names the same migrations table on the server.
 *
 * @example
 * migrationParts(source, files).imports
 * // ["import { formatToMillis } from 'drizzle-orm/migrator.utils'", "import { migrate } from 'drizzle-orm/pg-core/async/session'", …]
 */
function migrationParts(source: DrizzleSource, files: SourceFiles) {
  const { name, dialect, driver: { migrate } } = source
  // A synchronous driver has an executor of its own; the others take the dialect's, when it exports one.
  const executor = migrate && 'sync' in migrate ? 'migrateSync' : dialect.executor
  const over = migrate && 'over' in migrate ? migrate.over : undefined
  const { lock, unlock } = dialect.lock?.(name) ?? {}

  return {
    imports: [
      `import { formatToMillis } from 'drizzle-orm/migrator.utils'`,
      executor && `import { ${executor} } from '${dialect.core}/async/session'`,
      over && `import { drizzle as drizzleOver } from 'drizzle-orm/${over}'`,
      `import { useStorage } from 'nitro/storage'`,
      `import { defineMigrations } from 'nuxt-capsa/db/drizzle/migrations'`,
    ],
    parts: [
      `storage: () => useStorage(${JSON.stringify(`assets:${source.storage}`)}),`,
      'formatToMillis,',
      executor && `executor: ${executor},`,
      lock && `lock: ${JSON.stringify(lock)},`,
      unlock && `unlock: ${JSON.stringify(unlock)},`,
      files.config && `kit: () => config.kit?.(${renderKitObject(source).replaceAll('\n', '\n  ')}),`,
      over && 'drizzle: drizzleOver,',
    ],
  }
}

/**
 * Renders the server plugin of a source that applies its migrations on start: what it does lives in `migrateOnStart`.
 *
 * @example
 * With `default: { migrations: 'onStart' }`:
 * ```js
 * import { definePlugin } from 'nitro'
 * import { migrateOnStart } from 'nuxt-capsa/db/drizzle/migrations'
 * import { ensureMigrations } from '#capsa/db/default'
 *
 * export default definePlugin((nitro) => {
 *   // A prerender runs this server at build time, against the database of the machine that builds.
 *   if (!import.meta.prerender) migrateOnStart(nitro, "default", ensureMigrations)
 * })
 * ```
 */
export function renderMigrationsPlugin(source: DrizzleSource) {
  return `import { definePlugin } from 'nitro'
import { migrateOnStart } from 'nuxt-capsa/db/drizzle/migrations'
import { ensureMigrations } from '${source.moduleId}'

export default definePlugin((nitro) => {
  // A prerender runs this server at build time, against the database of the machine that builds.
  if (!import.meta.prerender) migrateOnStart(nitro, ${JSON.stringify(source.name)}, ensureMigrations)
})
`
}

/**
 * Renders the `drizzle.config.ts` the drizzle-kit CLI reads.
 *
 * The paths are absolute because the file lives in `.nuxt` while the CLI runs from the project
 * root, and a relative one would be read against the wrong directory. The connection comes from the
 * environment and not from runtime config: at CLI time there is no Nitro to read it.
 *
 * @example
 * With `default: { driver: 'pglite' }` and a `config.ts` in the project:
 * ```ts
 * import { mkdirSync } from 'node:fs'
 * import config from '/app/server/capsa/db/default/config'
 *
 * // Like the server: the directory of capsa's own default store, which no driver creates.
 * if ((process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? ".data/capsa/db/default") === ".data/capsa/db/default") mkdirSync(".data/capsa/db", { recursive: true })
 *
 * const capsa = {
 *   dialect: "postgresql",
 *   driver: "pglite",
 *   schema: ["/app/server/capsa/db/default/schema.ts","/app/server/capsa/db/default/schema/**\/*.ts"],
 *   out: "/app/server/capsa/db/default/migrations",
 *   dbCredentials: { url: process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? ".data/capsa/db/default" },
 * }
 *
 * export default config.kit?.(capsa) ?? capsa
 * ```
 */
export function renderKitConfig(source: DrizzleSource, files: SourceFiles) {
  const local = source.local && JSON.stringify(source.local.connection)

  return sections([
    lines([
      local && `import { mkdirSync } from 'node:fs'`,
      files.kitConfig && `import config from '${files.kitConfig}'`,
    ]),
    // The same rule as the server's: only a connection left to capsa's default gets its directory.
    local && lines([
      `// Like the server: the directory of capsa's own default store, which no driver creates.`,
      `if ((process.env.${source.env}_CONNECTION ?? ${local}) === ${local}) mkdirSync(${JSON.stringify(source.local.dir)}, { recursive: true })`,
    ]),
    `const capsa = ${renderKitObject(source)}`,
    `export default ${files.kitConfig ? 'config.kit?.(capsa) ?? capsa' : 'capsa'}`,
  ])
}

/**
 * Renders the config capsa hands to drizzle-kit: what the source's `kit` hook receives, on the CLI
 * and on the server alike.
 *
 * @example
 * renderKitObject(source)
 * // { dialect: "postgresql", schema: [...], out: "...", dbCredentials: { url: process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? "" } }
 */
function renderKitObject({ options, driver, env, local, schemaGlobs, migrationsDir }: DrizzleSource) {
  const variable = `process.env.${env}_CONNECTION`

  return `{
${lines([
  `dialect: ${JSON.stringify(options.dialect)},`,
  driver.kit && `driver: ${JSON.stringify(driver.kit)},`,
  `schema: ${JSON.stringify(schemaGlobs)},`,
  `out: ${JSON.stringify(migrationsDir)},`,
  // drizzle's `connection` object goes to drizzle-kit as it is; a URL or a path goes under `url`.
  `dbCredentials: ${driver.connection === 'json' ? `JSON.parse(${variable} ?? '{}')` : `{ url: ${variable} ?? ${JSON.stringify(local?.connection ?? '')} }`},`,
], '  ')}
}`
}

/**
 * Renders the types of a source's two modules.
 *
 * The schema module is declared as well as generated: at runtime it is a Nitro virtual module, and
 * TypeScript knows nothing about those. Without this block neither `typeof tables` here nor the
 * user's own `import * as schema from '#capsa/db/<name>/schema'` resolves.
 *
 * `relations` is typed the way it is built, one `Omit` per file so the later one wins, exactly like
 * the spread. A single file holding a full `defineRelations` lands on its feet too: it covers every
 * table, so the `Omit` leaves nothing of the base behind.
 *
 * @example
 * With `default: { driver: 'pglite', migrations: 'manual' }`, a `schema/users.ts`, and a `relations.ts` in the project and one in a layer:
 * ```ts
 * declare module '#capsa/db/default/schema' {
 *   export * from '#capsa/root/server/capsa/db/default/schema/users'
 * }
 *
 * declare module '#capsa/db/default' {
 *   import type { defineRelationsPart } from 'drizzle-orm'
 *   import type { drizzle } from 'drizzle-orm/pglite'
 *   import type * as tables from '#capsa/db/default/schema'
 *
 *   type Db = ReturnType<typeof drizzle<typeof relations>>
 *
 *   export * as schema from '#capsa/db/default/schema'
 *   export const relations: Omit<Omit<ReturnType<typeof defineRelationsPart<typeof tables>>, keyof typeof import('#capsa/root/layers/base/server/capsa/db/default/relations')['default']> & typeof import('#capsa/root/layers/base/server/capsa/db/default/relations')['default'], keyof typeof import('#capsa/root/server/capsa/db/default/relations')['default']> & typeof import('#capsa/root/server/capsa/db/default/relations')['default']
 *   export function getDb(): Db & { $replica?: Db, $replicas?: Db[] }
 *   /** Applies the migrations the server shipped with that are not in the database yet: a new run on every call. *\/
 *   export function applyMigrations(): Promise<void>
 *   /** Makes sure they are applied: awaits the run under way or the one that succeeded, and starts one when there is none. *\/
 *   export function ensureMigrations(): Promise<void>
 * }
 * ```
 */
export function renderSourceTypes({ options, moduleId, schemaModule }: DrizzleSource, files: SourceFiles) {
  const tables = files.schema.map(file => `  export * from '${file}'`).join('\n')

  return `declare module '${schemaModule}' {
${tables || '  export {}'}
}

declare module '${moduleId}' {
  import type { defineRelationsPart } from 'drizzle-orm'
  import type { drizzle } from 'drizzle-orm/${options.driver}'
  import type * as tables from '${schemaModule}'

  type Db = ReturnType<typeof drizzle<typeof relations>>

  export * as schema from '${schemaModule}'
  export const relations: ${renderRelationsType(files)}
  export function getDb(): Db & { $replica?: Db, $replicas?: Db[] }
${options.migrations
  ? `  /** Applies the migrations the server shipped with that are not in the database yet: a new run on every call. */
  export function applyMigrations(): Promise<void>
  /** Makes sure they are applied: awaits the run under way or the one that succeeded, and starts one when there is none. */
  export function ensureMigrations(): Promise<void>
`
  : ''}}

`
}

/**
 * Builds the type of `relations`: the base every table is in, then one `Omit` per file.
 *
 * @example
 * // no relations.ts
 * ReturnType<typeof defineRelationsPart<typeof tables>>
 * // one in a layer, one in the project
 * Omit<Omit<Base, keyof Layer> & Layer, keyof Project> & Project
 */
function renderRelationsType(files: SourceFiles) {
  const parts = files.relations.map(file => `typeof import('${file}')['default']`)

  return parts.reduce((all, part) => `Omit<${all}, keyof ${part}> & ${part}`, `ReturnType<typeof defineRelationsPart<typeof tables>>`)
}

/**
 * Renders the augmentation that types this source's `config.ts`.
 *
 * It has to be a file of its own, and a module: a `declare module 'nuxt-capsa'` in a script file is
 * an ambient declaration, which replaces the package instead of extending it, and everything else
 * the package exports disappears.
 *
 * @example
 * With `default: { driver: 'pglite' }`:
 * ```ts
 * export {}
 *
 * declare module 'nuxt-capsa/db' {
 *   interface CapsaDbConfigs {
 *     "default": {
 *       options?: (options: { connection: string, relations: typeof import('#capsa/db/default').relations }) => Partial<Extract<Parameters<typeof import('drizzle-orm/pglite').drizzle>[0], object>>
 *       kit?: (config: import('drizzle-kit').Config) => Partial<import('drizzle-kit').Config>
 *     }
 *   }
 * }
 * ```
 */
export function renderConfigTypes({ name, options, driver, moduleId }: DrizzleSource, hasKit: boolean) {
  const drizzle = `typeof import('drizzle-orm/${options.driver}').drizzle`
  const connection = driver.connection === 'json' ? `Extract<Parameters<${drizzle}>[0], { connection: unknown }>['connection']` : 'string'
  // A binding comes first in drizzle's call: options returns its config plus the binding's name.
  const returns = driver.connection === 'binding'
    ? `Extract<Parameters<${drizzle}>[number], { relations?: unknown }> & { connection: string }`
    : `Extract<Parameters<${drizzle}>[0], object>`

  return `export {}

declare module 'nuxt-capsa/db' {
  interface CapsaDbConfigs {
    ${JSON.stringify(name)}: {
      options?: (options: { connection: ${connection}, relations: typeof import('${moduleId}').relations }) => Partial<${returns}>
${hasKit ? `      kit?: (config: import('drizzle-kit').Config) => Partial<import('drizzle-kit').Config>\n` : ''}    }
  }
}
`
}

/**
 * Joins the lines a block of generated code has: one a source does not need is left out.
 *
 * @example
 * lines(['a', false, 'b'], '  ')  // '  a\n  b'
 */
function lines(all: (string | false | undefined)[], indent = '') {
  return all.filter(line => typeof line === 'string').map(line => indent + line).join('\n')
}

/**
 * Joins the sections of a generated file, a blank line between them: one that is empty is left out.
 *
 * @example
 * sections(['import a', '', false, 'export default a'])  // 'import a\n\nexport default a\n'
 */
function sections(all: (string | false | undefined)[]) {
  return `${all.filter(Boolean).join('\n\n')}\n`
}
