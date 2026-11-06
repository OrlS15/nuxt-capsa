import { addNitroPlugin, addServerTemplate, directoryToURL, resolveFiles, tryResolveModule } from '@nuxt/kit'
import type { NitroInstance, Nuxt } from '@nuxt/schema'
import { join } from 'node:path/posix'
import { FILES, resolveSource, type DrizzleSource, type DrizzleSourceConfig } from './config'
import { renderConfigTypes, renderKitConfig, renderMigrationsPlugin, renderSchemaModule, renderSourceModule, renderSourceTypes, type SourceFiles } from './templates'
import { addFile, addModule, addSubModule, addTypes, findFiles, onFilesChange, writeRuntimeConfig, type DbSource } from '../provider'
import { log, rootAlias, withoutExtension } from '../../utils'

/**
 * Sets a drizzle source up: its schema module, its own module with `getDb`, its types, its migrations when asked
 * for, and the config drizzle-kit reads.
 */
export async function setupDrizzle(nuxt: Nuxt, base: DbSource<DrizzleSourceConfig>) {
  // Like Nitro's own `.data`: under the project in dev, where the server starts in production.
  const source = resolveSource(base, nuxt.options.dev ? nuxt.options.rootDir : undefined)

  // Kept, not read on every render: the files only change when one comes or goes.
  let files = await readFiles(nuxt, source)

  addSubModule(source, 'schema', () => renderSchemaModule(files))

  failOnSchemaConflicts(nuxt, source)

  // In dev, a file that comes or goes is read again.
  onFilesChange(nuxt, source, async () => {
    files = await readFiles(nuxt, source)
  })

  // The default of a local store lands here, so it is the value the devtools show and the one
  // `NUXT_CAPSA_DB_<NAME>_CONNECTION` replaces, like any other source.
  writeRuntimeConfig(nuxt, source, { connection: source.local?.connection ?? '', replicas: [] })

  // A driver that reads files next to its own code, like pglite's data and wasm, stays on disk beside the server.
  const { nitro } = nuxt.options
  if (source.driver.traceDeps) nitro.traceDeps = [...nitro.traceDeps ?? [], ...source.driver.traceDeps]

  // Only when asked for: the SQL then ships with the server, and `applyMigrations` exists.
  if (source.options.migrations) addMigrations(nuxt, source)

  addModule(source, () => renderSourceModule(source, files))

  addTypes(source, () => renderSourceTypes(source, files))

  // Without the CLI installed there is nothing to configure, and its `Config` type would be a
  // broken reference in the types capsa writes.
  const hasKit = Boolean(await tryResolveModule('drizzle-kit', directoryToURL(nuxt.options.rootDir)))

  addTypes(source, () => renderConfigTypes(source, hasKit), '-config')

  if (hasKit) addFile(source, 'drizzle.config.ts', () => renderKitConfig(source, files))
}

/**
 * Bundles the project's migrations into Nitro's server assets, and adds the plugin that applies
 * them on start when asked to.
 *
 * @example
 * addMigrations(nuxt, source)  // server assets 'capsa-db-default', read as `useStorage('assets:capsa-db-default')`
 */
function addMigrations(nuxt: Nuxt, source: DrizzleSource) {
  const { nitro, buildDir } = nuxt.options

  nitro.serverAssets = [
    ...nitro.serverAssets ?? [],
    { baseName: source.storage, dir: source.migrationsDir, pattern: '*/migration.sql' },
  ]

  if (source.options.migrations === 'onStart') {
    // An absolute path: Nitro resolves a plugin against the server directory, so a `#capsa/…` id
    // would point at a file that does not exist, and the server would crash on start.
    const plugin = join(buildDir, source.templateDir, 'migrations.plugin.mjs')

    addServerTemplate({ filename: plugin, getContents: () => renderMigrationsPlugin(source) })
    addNitroPlugin(plugin)
  }
}

/**
 * Stops the server build when two schema files export the same name. Rollup leaves such a name out
 * of the schema with only a warning, so the table would be missing at runtime.
 *
 * @example
 * // server/capsa/db/default/schema/posts.ts and layers/blog/server/capsa/db/default/schema/posts.ts both export `posts`
 * failOnSchemaConflicts(nuxt, source)  // the build throws, naming `posts` and both files
 */
function failOnSchemaConflicts(nuxt: Nuxt, source: DrizzleSource) {
  /** Makes the bundler's warning about the schema module an error, in what one Nitro builds. */
  function check(nitro: NitroInstance) {
    nitro.hooks.hook('rollup:before', (_, config) => {
      const onwarn = config.onwarn

      config.onwarn = (warning, warn) => {
        // rolldown names the re-exporting module `exporter`, and the binding only in its message.
        if (warning.code === 'NAMESPACE_CONFLICT' && (warning as { exporter?: string }).exporter === source.schemaModule) {
          const binding = /re-exports "([^"]+)"/.exec(warning.message)?.[1]

          throw new Error(`[capsa] db source "${source.name}": \`${binding}\` is exported by more than one schema file (\`${warning.ids!.join('`, `')}\`). Rename all but one.`)
        }

        return onwarn ? onwarn(warning, warn) : warn(warning)
      }
    })
  }

  nuxt.hook('nitro:init', (nitro) => {
    check(nitro)
    // `nuxt generate` builds no server but the one Nitro prerenders with, which is a Nitro of its own.
    nitro.hooks.hook('prerender:init', check)
  })
}

/**
 * Reads the source's files as the templates and drizzle-kit take them, and warns about what looks wrong.
 *
 * @example
 * await readFiles(nuxt, source)
 * // { schema: ['#capsa/root/server/capsa/db/default/schema/users'], relations: [], config: undefined, kitConfig: undefined }
 */
async function readFiles(nuxt: Nuxt, source: DrizzleSource) {
  const found = await findFiles(source, FILES)
  const config = projectConfig(source, found.config)

  for (const file of found.config.filter(file => file !== config))
    log.warn(`\`${file}\` is ignored: a db source takes its config from the project, not from a layer.`)

  if (!found.schema.length)
    log.warn(`no schema files for db source "${source.name}" in \`${source.dirs.join('`, `')}\`.`)

  if (source.options.migrations) await checkMigrations(source)

  return sourceFiles(nuxt.options.rootDir, found, config)
}

/**
 * Picks the project's `config.ts` among the ones found: a source has one config, and the project
 * has the last word over its layers.
 *
 * @example
 * projectConfig(source, ['/app/server/capsa/db/default/config.ts', '/app/layers/base/server/capsa/db/default/config.ts'])
 * // '/app/server/capsa/db/default/config.ts'
 */
function projectConfig(source: DrizzleSource, configs: string[]) {
  return configs.find(file => file.startsWith(`${source.dirs[0]}/`))
}

/**
 * Turns the files found into what generated code imports them by: a `declare module` block cannot re-export an
 * absolute path, so the server and the types take a `#capsa/root/…` specifier.
 *
 * @example
 * sourceFiles('/app', found, '/app/server/capsa/db/default/config.ts')
 * // { schema: ['#capsa/root/server/capsa/db/default/schema/users'],
 * //   relations: ['#capsa/root/layers/base/server/capsa/db/default/relations', '#capsa/root/server/capsa/db/default/relations'],
 * //   config: '#capsa/root/server/capsa/db/default/config', kitConfig: '/app/server/capsa/db/default/config' }
 */
function sourceFiles(rootDir: string, found: Record<keyof typeof FILES, string[]>, config: string | undefined): SourceFiles {
  const specifier = (file: string) => rootAlias(rootDir, file)

  return {
    schema: found.schema.map(specifier),
    // In the order they are spread: the project's last, so it wins over the layers it extends.
    relations: found.relations.map(specifier).reverse(),
    config: config && specifier(config),
    kitConfig: config && withoutExtension(config),
  }
}

/**
 * Stops on migrations that Nitro's storage or drizzle would otherwise skip without a word.
 *
 * @example
 * // server/capsa/db/default/migrations/20260101000000_what?/migration.sql
 * await checkMigrations(source)  // throws: the folder has "?" in its name
 */
async function checkMigrations({ name, migrationsDir }: DrizzleSource) {
  for (const file of await resolveFiles(migrationsDir, ['*/migration.sql', 'meta/_journal.json'])) {
    if (file.endsWith('_journal.json'))
      throw new Error(`[capsa] db source "${name}": \`${migrationsDir}\` holds migrations in the old drizzle-kit format. Run \`drizzle-kit up\`.`)

    // Nitro's storage cuts a key at "?", and reads ":" and "\\" as folder separators. Cut out of the path by hand:
    // a path library would read the "\\" as a separator too, and hand back half the name.
    const folder = file.slice(migrationsDir.length + 1, -'/migration.sql'.length)

    if (/[?:\\]/.test(folder))
      throw new Error(`[capsa] db source "${name}": rename the migration folder "${folder}", Nitro's storage cannot read back a name with "?", ":" or "\\".`)
  }
}
