import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tryResolveModule } from '@nuxt/kit'
import { init, parse } from 'es-module-lexer'
import { describe, expect, it } from 'vitest'
import { renderClientModule, renderServerModule } from '../src/auth/templates'
import { resolveSource, type DrizzleSourceConfig } from '../src/db/drizzle/config'
import { renderSourceModule } from '../src/db/drizzle/templates'
import { renderDriveModule } from '../src/drive/templates'
import { DRIVERS } from '../src/runtime/db/drizzle/drivers'
import { fakeSource } from './db/source'

/**
 * What capsa generates imports from the packages the project installs: each name it imports must still be exported by
 * the installed version. The packages are read, never run, so no driver needs to be installed.
 */

/** The packages the project installs, which generated code imports from. Anything else is capsa's, Nitro's or the app's. */
const PEERS = ['drizzle-orm', 'better-auth', 'files-sdk']

/** Adapters of files-sdk a disk can name: the ones capsa treats apart (fs), and the ones its docs and tests use. */
const ADAPTERS = ['fs', 'memory', 's3', 's3-fetch', 'r2', 'vercel-blob', 'netlify-blobs', 'gcs', 'azure', 'supabase']

const ROOT = new URL('..', import.meta.url)

/**
 * The names a generated module imports from the peers, by specifier.
 *
 * @example
 * peerImports(`import { drizzle } from 'drizzle-orm/pglite'\nimport { x } from '#capsa/db/default'`)
 * // [['drizzle-orm/pglite', ['drizzle']]]
 */
function peerImports(code: string) {
  return [...code.matchAll(/^import \{ (.+) \} from '(.+)'$/gm)]
    .filter(([, , from]) => PEERS.some(peer => from === peer || from!.startsWith(`${peer}/`)))
    .map(([, names, from]) => [from!, names!.split(',').map(name => name.trim().split(/\s+as\s+/)[0]!)] as const)
}

/** The file a specifier resolves to: from the project for a package, or from `file` for its own relative imports and its dependencies. */
async function resolveFrom(specifier: string, file: string | URL) {
  if (specifier.startsWith('.')) return resolve(dirname(String(file)), specifier)

  const found = await tryResolveModule(specifier, file instanceof URL ? file : pathToFileURL(file))
  if (!found) throw new Error(`${specifier} is not found from ${file}`)

  return found.startsWith('file:') ? fileURLToPath(found) : found
}

/** The names a module file exports, following `export * from`. */
async function exportsOf(file: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(file)) return []
  seen.add(file)

  await init
  const [, exports] = parse(await readFile(file, 'utf8'))
  const names: string[] = []

  for (const entry of exports) {
    if (entry.type === 'reexport-all') names.push(...await exportsOf(await resolveFrom(entry.from, file), seen))
    else names.push(entry.name)
  }

  return names
}

/**
 * Checks every peer import of `modules` against what the installed packages export, and lists what is missing, as
 * `<specifier>: <name>` or `<specifier>: not found`.
 */
async function missingImports(modules: string[]) {
  const wanted = new Map<string, Set<string>>()

  for (const module of modules) {
    for (const [from, names] of peerImports(module))
      wanted.set(from, new Set([...wanted.get(from) ?? [], ...names]))
  }

  const missing: string[] = []

  for (const [from, names] of wanted) {
    const file = await resolveFrom(from, ROOT).catch(() => undefined)

    if (!file) {
      missing.push(`${from}: not found`)
      continue
    }

    const exported = new Set(await exportsOf(file))
    missing.push(...[...names].filter(name => !exported.has(name)).map(name => `${from}: ${name}`))
  }

  return { checked: wanted.size, missing }
}

describe('what generated code imports from the installed packages', () => {
  it('exists in drizzle-orm, for every driver, with and without migrations', async () => {
    const modules = Object.entries(DRIVERS).flatMap(([dialect, drivers]) => Object.keys(drivers).flatMap(driver =>
      [undefined, 'manual' as const].map((migrations) => {
        const config = { provider: 'drizzle', dialect, driver, migrations } as DrizzleSourceConfig
        return renderSourceModule(resolveSource(fakeSource('default', config)), { schema: [], relations: [] })
      }),
    ))

    const { checked, missing } = await missingImports(modules)

    // Every driver's entry, every dialect's core and session, and the shared ones: a regex that stops matching shows here.
    expect(checked).toBeGreaterThan(Object.values(DRIVERS).flatMap(Object.keys).length)
    expect(missing).toEqual([])
  })

  it('exists in better-auth, for the server and the client', async () => {
    const { checked, missing } = await missingImports([
      renderServerModule('#capsa/root/server/capsa/auth/config', '/api/auth'),
      renderClientModule('#capsa/root/app/capsa/auth.config', '/api/auth'),
    ])

    expect(checked).toBe(2)
    expect(missing).toEqual([])
  })

  it('exists in files-sdk, for each adapter by its name in camel case', async () => {
    const disks = ADAPTERS.map(adapter => ({ name: adapter.replaceAll('-', '_'), adapter, env: '', defaults: {} }))
    const { checked, missing } = await missingImports([renderDriveModule(disks)])

    expect(checked).toBe(ADAPTERS.length + 1)
    expect(missing).toEqual([])
  })
})
