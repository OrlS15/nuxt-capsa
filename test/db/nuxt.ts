import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nuxtCtx } from '@nuxt/kit'
import type { CompilerOptions } from 'typescript'
import { resolveSource } from '../../src/db/drizzle/config'
import type { DrizzleSourceConfig } from '../../src/db/drizzle/config'
import { renderSourceModule } from '../../src/db/drizzle/templates'
import type { DbSource, DbSourceConfigBase } from '../../src/db/provider'
import { DRIVERS } from '../../src/runtime/db/drizzle/drivers'
import { defineMigrations } from '../../src/runtime/db/drizzle/migrations'
import { defineSource } from '../../src/runtime/db/drizzle/source'

type Handler = (...args: never[]) => unknown

/**
 * Makes a Nuxt just real enough for capsa's setup: templates land in `options.nitro.virtual` and
 * `options.build.templates`, hooks are kept and can be called, and Nitro counts its reloads.
 * `layers` are the roots Nuxt resolved, the project's first.
 *
 * @example
 * const nuxt = fakeNuxt('/tmp/app', { dev: true })
 * await nuxt.callHook('builder:watch', 'add', '/tmp/app/server/capsa/db/default/schema/posts.ts')
 * nuxt.reloads  // 1, once the debounce is over
 */
export function fakeNuxt(rootDir: string, { dev = false, layers = [rootDir] } = {}) {
  const handlers = new Map<string, Handler[]>()
  const callHook = async (name: string, ...args: unknown[]) => {
    for (const handler of handlers.get(name) ?? []) await (handler as (...a: unknown[]) => unknown)(...args)
  }

  const nuxt = {
    // What kit reads to pick server variants: Nuxt 5, on Nitro 3.
    _version: '5.0.0',
    options: {
      _nitroMajor: 3,
      _serverPlugins: [] as { plugin: string }[],
      dev,
      rootDir,
      buildDir: join(rootDir, '.nuxt'),
      runtimeConfig: {},
      nitro: { virtual: {} as Record<string, () => string>, serverAssets: undefined as unknown[] | undefined, plugins: undefined as string[] | undefined },
      build: { templates: [] as { filename: string, getContents: (data: unknown) => string }[] },
      alias: {},
      vite: {},
      ignore: [],
      extensions: ['.js', '.mjs', '.ts', '.vue'],
      _layers: layers.map(cwd => ({ cwd, config: { rootDir: cwd } })),
    },
    _ignore: { ignores: () => false },
    _nitro: { hooks: { callHook: async (name: string) => void (name === 'rollup:reload' && nuxt.reloads++) } },
    reloads: 0,
    hooks: { callHook },
    hook: (name: string, handler: Handler) => void handlers.set(name, [...handlers.get(name) ?? [], handler]),
    callHook,
  }

  nuxtCtx.unset()
  nuxtCtx.set(nuxt as never)

  return nuxt
}

/**
 * A db source as its provider receives it, for an app at `/app` with no layers.
 *
 * @example
 * fakeSource('logs', { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' }).dirs  // ['/app/server/capsa/db/logs']
 */
export function fakeSource<C extends DbSourceConfigBase>(name: string, options: C): DbSource<C> {
  return { name, options, dirs: [`/app/server/capsa/db/${name}`], moduleId: `#capsa/db/${name}`, templateDir: `capsa/db/${name}/` }
}

/**
 * Writes files under a directory, creating the folders they need.
 *
 * @example
 * await writeFiles('/tmp/app', { 'server/capsa/db/default/schema.ts': '' })
 */
export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
}

/**
 * Runs generated code with each import taken from `modules[specifier]`, and hands back `returns`
 * evaluated at its end. An import of a module that is not listed throws, as it would break the bundle.
 *
 * @example
 * runModule(`import { a } from 'x'\nexport const b = a + 1`, { x: { a: 1 } }, 'b')  // 2
 */
export function runModule(code: string, modules: Record<string, Record<string, unknown>>, returns: string) {
  const names: string[] = []
  const values: unknown[] = []

  const body = code
    .replace(/^import (.+) from '(.+)'\n/gm, (_, what: string, from: string) => {
      const module = modules[from]

      if (!module) throw new Error(`unexpected import '${from}'`)

      if (what.startsWith('* as ')) {
        names.push(what.slice(5))
        values.push(module)
      }
      else if (what.startsWith('{')) {
        for (const part of what.slice(1, -1).split(',')) {
          const [name, alias = name] = part.trim().split(/\s+as\s+/) as [string, string?]
          names.push(alias)
          values.push(module[name])
        }
      }
      else {
        names.push(what)
        values.push(module.default)
      }

      return ''
    })
    .replace(/^export \* as .*\n/gm, '')
    .replace(/^export default /m, 'const __default = ')
    .replace(/^export /gm, '')

  return new Function(...names, `${body}\nreturn ${returns}`)(...values)
}

/** Serves a migrations folder the way Nitro's storage does in dev: every file, keyed `<folder>:<file>`. */
export function folderStorage(folder: string) {
  return {
    getKeys: async () => (await readdir(folder, { recursive: true })).filter(path => path.includes('/')).map(path => path.replaceAll('/', ':')),
    getItem: (key: string) => readFile(join(folder, key.replaceAll(':', '/')), 'utf8'),
  }
}

/** Imports a module whose name is built at runtime, which Vite would otherwise read as a glob. */
export const importModule = (id: string) => import(id)

/**
 * Loads the module capsa generates for a source on real drizzle, its migrations read from `folder`. What it
 * registers on Nitro's `close` hook lands in `closing`.
 *
 * @example
 * const { getDb, applyMigrations } = await capsaSource({ provider: 'drizzle', dialect: 'sqlite', driver: 'node-sqlite' }, ':memory:', '/tmp/migrations')
 */
export async function capsaSource(config: { provider: 'drizzle', dialect: string, driver: string }, connection: string, folder: string, closing: (() => unknown)[] = []) {
  const resolved = resolveSource(fakeSource('default', { ...config, migrations: 'manual' } as DrizzleSourceConfig))
  const { core } = resolved.dialect
  const imports = ['node:fs', 'drizzle-orm', 'drizzle-orm/migrator.utils', `drizzle-orm/${config.driver}`, core, `${core}/async/session`]
  const modules = Object.fromEntries(await Promise.all(imports.map(async id => [id, await importModule(id)])))
  const module = renderSourceModule(resolved, { schema: [], relations: [] })

  return runModule(module, {
    ...modules,
    'nuxt/server': { useRuntimeConfig: () => ({ capsa: { db: { default: { connection, replicas: [] } } } }) },
    'nitro/storage': { useStorage: () => folderStorage(folder) },
    'nitro/app': { useNitroHooks: () => ({ hook: (name: string, run: () => unknown) => name === 'close' && closing.push(run) }) },
    'nuxt-capsa/db/drizzle/drivers': { DRIVERS },
    'nuxt-capsa/db/drizzle/source': { defineSource },
    'nuxt-capsa/db/drizzle/migrations': { defineMigrations },
    '#capsa/db/default/schema': {},
  }, '{ getDb, applyMigrations }')
}

/**
 * Type-checks a set of files together, and lists each error as `<file>:<line> TS<code>`. The files sit in the
 * repo's `.tmp`, so their imports reach its node_modules; `options` adds to the compiler's.
 *
 * @example
 * await typeErrors({ 'a.ts': 'export const a: number = ""' })  // ['a.ts:1 TS2322']
 */
export async function typeErrors(files: Record<string, string>, options: CompilerOptions = {}) {
  return (await diagnose(files, options)).map(({ at, code }) => `${at} TS${code}`)
}

/**
 * Type-checks a set of files like `typeErrors`, and lists each error as `<file>:<line> <message>`: for the errors
 * whose wording is what a test is about.
 *
 * @example
 * await typeMessages({ 'a.ts': 'export const a: number = ""' })  // ["a.ts:1 Type 'string' is not assignable to type 'number'."]
 */
export async function typeMessages(files: Record<string, string>, options: CompilerOptions = {}) {
  return (await diagnose(files, options)).map(({ at, message }) => `${at} ${message}`)
}

/** Type-checks a set of files together in the repo's `.tmp`, and returns where each error is, its code and its message. */
async function diagnose(files: Record<string, string>, options: CompilerOptions) {
  // Loaded here: every test file that imports these helpers would pay for it otherwise.
  const { default: ts } = await import('typescript')
  const tmp = fileURLToPath(new URL('../../.tmp', import.meta.url))

  await mkdir(tmp, { recursive: true })
  const dir = await mkdtemp(join(tmp, 'types-'))

  try {
    await writeFiles(dir, files)

    const program = ts.createProgram(Object.keys(files).map(name => join(dir, name)), {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      // better-auth's client types use fetch's Request and Response.
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      ...options,
    })

    return ts.getPreEmitDiagnostics(program).map(({ file, start, code, messageText }) => {
      const line = file!.getLineAndCharacterOfPosition(start!).line + 1

      return { at: `${file!.fileName.slice(dir.length + 1)}:${line}`, code, message: ts.flattenDiagnosticMessageText(messageText, '\n') }
    })
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}
