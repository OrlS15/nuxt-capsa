import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h, ref, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthClient, AuthSession, ClientAuthDefaults } from '../../src/runtime/auth'
import type { CapsaSession } from '../../src/runtime/app/auth/session'

/**
 * The Nuxt app as far as capsa's app code reaches it, set by each test: the app the session hangs on, the component
 * that asks, the page request on the server, and what `#imports` hands out.
 */
const app = vi.hoisted(() => ({
  nuxtApp: {} as object,
  states: new Map<string, { value: unknown }>(),
  instance: null as object | null,
  prefetches: [] as (() => Promise<unknown>)[],
  event: undefined as { res: { headers: Headers } } | undefined,
  native: undefined as unknown,
  baseURL: '/',
  routeRules: {} as Record<string, object>,
  navigateTo: undefined as unknown as (to: unknown) => unknown,
  createClient: undefined as unknown as (defaults: ClientAuthDefaults) => AuthClient,
  // What useCapsaSession hands the route middleware and <Can>, which take it from the session module.
  session: undefined as unknown,
}))

// The app's rules, as #build/capsa/auth/abilities.mjs exports them once merged.
const rules = vi.hoisted(() => ({
  schedule: (user: { plan?: string }) => user.plan === 'pro' || 'PRO_REQUIRED',
  post: { edit: (user: { id: string }, post: { authorId: string }) => user.id === post.authorId || 'NOT_THE_AUTHOR' },
  projects: { create: (_: unknown, count: number) => count < 3 || { [Symbol.for('capsa.denial')]: true, code: 'LIMIT_REACHED', status: 429, details: { limit: 3 } } },
}))

vi.mock('#imports', async () => {
  const { computed, ref } = await import('vue')

  return {
    computed,
    useState: (key: string, init: () => unknown) => app.states.get(key) ?? app.states.set(key, ref(init())).get(key),
    useNuxtApp: () => app.nuxtApp,
    getCurrentInstance: () => app.instance,
    onServerPrefetch: (read: () => Promise<unknown>) => app.prefetches.push(read),
    useRequestEvent: () => app.event,
    useRequestURL: () => new URL('http://localhost:3000/some/page?q=1'),
    useRequestFetch: () => ({ native: app.native }),
    useRuntimeConfig: () => ({ app: { baseURL: app.baseURL }, public: { capsa: { auth: { redirects: { user: '/login', guest: '/dashboard' } } } } }),
    navigateTo: (to: unknown) => app.navigateTo(to),
    createError: (input: object) => Object.assign(new Error('refused'), input),
    defineNuxtRouteMiddleware: <M>(middleware: M) => middleware,
    getRouteRules: ({ path }: { path: string }) => app.routeRules[path] ?? {},
  }
})
vi.mock('#build/capsa/auth/abilities.mjs', () => ({ default: rules }))
vi.mock('#build/capsa/auth/client.mjs', () => ({ basePath: '/api/auth', createClient: (defaults: ClientAuthDefaults) => app.createClient(defaults) }))
vi.mock('../../src/runtime/app/auth/session', () => ({ useCapsaSession: () => app.session }))

const ada = { id: 'ada', name: 'Ada', plan: 'free' }
const signedIn = { session: { id: 'session' }, user: ada } as unknown as AuthSession

/**
 * better-auth's client as capsa calls it: reads that answer `session`, a sign-out, and the signal better-auth sends
 * after each change.
 */
function stubClient(session: AuthSession | null = null) {
  const listeners: (() => void)[] = []
  const client = {
    getSession: vi.fn<AuthClient['getSession']>(async () => ({ data: session, error: null })),
    signOut: vi.fn(async () => ({ success: true })),
    $store: { atoms: { $sessionSignal: { listen: (listener: () => void) => void listeners.push(listener) } } },
  } satisfies AuthClient

  app.createClient = vi.fn((_: ClientAuthDefaults) => client)

  return { client, signal: () => listeners.forEach(listener => listener()) }
}

const sessionSource = fileURLToPath(new URL('../../src/runtime/app/auth/session.ts', import.meta.url))
const loaded = new Map<string, Promise<{ useCapsaSession: () => CapsaSession }>>()

/**
 * Loads session.ts as Nuxt builds it for one side: `import.meta.server` and `import.meta.client` written in, its own
 * imports pointed at capsa's runtime, and `#imports` and `#build` taken from the mocks above.
 *
 * @example
 * const { useCapsaSession } = await sessionOn('server')
 */
function sessionOn(side: 'server' | 'client') {
  return loaded.get(side) ?? loaded.set(side, (async () => {
    const { default: ts } = await import('typescript')
    const { outputText } = ts.transpileModule(await readFile(sessionSource, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    const code = outputText
      .replaceAll('import.meta.server', String(side === 'server'))
      .replaceAll('import.meta.client', String(side === 'client'))
      .replace(/from '(\.[^']+)'/g, (_, path: string) => `from '${join(sessionSource, '..', path)}'`)
    const tmp = fileURLToPath(new URL('../../.tmp', import.meta.url))

    await mkdir(tmp, { recursive: true })
    const file = join(await mkdtemp(join(tmp, 'session-')), `${side}.mjs`)
    await writeFile(file, code)

    return import(/* @vite-ignore */ file)
  })()).get(side)!
}

/** Lets the reads in flight settle. */
const settled = () => new Promise(resolve => setTimeout(resolve))

beforeEach(() => {
  Object.assign(app, { nuxtApp: {}, states: new Map(), instance: null, prefetches: [], event: undefined, native: undefined, baseURL: '/', routeRules: {} })
  app.navigateTo = vi.fn()
})

describe('useCapsaSession', () => {
  it('reads the session once however many components ask at once, and never again once it is read', async () => {
    const { client } = stubClient(signedIn)
    const { useCapsaSession } = await sessionOn('client')
    app.instance = {}

    const session = useCapsaSession()
    expect(useCapsaSession()).toBe(session)
    useCapsaSession()
    await settled()

    expect(client.getSession).toHaveBeenCalledOnce()
    expect(session).toMatchObject({ user: { value: ada }, session: { value: { id: 'session' } }, resolved: { value: true }, loggedIn: { value: true } })

    useCapsaSession()
    expect(client.getSession).toHaveBeenCalledOnce()
  })

  it('reads nothing where no component asks, as a page that never uses the session', async () => {
    const { client } = stubClient(signedIn)
    const { useCapsaSession } = await sessionOn('client')

    useCapsaSession()
    await settled()

    expect(client.getSession).not.toHaveBeenCalled()
  })

  it('stays unresolved when a read fails, and reads again on the next use', async () => {
    const { client } = stubClient()
    client.getSession.mockResolvedValueOnce({ data: null, error: { status: 500 } })
    const { useCapsaSession } = await sessionOn('client')
    app.instance = {}

    const session = useCapsaSession()
    await settled()
    expect(session.resolved.value).toBe(false)

    useCapsaSession()
    await settled()
    expect(client.getSession).toHaveBeenCalledTimes(2)
    expect(session.resolved.value).toBe(true)
  })

  it('reads again in the browser when better-auth signals a change, such as a sign-in', async () => {
    const { client, signal } = stubClient()
    const { useCapsaSession } = await sessionOn('client')

    const session = useCapsaSession()
    client.getSession.mockResolvedValue({ data: signedIn, error: null })
    signal()
    await settled()

    expect(session.user.value).toEqual(ada)
  })

  it('creates the client on the page\'s origin, at the base path under app.baseURL', async () => {
    stubClient()
    const { useCapsaSession } = await sessionOn('client')
    app.baseURL = '/app/'

    useCapsaSession()

    expect(app.createClient).toHaveBeenCalledExactlyOnceWith({ baseURL: 'http://localhost:3000', basePath: '/app/api/auth' })
  })

  it('on the server, calls Nitro in-process with only the path, whatever origin better-auth\'s client builds', async () => {
    stubClient()
    const { useCapsaSession } = await sessionOn('server')
    app.event = { res: { headers: new Headers() } }
    app.native = vi.fn(async () => new Response())

    useCapsaSession()
    const [defaults] = vi.mocked(app.createClient).mock.calls[0] as [ClientAuthDefaults]
    const init = { method: 'POST' }
    await defaults.fetchOptions!.customFetchImpl('https://x.vercel.app/api/auth/get-session?a=1', init)
    await defaults.fetchOptions!.customFetchImpl(new Request('https://x.vercel.app/api/auth/sign-out'))

    expect(defaults).toMatchObject({ baseURL: 'http://localhost:3000', basePath: '/api/auth' })
    expect(app.native).toHaveBeenNthCalledWith(1, '/api/auth/get-session?a=1', init)
    expect(app.native).toHaveBeenNthCalledWith(2, '/api/auth/sign-out', undefined)
  })

  it('on the server, waits for the read before the page renders, and passes a refreshed cookie on to the page\'s response', async () => {
    const { client } = stubClient(signedIn)
    client.getSession.mockImplementation(async (options) => {
      options!.fetchOptions!.onResponse!({ response: new Response(null, { headers: [['set-cookie', 'token=refreshed']] }) })
      return { data: signedIn, error: null }
    })
    const { useCapsaSession } = await sessionOn('server')
    app.event = { res: { headers: new Headers() } }
    app.instance = {}

    const session = useCapsaSession()
    expect(client.getSession).not.toHaveBeenCalled()

    await Promise.all(app.prefetches.map(read => read()))

    expect(client.getSession).toHaveBeenCalledOnce()
    expect(session.user.value).toEqual(ada)
    expect(app.event.res.headers.getSetCookie()).toEqual(['token=refreshed'])
  })

  it('asks the rules with can and cannot: unknown until the session is read and every argument has arrived', async () => {
    stubClient(signedIn)
    const { useCapsaSession } = await sessionOn('client')

    const { can, cannot, fetchSession } = useCapsaSession()
    expect(can('schedule' as never)).toBeUndefined()

    await fetchSession()

    expect(can('schedule' as never)).toBe(false)
    expect(cannot('schedule' as never)).toBe(true)
    expect(can('post.edit' as never, { authorId: 'ada' } as never)).toBe(true)
    expect(can('post.edit' as never, undefined as never)).toBeUndefined()
    expect(cannot('post.edit' as never, undefined as never)).toBeUndefined()
  })

  it('authorizes once the session is read, and turns away with the rule\'s status and refusal, or a 404 for an argument that never arrived', async () => {
    const { client } = stubClient(signedIn)
    const { useCapsaSession } = await sessionOn('client')
    const { authorize } = useCapsaSession()

    await expect(authorize('projects.create' as never, 1 as never)).resolves.toBeUndefined()
    expect(client.getSession).toHaveBeenCalledOnce()

    await expect(authorize('projects.create' as never, 5 as never)).rejects.toMatchObject({ status: 429, fatal: true, data: { code: 'LIMIT_REACHED', details: { limit: 3 } } })
    await expect(authorize('post.edit' as never, undefined as never)).rejects.toMatchObject({ status: 404, fatal: true, data: {} })
    expect(client.getSession).toHaveBeenCalledOnce()
  })

  it('signs out, forgets the session, and goes where it is told', async () => {
    const { client } = stubClient(signedIn)
    const { useCapsaSession } = await sessionOn('client')
    const { fetchSession, signOut, user, loggedIn } = useCapsaSession()
    await fetchSession()

    expect(await signOut({ redirectTo: '/login' })).toEqual({ success: true })

    expect(client.signOut).toHaveBeenCalledOnce()
    expect(user.value).toBeNull()
    expect(loggedIn.value).toBe(false)
    expect(app.navigateTo).toHaveBeenCalledExactlyOnceWith('/login')
  })
})

describe('the route middleware', () => {
  /** A session as the middleware reads it, whose read signs the visitor in when `after` says so. */
  function session({ resolved = true, user = false, after = user }: { resolved?: boolean, user?: boolean, after?: boolean }) {
    const loggedIn = ref(user)
    const fetchSession = vi.fn(async () => void (loggedIn.value = after))

    app.session = { loggedIn, resolved: ref(resolved), fetchSession }

    return fetchSession
  }

  /** Runs the middleware on a page with the mode capsa.auth.routes gave it. */
  async function visit(path: string, mode?: string | boolean) {
    const { default: middleware } = await import('../../src/runtime/app/auth/middleware')
    app.routeRules[path] = { appMiddleware: { 'capsa-auth': mode } }

    return (middleware as unknown as (to: { path: string }) => Promise<unknown>)({ path })
  }

  it('sends a signed-out visitor from a user page to the login, after reading the session again', async () => {
    const fetchSession = session({ user: false })

    await visit('/dashboard', 'user')

    expect(fetchSession).toHaveBeenCalledOnce()
    expect(app.navigateTo).toHaveBeenCalledExactlyOnceWith('/login')
  })

  // Right after a sign-in, better-auth updates the state only once the call has resolved.
  it('lets in a visitor whom reading the session again finds signed in', async () => {
    session({ user: false, after: true })

    await visit('/dashboard', 'user')

    expect(app.navigateTo).not.toHaveBeenCalled()
  })

  it('sends a signed-in visitor from a guest page away, and reads nothing more when the session is known', async () => {
    const fetchSession = session({ user: true })

    await visit('/login', 'guest')

    expect(fetchSession).not.toHaveBeenCalled()
    expect(app.navigateTo).toHaveBeenCalledExactlyOnceWith('/dashboard')
  })

  it('reads the session first when it is not known yet', async () => {
    const fetchSession = session({ resolved: false, user: false, after: false })

    await visit('/login', 'guest')

    expect(fetchSession).toHaveBeenCalledOnce()
    expect(app.navigateTo).not.toHaveBeenCalled()
  })

  it('treats any mode but guest as a user page, and never redirects a page to itself', async () => {
    session({ user: false })

    await visit('/somewhere', true)
    expect(app.navigateTo).toHaveBeenCalledExactlyOnceWith('/login')

    await visit('/login', 'user')
    expect(app.navigateTo).toHaveBeenCalledOnce()
  })
})

describe('<Can> and <Cannot>', () => {
  /** Renders a component on the server with the session in the given state, as text: Vue's comment markers left out. */
  async function render(component: Component, props: object, { resolved = true, user = ada as object | null } = {}) {
    app.session = { user: ref(user), resolved: ref(resolved) }
    const slots = {
      default: (refusal?: { code: string }) => refusal ? `refused: ${refusal.code}` : 'allowed',
      denied: ({ code, details }: { code: string, details?: { limit: number } }) => `denied: ${code}${details ? ` under ${details.limit}` : ''}`,
    }

    return (await renderToString(createSSRApp({ render: () => h(component, props, slots) }))).replace(/<!--[^>]*-->/g, '')
  }

  it('shows <Can>\'s content when the rule lets in, #denied with the refusal when not, and nothing while unknown', async () => {
    const { Can } = await import('../../src/runtime/app/auth/components')

    expect(await render(Can, { do: 'post.edit', with: { authorId: 'ada' } })).toBe('allowed')
    expect(await render(Can, { do: 'projects.create', with: 5 })).toBe('denied: LIMIT_REACHED under 3')
    expect(await render(Can, { do: 'schedule' }, { user: null })).toBe('denied: SIGNED_OUT')
    expect(await render(Can, { do: 'schedule' }, { resolved: false })).toBe('')
    // An argument still undefined, like data on its way, decides nothing yet.
    expect(await render(Can, { do: 'post.edit' })).toBe('')
  })

  it('shows <Cannot>\'s content with the refusal only when the rule turns away', async () => {
    const { Cannot } = await import('../../src/runtime/app/auth/components')

    expect(await render(Cannot, { do: 'schedule' })).toBe('refused: PRO_REQUIRED')
    expect(await render(Cannot, { do: 'post.edit', with: { authorId: 'ada' } })).toBe('')
    expect(await render(Cannot, { do: 'post.edit' })).toBe('')
  })
})
