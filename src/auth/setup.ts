import { existsSync } from 'node:fs'
import { addComponentExports, addImports, addNitroPlugin, addRouteMiddleware, addServerHandler, addServerImports, addServerTemplate, addTemplate, addTypeTemplate, getLayerDirectories, resolveFiles } from '@nuxt/kit'
import type { LayerDirectories } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { defu } from 'defu'
// Nuxt hands every path over with forward slashes, on Windows too: joined the same way, they compare equal.
import { dirname, join } from 'node:path/posix'
import { renderAbilities, renderClientModule, renderServerModule, renderServerTypes, renderTypes } from './templates'
import { checkPeers, rootAlias, runtimePath } from '../utils'
import type { AuthRouteMode } from '../runtime/auth'

export type { AuthRouteMode }

/**
 * The auth feature: better-auth, wired into Nuxt. Its options go in `server/capsa/auth/config.ts` and
 * `app/capsa/auth.config.ts`; here go only the pages it guards.
 *
 * @example
 * { routes: { '/dashboard/**': 'user', '/login': 'guest' }, redirects: { user: '/login', guest: '/dashboard' } }
 */
export interface AuthFeatureOptions {
  /**
   * Pages and what they ask of the visitor. capsa attaches its route middleware to each one through `routeRules`,
   * next to whatever the path's own rule already holds.
   *
   * @example { '/dashboard/**': 'user', '/login': 'guest', '/dashboard/public': false }
   */
  routes?: Record<string, AuthRouteMode>
  /**
   * Where the route middleware sends a visitor a rule turns away: `user` pages send the signed out, `guest`
   * pages the signed in.
   *
   * @default { user: '/login', guest: '/' }
   */
  redirects?: { user?: `/${string}`, guest?: `/${string}` }
  /**
   * Where better-auth answers, under `app.baseURL`: capsa mounts its handler there, and points the server and the
   * client to it.
   *
   * @default '/api/auth'
   */
  basePath?: `/${string}`
  /**
   * The names `<Can>` and `<Cannot>` are registered under. A prefix keeps them apart from components of the same
   * name, such as your own `Can`.
   *
   * @example { prefix: 'Auth' }  // <AuthCan>, <AuthCannot>
   */
  components?: { prefix?: string }
}

/** The route middleware the auth rules turn on, by name. */
const MIDDLEWARE = 'capsa-auth'

/** Rule keys that serve a page from a cache, as Nitro holds them when it builds: by then `swr` has become `cache`. */
const CACHED = ['cache', 'isr', 'prerender', 'static']

/** A route rule, as far as capsa reads it: the middleware it attaches, in any form a rule may write it, and the keys that cache the page. */
type RouteRule = Record<string, unknown> & { appMiddleware?: string | string[] | Record<string, boolean> }

/** Where the app's rules live, inside `shared/capsa` of the project and of each layer: one file, or one per subject. */
const ABILITIES = ['abilities.ts', 'abilities/*.ts']

/** The project's files the auth feature is built from, as generated code imports them. */
interface AuthFiles {
  /** `server/capsa/auth/config.ts`. */
  server: string
  /** `app/capsa/auth.config.ts`, when the project has one. */
  client?: string
  /** The rules files of the project and of every layer. */
  abilities: string[]
}

/**
 * Wires better-auth into the build: its server instance and handler, the client and its composable, the pages the
 * route rules guard, and the app's own rules.
 */
export async function setupAuthFeature(nuxt: Nuxt, options: AuthFeatureOptions) {
  const layers = getLayerDirectories(nuxt)

  await checkPeers(nuxt.options.rootDir, ['better-auth'])

  // server/capsa/auth/config.ts (required) and app/capsa/auth.config.ts (optional), the project's and never a
  // layer's, and the rules files of every layer.
  const files = await findFiles(nuxt.options.rootDir, layers)

  // The URL from NUXT_CAPSA_AUTH_URL, and where the route middleware sends visitors. The secret comes from
  // NUXT_APP_SECRET, derived at runtime.
  writeRuntimeConfig(nuxt, options.redirects)

  // The pages capsa.auth.routes guards: the route middleware runs on them alone, through appMiddleware.
  guardPages((nuxt.options.routeRules ??= {}) as Record<string, RouteRule>, options.routes ?? {})

  // Stops the build on a guarded page that a route rule also caches, once every rule is in.
  nuxt.hook('nitro:build:before', nitro => checkCaches(nitro.options.routeRules as Record<string, RouteRule>))

  // The few lines that import the app's rules files and merge them, registered once per side: a virtual module for
  // Nitro, a template for the app. Nuxt refuses `#build` in server code, and the app cannot import a module of Nitro's.
  const abilities = () => renderAbilities(files.abilities)
  addServerTemplate({ filename: '#capsa/auth/abilities', getContents: abilities })
  addTemplate({ filename: 'capsa/auth/abilities.mjs', getContents: abilities })

  // Where better-auth answers: the handler, the server and the client all take it from here.
  const basePath = (options.basePath ?? '/api/auth').replace(/\/$/, '')

  // #capsa/auth (useCapsaAuth, getSession, requireSession, can), and better-auth's handler on the base path.
  addServer(files, basePath)

  // useCapsaSession, the module that creates its client, the route middleware, <Can> and <Cannot>.
  addApp(files, basePath, options.components?.prefix)

  // better-auth's types from both config files, and the rules' names.
  addTypes(files)

  // In dev, creating or deleting a config or rules file changes what is generated: only a restart picks that up.
  restartOnFiles(nuxt, layers)
}

/** The two config files, in the project. */
function configPaths(project: LayerDirectories) {
  return {
    server: join(project.server, 'capsa/auth/config.ts'),
    client: join(project.app, 'capsa/auth.config.ts'),
  }
}

/**
 * The directories that hold rules files: `shared/capsa` of the project and of every layer, the project's first.
 *
 * @example
 * abilitiesDirs(layers)  // ['/app/shared/capsa', '/app/layers/base/shared/capsa']
 */
function abilitiesDirs(layers: LayerDirectories[]) {
  return [...new Set(layers.map(layer => join(layer.shared, 'capsa')))]
}

/**
 * Finds the config files and the rules files. The server config is required: without it better-auth has no way to
 * sign in.
 *
 * @example
 * await findFiles('/app', layers)
 * // { server: '#capsa/root/server/capsa/auth/config', client: undefined, abilities: ['#capsa/root/shared/capsa/abilities'] }
 */
async function findFiles(rootDir: string, layers: LayerDirectories[]): Promise<AuthFiles> {
  const { server, client } = configPaths(layers[0]!)

  if (!existsSync(server)) {
    throw new Error(`[capsa] auth needs ${server}, for example:

import { defineServerAuthConfig } from 'nuxt-capsa/auth'

export default defineServerAuthConfig(() => ({
  emailAndPassword: { enabled: true },
}))
`)
  }

  const abilities = await Promise.all(abilitiesDirs(layers).map(dir => resolveFiles(dir, ABILITIES)))

  return {
    server: rootAlias(rootDir, server),
    client: existsSync(client) ? rootAlias(rootDir, client) : undefined,
    abilities: abilities.flat().map(file => rootAlias(rootDir, file)),
  }
}

/** Private: the URL, from NUXT_CAPSA_AUTH_URL. Public: the redirects the route middleware reads. */
function writeRuntimeConfig(nuxt: Nuxt, redirects: AuthFeatureOptions['redirects']) {
  const { runtimeConfig } = nuxt.options

  runtimeConfig.capsa = defu(runtimeConfig.capsa || {}, { auth: { url: '' } })
  runtimeConfig.public.capsa = defu(runtimeConfig.public.capsa || {}, { auth: { redirects: defu(redirects, { user: '/login', guest: '/' }) } })
}

/**
 * Attaches the route middleware to each page of `capsa.auth.routes`, with the page's mode as its value. appMiddleware
 * is one of the few routeRules keys Nuxt's client-side matcher keeps, and a falsy value detaches the middleware.
 *
 * @example
 * guardPages(routeRules, { '/dashboard/**': 'user', '/dashboard/public': false })
 * // routeRules['/dashboard/**'].appMiddleware      → { 'capsa-auth': 'user' }
 * // routeRules['/dashboard/public'].appMiddleware  → { 'capsa-auth': false }
 */
function guardPages(routeRules: Record<string, RouteRule>, routes: Record<string, AuthRouteMode>) {
  for (const [path, mode] of Object.entries(routes)) {
    const rule = routeRules[path] ??= {}

    // The route middleware reads the mode back from here: Nuxt only types the value as a boolean.
    rule.appMiddleware = { ...toRecord(rule.appMiddleware), [MIDDLEWARE]: mode as boolean }
  }
}

/** Stops the build on a page that capsa.auth.routes guards and a route rule caches: one visitor's session would reach all. */
function checkCaches(routeRules: Record<string, RouteRule>) {
  for (const [path, rule] of Object.entries(routeRules)) {
    const cached = CACHED.find(key => rule[key])

    // Whichever key the rule was written with, the message names them all.
    if (toRecord(rule.appMiddleware)[MIDDLEWARE] && cached)
      throw new Error(`[capsa] "${path}" is guarded by capsa.auth.routes and cached by a route rule (\`swr\`, \`isr\`, \`cache\`, \`prerender\` or \`static\`): the cached page would carry one visitor's session to all. Drop the cache, or set the path to false in capsa.auth.routes.`)
  }
}

/**
 * appMiddleware in its object form, whichever form it was written in.
 *
 * @example
 * toRecord(['a', 'b'])  // { a: true, b: true }
 */
function toRecord(value: RouteRule['appMiddleware']): Record<string, boolean> {
  if (typeof value === 'string') return { [value]: true }
  if (Array.isArray(value)) return Object.fromEntries(value.map(name => [name, true]))
  return value ?? {}
}

/** Registers #capsa/auth, the plugin that derives its secret, better-auth's handler, and the server's one auto-import. */
function addServer(files: AuthFiles, basePath: string) {
  addServerTemplate({ filename: '#capsa/auth', getContents: () => renderServerModule(files.server, basePath) })
  addNitroPlugin(runtimePath('auth/plugin'))
  addServerHandler({ route: `${basePath}/**`, handler: runtimePath('auth/handler') })
  addServerImports([{ name: 'useCapsaAuth', from: '#capsa/auth' }])
}

/** Registers useCapsaSession, the module that creates its client, the route middleware, and <Can> with <Cannot> when the app has rules. */
function addApp(files: AuthFiles, basePath: string, prefix?: string) {
  addTemplate({ filename: 'capsa/auth/client.mjs', getContents: () => renderClientModule(files.client, basePath) })
  addImports({ name: 'useCapsaSession', from: runtimePath('app/auth/session') })
  addRouteMiddleware({ name: MIDDLEWARE, path: runtimePath('app/auth/middleware') })

  if (files.abilities.length) addComponentExports({ filePath: runtimePath('app/auth/components'), prefix })
}

/** Registers the types: better-auth's and the rules' for app, server and shared code, #capsa/auth's where #capsa/db's are. */
function addTypes(files: AuthFiles) {
  addTypeTemplate({
    filename: 'capsa/auth/types.d.ts',
    getContents: () => renderTypes(files.server, files.client, files.abilities),
  }, { nitro: true, nuxt: true, shared: true })

  addTypeTemplate({ filename: 'capsa/auth/types-server.d.ts', getContents: renderServerTypes }, { nitro: true, nuxt: true })
}

/** Restarts Nuxt when a config or rules file is created or deleted. */
function restartOnFiles(nuxt: Nuxt, layers: LayerDirectories[]) {
  const configs = Object.values(configPaths(layers[0]!))
  const dirs = abilitiesDirs(layers)

  nuxt.hook('builder:watch', async (event, file) => {
    if (event !== 'add' && event !== 'unlink') return

    // shared/capsa/abilities.ts, or a file right inside shared/capsa/abilities/, in any layer.
    const isRules = file.endsWith('.ts') && dirs.some(dir => file === join(dir, 'abilities.ts') || dirname(file) === join(dir, 'abilities'))

    if (configs.includes(file) || isRules) await nuxt.callHook('restart')
  })
}
