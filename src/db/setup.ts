import { addServerImports, addServerTemplate, addTypeTemplate } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { setupDrizzle } from './drizzle/setup'
import { createDbSource, type DbProvider } from './provider'
import { renderDbModule, renderDbTypes } from './templates'
import { checkPeers } from '../utils'

/** Every provider capsa ships, keyed by the name a source writes in `provider`. A new one is a folder, and a line here and in `PEERS`. */
export const PROVIDERS = { drizzle: setupDrizzle }

/** The packages a provider's generated code imports: their versions are checked against capsa's `peerDependencies`. */
const PEERS: Record<keyof typeof PROVIDERS, string[]> = { drizzle: ['drizzle-orm', 'drizzle-kit'] }

/**
 * The config of any source, in the shape the provider it names accepts.
 *
 * Adding a provider to the registry widens this on its own, and with it what `capsa.db` accepts.
 *
 * @example
 * { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' }
 */
export type DbSourceConfig = Parameters<(typeof PROVIDERS)[keyof typeof PROVIDERS]>[1]['options']

/**
 * Db sources, keyed by name: letters, numbers and `_`. `default` is required, any other is optional.
 *
 * The name is what `useCapsaDb('<name>')` and `#capsa/db/<name>` take, the folder of the source's
 * files unless `dir` moves it (`server/capsa/db/<name>`), and part of its variables, spelled the way
 * Nitro reads them (`analyticsDb` → `NUXT_CAPSA_DB_ANALYTICS_DB_CONNECTION`).
 *
 * @example
 * { default: { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' } }
 */
export interface DbFeatureOptions {
  /** The source `useCapsaDb()` hands back when it is called with no name. */
  default: DbSourceConfig
  [name: string]: DbSourceConfig
}

/** What a source name may hold: it becomes a module specifier and part of a `NUXT_*` variable, where Nitro reads "-" as "_". */
const SOURCE_NAME = /^\w+$/

/**
 * Wires the db feature into the build: the shared `#capsa/db`, then one setup per source.
 *
 * Every source is made before any of them is set up, so a name, a provider or a `dir` that is wrong
 * stops the build before half the modules are registered.
 */
export async function setupDbFeature(nuxt: Nuxt, options: DbFeatureOptions) {
  const sources = Object.entries(options).map(([name, config]) => {
    if (!SOURCE_NAME.test(name))
      throw new Error(`[capsa] invalid db source name "${name}": use only letters, numbers and "_".`)

    if (!Object.hasOwn(PROVIDERS, config.provider))
      throw new Error(`[capsa] db source "${name}" names an unknown provider "${config.provider}". Available: ${Object.keys(PROVIDERS).join(', ')}.`)

    return createDbSource(nuxt, name, config)
  })

  // The auto-import is also what keeps an unused source out of the bundle: with nothing referencing
  // `useCapsaDb`, nothing imports this module and no driver is pulled in.
  addServerTemplate({ filename: '#capsa/db', getContents: () => renderDbModule(sources) })
  addServerImports([{ name: 'useCapsaDb', from: '#capsa/db' }])

  // In the nitro, the app and the `shared/` context.
  addTypeTemplate({ filename: 'types/capsa-db.d.ts', getContents: () => renderDbTypes(sources) }, { nitro: true, nuxt: true, shared: true })

  for (const source of sources) {
    // The registry pairs a provider with the config it takes: TypeScript cannot follow that pairing through `provider`.
    await (PROVIDERS[source.options.provider] as DbProvider)(nuxt, source)
  }

  // Once per provider, however many sources use it.
  for (const provider of new Set(sources.map(source => source.options.provider)))
    await checkPeers(nuxt.options.rootDir, PEERS[provider])
}
