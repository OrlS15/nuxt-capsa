/**
 * Renders `#capsa/auth`: the server side of auth, which `defineAuth` builds from the project's own better-auth, its
 * config and its rules. The module only imports and hands over: what it does lives in `runtime/auth/server.ts`.
 *
 * better-auth is imported here, in generated code, and never by capsa itself: it stays the project's dependency.
 *
 * @example
 * With the project's config at server/capsa/auth/config.ts:
 * ```js
 * import { betterAuth, env } from 'better-auth'
 * import { defineAuth } from 'nuxt-capsa/auth/server'
 * import config from '#capsa/root/server/capsa/auth/config'
 * import abilities from '#capsa/auth/abilities'
 *
 * export const { useCapsaAuth, authReady, getSession, requireSession, can, cannot, authorize } = defineAuth({
 *   betterAuth,
 *   env,
 *   config,
 *   abilities,
 *   basePath: "/api/auth",
 * })
 * ```
 */
export function renderServerModule(config: string, basePath: string) {
  return `import { betterAuth, env } from 'better-auth'
import { defineAuth } from 'nuxt-capsa/auth/server'
import config from '${config}'
import abilities from '#capsa/auth/abilities'

export const { useCapsaAuth, authReady, getSession, requireSession, can, cannot, authorize } = defineAuth({
  betterAuth,
  env,
  config,
  abilities,
  basePath: ${JSON.stringify(basePath)},
})
`
}

/**
 * Renders `#build/capsa/auth/client.mjs`, which hands `useCapsaSession()` what the build knows: where better-auth
 * answers, and the way to create its client, with the project's client config when there is one.
 *
 * @example
 * With the project's config at app/capsa/auth.config.ts:
 * ```js
 * import { createAuthClient } from 'better-auth/vue'
 * import config from '#capsa/root/app/capsa/auth.config'
 *
 * export const basePath = "/api/auth"
 * export const createClient = defaults => createAuthClient(config(defaults))
 * ```
 */
export function renderClientModule(config: string | undefined, basePath: string) {
  return `import { createAuthClient } from 'better-auth/vue'
${config ? `import config from '${config}'\n` : ''}
export const basePath = ${JSON.stringify(basePath)}
export const createClient = defaults => createAuthClient(${config ? 'config(defaults)' : 'defaults'})
`
}

/**
 * Renders the app's rules, merged once, as `#capsa/auth/abilities` on the server and `#build/capsa/auth/abilities.mjs` in the app. Without rules files it is empty, so
 * the app ships no rule code.
 *
 * @example
 * With two rules files:
 * ```js
 * import { mergeAbilities } from 'nuxt-capsa/auth/rules'
 * import abilities_0 from '#capsa/root/shared/capsa/abilities'
 * import abilities_1 from '#capsa/root/shared/capsa/abilities/post'
 *
 * export default mergeAbilities([abilities_0, abilities_1])
 * ```
 */
export function renderAbilities(files: string[]) {
  if (!files.length) return 'export default {}\n'

  return `import { mergeAbilities } from 'nuxt-capsa/auth/rules'
${files.map((file, i) => `import abilities_${i} from '${file}'`).join('\n')}

export default mergeAbilities([${files.map((_, i) => `abilities_${i}`).join(', ')}])
`
}

/**
 * Renders better-auth's types for the app, the server and shared code: the instance and the client typed from
 * the two config files.
 *
 * @example
 * With both config files and two rules files:
 * ```ts
 * export {}
 *
 * // The client options, plus better-auth's type-only plugin that makes the server's additional fields known to the client.
 * type WithServerFields<O, Auth> = Omit<O, 'plugins'> & {
 *   plugins: [...(O extends { plugins: infer P extends readonly unknown[] } ? P : []), ReturnType<typeof import('better-auth/client/plugins').inferAdditionalFields<Auth>>]
 * }
 *
 * declare module 'nuxt-capsa/auth' {
 *   interface CapsaAuthTypes {
 *     // capsa's own to set: basePath is capsa.auth.basePath in nuxt.config, and the secret comes from the environment.
 *     serverOptions: Omit<import('better-auth').BetterAuthOptions, 'basePath' | 'secret'> & { basePath?: never, secret?: never }
 *     clientOptions: import('better-auth/client').BetterAuthClientOptions
 *     auth: import('better-auth').Auth<ReturnType<typeof import('#capsa/root/server/capsa/auth/config').default>>
 *     session: CapsaAuthTypes['auth']['$Infer']['Session']
 *     client: import('better-auth/vue').VueAuthClient<WithServerFields<ReturnType<typeof import('#capsa/root/app/capsa/auth.config').default>, CapsaAuthTypes['auth']>>
 *     abilities: typeof import('#capsa/root/shared/capsa/abilities').default & typeof import('#capsa/root/shared/capsa/abilities/post').default
 *   }
 * }
 * ```
 */
export function renderTypes(server: string, client: string | undefined, abilities: string[]) {
  return `export {}

// The client options, plus better-auth's type-only plugin that makes the server's additional fields known to the client.
type WithServerFields<O, Auth> = Omit<O, 'plugins'> & {
  plugins: [...(O extends { plugins: infer P extends readonly unknown[] } ? P : []), ReturnType<typeof import('better-auth/client/plugins').inferAdditionalFields<Auth>>]
}

declare module 'nuxt-capsa/auth' {
  interface CapsaAuthTypes {
    // capsa's own to set: basePath is capsa.auth.basePath in nuxt.config, and the secret comes from the environment.
    serverOptions: Omit<import('better-auth').BetterAuthOptions, 'basePath' | 'secret'> & { basePath?: never, secret?: never }
    clientOptions: import('better-auth/client').BetterAuthClientOptions
    auth: import('better-auth').Auth<ReturnType<typeof import('${server}').default>>
    session: CapsaAuthTypes['auth']['$Infer']['Session']
    client: import('better-auth/vue').VueAuthClient<WithServerFields<${client ? `ReturnType<typeof import('${client}').default>` : '{}'}, CapsaAuthTypes['auth']>>
    abilities: ${abilities.map(file => `typeof import('${file}').default`).join(' & ') || '{}'}
  }
}
`
}

/**
 * Renders the types of `#capsa/auth`, which only the server can import: the ones `defineAuth` returns.
 *
 * @example
 * ```ts
 * declare module '#capsa/auth' {
 *   export const { useCapsaAuth, authReady, getSession, requireSession, can, cannot, authorize }: import('nuxt-capsa/auth/server').AuthServer
 * }
 * ```
 */
export function renderServerTypes() {
  return `declare module '#capsa/auth' {
  export const { useCapsaAuth, authReady, getSession, requireSession, can, cannot, authorize }: import('nuxt-capsa/auth/server').AuthServer
}
`
}
