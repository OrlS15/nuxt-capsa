import { defu } from 'defu'

/**
 * What each source's `config.ts` may change, filled in by the provider that builds that source.
 *
 * Empty here on purpose: the shape is the provider's, and the types capsa generates fill it in.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an augmentation target has to be empty
export interface CapsaDbConfigs {}

/**
 * Types a source's `config.ts`, and lets each hook return only what it changes: capsa's own value
 * fills in the rest (arrays are joined, objects merged).
 *
 * It lives here, and not on the module's main entry, so that importing it from a server file does
 * not pull `@nuxt/kit` into the Nitro bundle. Being a real export and not a global is what lets an
 * external CLI — `drizzle-kit`, `typeorm` — load the same file. The source's name is a value, as in `defineDriveConfig`;
 * the names are a mapped type and not `keyof`, so that a wrong one is reported against the names themselves.
 *
 * @example
 * import { defineDbConfig } from 'nuxt-capsa/db'
 *
 * export default defineDbConfig('default', { options: () => ({ logger: true }) })
 */
export function defineDbConfig<K extends { [N in keyof CapsaDbConfigs]: N }[keyof CapsaDbConfigs]>(source: K, config: CapsaDbConfigs[K]): CapsaDbConfigs[K] {
  const hooks = Object.entries(config as Record<string, (base: object) => object>)

  return Object.fromEntries(hooks.map(([name, hook]) => [name, (base: object) => defu(hook(base), base)])) as CapsaDbConfigs[K]
}
