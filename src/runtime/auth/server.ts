import { STATUS_CODES } from 'node:http'
import { createError, deriveSecret, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import type { AbilityCheck, AbilityCheckArgs, AbilityName, AbilityOf, AuthInstance, AuthSession, AuthUser, Rules, ServerAuthDefaults } from './index'
import { judge, shown, type Check, type Refusal } from './rules'

/**
 * What `#capsa/auth` exports, which only the server can import. Written as methods, so each one's description
 * shows where it is called.
 */
export interface AuthServer {
  /** The better-auth instance, built on first use from runtime config and server/capsa/auth/config.ts. */
  useCapsaAuth(): AuthInstance
  /** Resolves once the auth secret is known: requests wait for it, code outside one awaits it. */
  authReady(): Promise<void>
  /** The request's session, read once per request, or null for an anonymous visitor. */
  getSession(event: RequestEvent): Promise<AuthSession | null>
  /** The request's session, or a 401. */
  requireSession(event: RequestEvent): Promise<AuthSession>
  /**
   * The request's session if a rule lets the visitor in, named or written in place; else a 401, a 403 or the
   * rule's own status. A guest rule lets guests in, so the session may then be null.
   */
  requireSession<const C extends AbilityCheck>(event: RequestEvent, check: C, ...args: AbilityCheckArgs<C>):
  Promise<[C] extends [AbilityName] ? AbilityOf<C> extends { guest: true } ? AuthSession | null : AuthSession : AuthSession>
  /** Whether a user may do something; null or undefined stands for a guest. */
  can<const C extends AbilityCheck>(user: AuthUser | null | undefined, check: C, ...args: AbilityCheckArgs<C>): boolean
  /** Whether a user may not do something; null or undefined stands for a guest. */
  cannot<const C extends AbilityCheck>(user: AuthUser | null | undefined, check: C, ...args: AbilityCheckArgs<C>): boolean
  /** Throws the rule's refusal, as requireSession does, when a user may not do something. */
  authorize<const C extends AbilityCheck>(user: AuthUser | null | undefined, check: C, ...args: AbilityCheckArgs<C>): void
}

/**
 * What `#capsa/auth` hands over, which only the project's build has: its own better-auth and config, and its rules.
 * better-auth is never imported here, so it stays the project's dependency.
 */
export interface AuthParts {
  /** `betterAuth` of the project's better-auth. */
  betterAuth: (options: object) => AuthInstance
  /** `env` of the project's better-auth: the variables as better-auth itself reads them. */
  env: Record<string, string | undefined>
  /** The project's `server/capsa/auth/config.ts`. */
  config: (defaults: ServerAuthDefaults) => object
  /** The app's rules, merged. */
  abilities: Rules
  /** `capsa.auth.basePath`. */
  basePath: string
}

/**
 * Makes the server side of auth: the better-auth instance, built on first use, the session of a request, and the
 * app's rules.
 *
 * @example
 * export const { useCapsaAuth, authReady, getSession, requireSession, can, cannot, authorize } = defineAuth({ betterAuth, env, config, abilities, basePath })
 */
export function defineAuth(parts: AuthParts): AuthServer {
  const { abilities, env } = parts
  let instance: AuthInstance | undefined
  let secret: string | undefined
  let deriving: Promise<void> | undefined
  let failure: Error | undefined

  function useCapsaAuth() {
    // authReady sets it before every request: outside one, a caller awaits authReady first.
    if (secret === undefined) throw failure ?? new Error('[capsa] useCapsaAuth() ran before the auth secret was derived. Outside a request, await authReady() first.')

    return instance ??= createAuth(parts, secret)
  }

  // The secret better-auth signs and encrypts with, found once. A failed attempt is forgotten, so the next request
  // tries again, and useCapsaAuth throws its error meanwhile. The server logs the first failure: the response only
  // reaches the caller.
  function authReady() {
    return deriving ??= findSecret().then(
      (derived) => {
        secret = derived
      },
      (error: Error) => {
        if (!failure) console.error('[capsa] auth cannot derive its secret:', error.message)
        deriving = undefined
        failure = error
        throw error
      },
    )
  }

  // The one capsa derives from NUXT_APP_SECRET, unless the project set better-auth's own variables, which better-auth
  // reads by itself: BETTER_AUTH_SECRET takes its place, and BETTER_AUTH_SECRETS can do without it. None is then ''.
  async function findSecret() {
    if (env.BETTER_AUTH_SECRET) return ''

    return deriveSecret('nuxt-capsa:auth').catch((error: Error) => {
      if (!env.BETTER_AUTH_SECRETS) throw error

      return ''
    })
  }

  // One read per request, however many handlers and utils ask for it: it lives and goes with the event.
  function getSession(event: RequestEvent) {
    const context = event.context as { capsaSession?: Promise<AuthSession | null> }

    return context.capsaSession ??= readSession(event)
  }

  async function readSession(event: RequestEvent) {
    const { headers, response } = await useCapsaAuth().api.getSession({ headers: event.req.headers, returnHeaders: true })

    // A session better-auth refreshed reaches the browser with this response.
    for (const cookie of headers.getSetCookie())
      event.res.headers.append('set-cookie', cookie)

    return response
  }

  // A 401 without a session; with a rule, also its refusal. A guest rule lets guests in.
  async function requireSession(event: RequestEvent, check?: Check, ...args: unknown[]) {
    const session = await getSession(event)

    refuse(judge(abilities, session?.user ?? null, check, args))

    return session
  }

  function can(user: AuthUser | null | undefined, check: Check, ...args: unknown[]) {
    return judge(abilities, user ?? null, check, args) === null
  }

  function authorize(user: AuthUser | null | undefined, check: Check, ...args: unknown[]) {
    refuse(judge(abilities, user ?? null, check, args))
  }

  // The phrase goes on the status line: without one, the server writes "Server Error" even for a 403. The code and
  // details go in data as <Can>'s #denied receives them, so a page handles both alike.
  function refuse(refusal: Refusal | null) {
    if (refusal) throw createError({ status: refusal.status, statusText: STATUS_CODES[refusal.status], data: shown(refusal) })
  }

  return {
    useCapsaAuth,
    authReady,
    getSession,
    requireSession,
    can,
    cannot: (user: AuthUser | null | undefined, check: Check, ...args: unknown[]) => !can(user, check, ...args),
    authorize,
    // Each function takes any check: which arguments follow which rule is what the types of `AuthServer` say.
  } as AuthServer
}

/** Builds the better-auth instance from capsa's defaults and the project's config. */
function createAuth({ betterAuth, config, basePath }: AuthParts, secret: string) {
  const { app, capsa } = useRuntimeConfig()

  const defaults = {
    baseURL: (capsa as { auth: { url: string } }).auth.url || undefined,
    // capsa.auth.basePath, under app.baseURL like every server route.
    basePath: app.baseURL.replace(/\/$/, '') + basePath,
  }

  // Set after the config, which can move neither: the handler, the server and the client agree on the base path,
  // and the secret comes from the environment: without one of capsa's, better-auth reads its own variables. A project
  // that rotates its secrets sets better-auth's own `secrets`, which better-auth then works with, reading with this
  // one what it encrypted before.
  return betterAuth({ ...config(defaults), basePath: defaults.basePath, secret: secret || undefined })
}
