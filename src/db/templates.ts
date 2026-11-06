import type { DbSource } from './provider'

/** What the shared module needs from a source: its name, and where its provider put its module. */
type SourceModule = Pick<DbSource, 'name' | 'moduleId'>

/**
 * Renders `#capsa/db`, the module `useCapsaDb` is auto-imported from.
 *
 * The names are known at build, so the dispatch is a `switch` on a literal and not a lookup. Which
 * provider built a source never appears here: every source module exports `getDb`.
 *
 * @example
 * With a `default` and an `analytics` source:
 * ```js
 * import { getDb as getDb_0 } from '#capsa/db/default'
 * import { getDb as getDb_1 } from '#capsa/db/analytics'
 *
 * export function useCapsaDb(name = "default") {
 *   switch (name) {
 *     case "default": return getDb_0()
 *     case "analytics": return getDb_1()
 *   }
 *
 *   throw new Error(`[capsa] unknown db source "${name}". Configured: default, analytics.`)
 * }
 * ```
 */
export function renderDbModule(sources: SourceModule[]) {
  const imports = sources.map((source, index) => `import { getDb as getDb_${index} } from '${source.moduleId}'`)
  const cases = sources.map((source, index) => `    case ${JSON.stringify(source.name)}: return getDb_${index}()`)
  const names = sources.map(source => source.name).join(', ')

  return `${imports.join('\n')}

export function useCapsaDb(name = "default") {
  switch (name) {
${cases.join('\n')}
  }

  throw new Error(\`[capsa] unknown db source "\${name}". Configured: ${names}.\`)
}
`
}

/**
 * Renders the types of `#capsa/db`.
 *
 * A source's type is read back from the module its provider generated, so a drizzle source types as
 * a drizzle instance and another provider's as whatever that one hands out, with nothing here
 * knowing either. Adding a provider adds no line to this file.
 *
 * @example
 * With a `default` and an `analytics` source:
 * ```ts
 * declare module '#capsa/db' {
 *   export interface CapsaDbSources {
 *     "default": ReturnType<typeof import('#capsa/db/default').getDb>
 *     "analytics": ReturnType<typeof import('#capsa/db/analytics').getDb>
 *   }
 *
 *   export function useCapsaDb<N extends "default" | "analytics" = "default">(name?: N): CapsaDbSources[N]
 * }
 * ```
 */
export function renderDbTypes(sources: SourceModule[]) {
  const entries = sources.map(source => `    ${JSON.stringify(source.name)}: ReturnType<typeof import('${source.moduleId}').getDb>`)
  // Written out, so that a wrong name is reported against the names themselves, not `keyof CapsaDbSources`.
  const names = sources.map(source => JSON.stringify(source.name)).join(' | ')

  return `declare module '#capsa/db' {
  export interface CapsaDbSources {
${entries.join('\n')}
  }

  export function useCapsaDb<N extends ${names} = "default">(name?: N): CapsaDbSources[N]
}
`
}
