import { createResolver, directoryToURL, logger, tryResolveModule } from '@nuxt/kit'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { satisfies } from 'verkit'

/** capsa's logger: its messages start with `[capsa]`. */
export const log = logger.withTag('capsa')

const { resolve } = createResolver(import.meta.url)

/**
 * Warns about each package of `names` the project has in a version outside the range capsa's `peerDependencies` give it.
 *
 * The package manager says so once, at install, and pnpm only as a warning: this says it on every build. A package the
 * project does not have is left alone: the code capsa generates for it fails on its own, naming it.
 *
 * @example
 * await checkPeers('/app', ['drizzle-orm', 'drizzle-kit'])
 * // with drizzle-orm 1.1.0 installed: [capsa] `drizzle-orm@1.1.0` is installed, but capsa supports `drizzle-orm@~1.0.0-rc.5`: …
 */
export async function checkPeers(rootDir: string, names: string[]) {
  const { peerDependencies } = JSON.parse(await readFile(resolve('../package.json'), 'utf8')) as { peerDependencies: Record<string, string> }

  for (const name of names) {
    const version = await installedVersion(rootDir, name)
    const range = peerDependencies[name]!

    if (version && !satisfies(version, range))
      log.warn(`\`${name}@${version}\` is installed, but capsa supports \`${name}@${range}\`: install a version in that range, or a release of capsa that supports this one.`)
  }
}

/**
 * The version of `name` the project resolves, from the `package.json` above its entry: a package's `exports` need not
 * list `./package.json`.
 *
 * @example
 * await installedVersion('/app', 'drizzle-orm')  // '1.0.0-rc.5'
 */
async function installedVersion(rootDir: string, name: string) {
  const entry = await tryResolveModule(name, directoryToURL(rootDir))
  if (!entry) return

  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const pkg = await readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse, () => undefined) as { name?: string, version?: string } | undefined
    if (pkg?.name === name) return pkg.version
  }
}

/**
 * The path of a file in capsa's own `runtime/`: under `src/` in the dev stub and under `dist/` once built.
 *
 * @example
 * runtimePath('app/auth/session')  // '/app/node_modules/nuxt-capsa/dist/runtime/app/auth/session'
 */
export function runtimePath(path: string) {
  return resolve('./runtime', path)
}

/**
 * The project's root as generated code imports it.
 *
 * Nuxt's `~~` is not mapped in the server's tsconfig, and a `declare module` block ignores a relative or absolute
 * specifier: an alias of capsa's own reaches the files from Vite, Nitro and every type context.
 */
export const ROOT = '#capsa/root'

/**
 * Turns a file of the project into the specifier generated code imports it by.
 *
 * A file of a layer outside the project becomes `#capsa/root/../…`, which TypeScript resolves because the alias is a
 * mapped name and the rest of the string is substituted into it. The extension goes: a path mapping does not resolve
 * a specifier that ends in `.ts`.
 *
 * @example
 * rootAlias('/app', '/app/server/capsa/db/default/schema/users.ts')  // '#capsa/root/server/capsa/db/default/schema/users'
 */
export function rootAlias(rootDir: string, file: string) {
  // `relative` hands back backslashes on Windows: a specifier takes forward slashes.
  return `${ROOT}/${withoutExtension(relative(rootDir, file).split(sep).join('/'))}`
}

/**
 * Drops a TypeScript extension.
 *
 * @example
 * withoutExtension('/app/server/capsa/db/default/config.ts')  // '/app/server/capsa/db/default/config'
 */
export function withoutExtension(file: string) {
  return file.replace(/\.[cm]?tsx?$/, '')
}
