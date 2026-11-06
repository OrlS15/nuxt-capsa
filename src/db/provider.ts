import { addServerTemplate, addTemplate, addTypeTemplate, createResolver, getLayerDirectories, resolveFiles, updateTemplates, useNitro } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import defu from 'defu'
import { isAbsolute } from 'node:path'
import { log } from '../utils'

export interface DbSourceConfigBase {
  /** The provider that builds this source's db instance. */
  provider: string
  /**
   * Directory holding the source's files.
   *
   * @default 'capsa/db/<name>'
   * @example 'database/default' -> 'server/database/default' of every layer
   */
  readonly dir?: string
}

/**
 * One db source, as its provider receives it.
 *
 * @example
 * { name: 'default', options: { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' },
 *   dirs: ['/app/server/capsa/db/default', '/app/layers/base/server/capsa/db/default'],
 *   moduleId: '#capsa/db/default', templateDir: 'capsa/db/default/' }
 */
export interface DbSource<C extends DbSourceConfigBase = DbSourceConfigBase> {
  /** The key of the source in `capsa.db`. */
  readonly name: string
  /** `capsa.db.<name>`, as written in nuxt.config. */
  readonly options: C
  /** The source's directory in every layer, the project's first. */
  readonly dirs: string[]
  /** The module its provider generates, the one `useCapsaDb` reads `getDb` from. */
  readonly moduleId: `#capsa/db/${string}`
  /** Where its real files land in the build directory. */
  readonly templateDir: `capsa/db/${string}/`
}

/** A provider: the function that sets one source up. */
export type DbProvider<C extends DbSourceConfigBase = DbSourceConfigBase> = (nuxt: Nuxt, source: DbSource<C>) => Promise<void>

/**
 * Makes a source from its entry in `capsa.db`.
 *
 * @example
 * createDbSource(nuxt, 'logs', { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql', dir: 'database/logs' }).dirs
 * // ['/app/server/database/logs']
 */
export function createDbSource<C extends DbSourceConfigBase>(nuxt: Nuxt, name: string, options: C): DbSource<C> {
  const dir = options.dir ?? `capsa/db/${name}`

  // A source lives in the server directory of every layer, so there is nothing an absolute path
  // or an alias could mean here except a directory no layer owns.
  if (isAbsolute(dir) || dir.startsWith('~'))
    throw new Error(`[capsa] db source "${name}": \`dir\` is a path inside the server directory, so it cannot be absolute or an alias.`)

  return {
    name,
    options,
    dirs: [...new Set(getLayerDirectories(nuxt).map(layer => createResolver(layer.server).resolve(dir)))],
    moduleId: `#capsa/db/${name}`,
    templateDir: `capsa/db/${name}/`,
  }
}

/** Registers the source's own module, `#capsa/db/<name>`. */
export function addModule(source: DbSource, getContents: () => string) {
  addServerTemplate({ filename: source.moduleId, getContents })
}

/**
 * Registers a module under the source's own.
 *
 * @example
 * addSubModule(source, 'schema', render)  // -> '#capsa/db/default/schema'
 */
export function addSubModule(source: DbSource, suffix: string, getContents: () => string) {
  addServerTemplate({ filename: `${source.moduleId}/${suffix}`, getContents })
}

/**
 * Registers a type template for the source, next to its other generated files, in the nitro,
 * the app and the `shared/` context: row types written in `shared/types` import from it too.
 *
 * @example
 * addTypes(source, render, '-config')  // -> '.nuxt/capsa/db/default/types-config.d.ts'
 */
export function addTypes(source: DbSource, getContents: () => string, suffix = '') {
  addTypeTemplate({ filename: `${source.templateDir}types${suffix}.d.ts`, getContents }, { nitro: true, nuxt: true, shared: true })
}

/**
 * Writes a real file in the build directory, for a tool that reads it from disk instead of going
 * through the bundle: a CLI has no Nitro, so a virtual module is invisible to it.
 *
 * @example
 * addFile(source, 'drizzle.config.ts', render)  // -> '.nuxt/capsa/db/default/drizzle.config.ts'
 */
export function addFile(source: DbSource, name: string, getContents: () => string) {
  addTemplate({ filename: `${source.templateDir}${name}`, getContents, write: true })
}

/**
 * Writes the source's defaults into `runtimeConfig.capsa.db.<name>`, under what the project already put there.
 *
 * @example
 * writeRuntimeConfig(nuxt, source, { connection: '' })  // NUXT_CAPSA_DB_DEFAULT_CONNECTION replaces it at runtime
 */
export function writeRuntimeConfig(nuxt: Nuxt, source: DbSource, payload: Record<string, unknown>) {
  nuxt.options.runtimeConfig.capsa = defu(nuxt.options.runtimeConfig.capsa || {}, { db: { [source.name]: payload } })
}

/**
 * Finds the files of each kind, across every directory of the source.
 *
 * @example
 * await findFiles(source, { schema: ['schema/**\/*.ts'], relations: ['relations.ts'] })
 * // { schema: ['/app/server/capsa/db/default/schema/users.ts'], relations: [] }
 */
export async function findFiles<K extends string>(source: DbSource, kinds: Record<K, string[]>) {
  const found = (Object.entries(kinds) as [K, string[]][]).map(async ([kind, patterns]) => {
    const perDir = await Promise.all(source.dirs.map(dir => resolveFiles(dir, patterns)))

    return [kind, perDir.flat()] as const
  })

  return Object.fromEntries(await Promise.all(found)) as Record<K, string[]>
}

/**
 * Refreshes the source whenever a file appears or disappears inside its directories.
 *
 * `refresh` re-reads what the provider keeps, and does anything of its own. The source's real files are then written
 * again and Nitro rebuilt.
 *
 * @example
 * onFilesChange(nuxt, source, async () => { files = await readFiles(nuxt, source) })
 */
export function onFilesChange(nuxt: Nuxt, source: DbSource, refresh: () => Promise<void>) {
  let debounced: ReturnType<typeof setTimeout> | undefined

  nuxt.hook('builder:watch', (event, path) => {
    // A `change` leaves the file lists alone, so nothing generated here would come out different.
    if (event !== 'add' && event !== 'unlink') return

    // With its slash, so a sibling whose name merely starts the same is not taken for the directory.
    if (!source.dirs.some(dir => path.startsWith(`${dir}/`))) return

    // A branch switch fires one event per file: the refresh waits for the burst to end.
    clearTimeout(debounced)

    debounced = setTimeout(async () => {
      try {
        await refresh()
        // The types and whatever the source put on disk are real files that a Nitro reload leaves alone: without
        // this the editor keeps reading the types from before, and a CLI the file list from before.
        await updateTemplates({ filter: template => template.filename.startsWith(source.templateDir) })
        // Rebuilds the server bundle, so every module the source generated renders again.
        await useNitro().hooks.callHook('rollup:reload')
      }
      catch (error) {
        // Thrown from here, it would crash the dev server: reported instead, and the next change tries again.
        log.error(error)
      }
    }, 50)
  })
}
