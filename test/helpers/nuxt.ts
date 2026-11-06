import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nuxtCtx } from '@nuxt/kit'

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

/** Imports a module whose name is built at runtime, which Vite would otherwise read as a glob. */
export const importModule = (id: string) => import(id)
