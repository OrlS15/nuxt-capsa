import type { ComputedRef, Ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import type { NuxtApp } from '#app'
import { computed, createError, getCurrentInstance, navigateTo, onServerPrefetch, useNuxtApp, useRequestEvent, useRequestFetch, useRequestURL, useRuntimeConfig, useState } from '#imports'
import abilities from '#build/capsa/auth/abilities.mjs'
import { basePath, createClient } from '#build/capsa/auth/client.mjs'
import type { AuthClient, AuthSession, Authorize, Can, ClientAuthDefaults } from '../../auth'
import { judge, shown, type Check } from '../../auth/rules'

/**
 * What `useCapsaSession()` returns, typed from the project's auth configs.
 *
 * Declared, not inferred: a build of the package writes an inferred type down as it is in capsa's repo, where the
 * project's configs do not exist, and an app would get `user` and `client` without its own fields and plugins.
 *
 * @example
 * const { user, client }: CapsaSession = useCapsaSession()
 */
export interface CapsaSession {
  session: Ref<AuthSession['session'] | null>
  user: Ref<AuthSession['user'] | null>
  /** True once the session was read in this page load. */
  resolved: Ref<boolean>
  loggedIn: ComputedRef<boolean>
  signOut: (options?: { redirectTo?: RouteLocationRaw }) => Promise<Awaited<ReturnType<AuthClient['signOut']>>>
  fetchSession: () => Promise<AuthSession | null>
  can: Can
  cannot: Can
  authorize: Authorize
  client: AuthClient
}

/**
 * The visitor's session, better-auth's client to change it, and `can`, `cannot` and `authorize` to ask the app's rules.
 *
 * The session is read only where it is used: a component that calls this makes the server read it once before the
 * page renders, and the browser read it in the background after a client-side navigation. A page that never calls
 * it costs no read. Everything it returns is built once per app, so a list of components that call it stays cheap.
 *
 * @example
 * const { user, loggedIn, client, signOut, can, cannot, authorize } = useCapsaSession()
 */
export function useCapsaSession(): CapsaSession {
  const nuxtApp = useNuxtApp() as NuxtApp & { _capsaSession?: ReturnType<typeof createSession> }
  const { api, read } = nuxtApp._capsaSession ??= createSession()

  // A component asks for the session: the server waits for it before rendering, the browser reads it in the background.
  if (!api.resolved.value && getCurrentInstance()) {
    if (import.meta.server) onServerPrefetch(read)
    else void read()
  }

  return api
}

/** Builds the app's session state and the functions over it, once per app: per request on the server. */
function createSession() {
  const session = useState<AuthSession['session'] | null>('capsa:auth:session', () => null)
  const user = useState<AuthSession['user'] | null>('capsa:auth:user', () => null)
  // True once read in this page load: `null` alone cannot tell "never read" from "anonymous".
  const resolved = useState('capsa:auth:resolved', () => false)
  const event = import.meta.server ? useRequestEvent() : undefined

  // better-auth sits on the base path, under app.baseURL like every server route. Without an origin, as on
  // the server, the client would ignore basePath.
  const defaults = { baseURL: useRequestURL().origin, basePath: `${useRuntimeConfig().app.baseURL.replace(/\/$/, '')}${basePath}` }

  // Typed here: in an app, the module is the generated JavaScript itself, which carries no types.
  const client: AuthClient = createClient(event ? inProcess(defaults) : defaults)

  // Re-reads after sign-in, sign-up, sign-out, updateUser...: better-auth signals each, and listening costs no request.
  if (import.meta.client) client.$store.atoms.$sessionSignal?.listen(() => fetchSession())

  // The read in flight, shared by every component and by authorize: one read however many ask at once.
  let reading: Promise<AuthSession | null> | undefined
  const read = () => reading ??= fetchSession().finally(() => {
    reading = undefined
  })

  async function fetchSession() {
    const { data, error } = await client.getSession({
      fetchOptions: {
        // During SSR, a cookie better-auth refreshed reaches the browser with the page.
        onResponse: event
          ? ({ response }) => {
              for (const cookie of response.headers.getSetCookie())
                event.res.headers.append('set-cookie', cookie)
            }
          : undefined,
      },
    })

    // Typed from the server config: the client alone does not know the fields the server adds, like additionalFields.
    const identity = (data ?? null) as AuthSession | null

    session.value = identity?.session ?? null
    user.value = identity?.user ?? null
    // On error it stays unresolved, so the next use tries again.
    resolved.value = !error

    return identity
  }

  async function signOut({ redirectTo }: { redirectTo?: RouteLocationRaw } = {}) {
    const result = await client.signOut()

    session.value = null
    user.value = null

    if (redirectTo) await navigateTo(redirectTo)

    return result
  }

  /** Whether a rule lets the visitor in: unknown until the session is read and every argument has arrived. */
  function allows(check: Check, args: unknown[]) {
    return resolved.value && !args.includes(undefined) ? judge(abilities, user.value, check, args) === null : undefined
  }

  const can = ((check: Check, ...args: unknown[]) => allows(check, args)) as Can

  const cannot = ((check: Check, ...args: unknown[]) => {
    const allowed = allows(check, args)

    return allowed === undefined ? undefined : !allowed
  }) as Can

  // A page decides on the spot, so it waits for the session's read, the one in flight when there is one.
  const authorize = (async (check: Check, ...args: unknown[]) => {
    if (!resolved.value) await read()

    // An argument still missing, such as data that never arrived, leaves nothing to authorize.
    const refusal = args.includes(undefined) ? { status: 404 } : judge(abilities, user.value, check, args)

    if (refusal) throw createError({ status: refusal.status, data: shown(refusal), fatal: true })
  }) as Authorize

  const api = {
    session,
    user,
    resolved,
    loggedIn: computed(() => !!session.value),
    signOut,
    fetchSession,
    can,
    cannot,
    authorize,
    client,
  }

  return { api, read }
}

/**
 * The client's defaults on the server: with a fetch that calls Nitro in-process, carrying the page request's cookie.
 * Only the path is kept, because better-auth's client may build an absolute URL from variables like VERCEL_URL, and
 * that one would leave the process.
 */
function inProcess(defaults: ClientAuthDefaults): ClientAuthDefaults {
  // The `native` fetch of Nuxt's useRequestFetch forwards the page request's headers, and answers with the raw
  // Response better-auth's client reads. TypedFetch leaves `native` out of its type.
  const { native } = useRequestFetch() as unknown as { native: typeof fetch }
  const customFetchImpl = ((input, init) => native(pathOf(input), init)) as typeof fetch

  return { ...defaults, fetchOptions: { customFetchImpl } }
}

/**
 * The path and query of a URL better-auth's client built.
 *
 * @example
 * pathOf('https://x.vercel.app/api/auth/get-session?a=1')  // '/api/auth/get-session?a=1'
 */
function pathOf(input: RequestInfo | URL) {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
  return url.pathname + url.search
}
