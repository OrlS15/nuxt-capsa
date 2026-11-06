import { readFile } from 'node:fs/promises'
import type { betterAuth } from 'better-auth'
import { createError, deriveSecret, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { defineClientAuthConfig, defineServerAuthConfig, deny, guest } from '../../src/runtime/auth'
import type { AuthSession, AuthUser, Rules, ServerAuthDefaults } from '../../src/runtime/auth'
import { argsOf, judge, mergeAbilities, shown } from '../../src/runtime/auth/rules'
import { defineAuth, type AuthParts } from '../../src/runtime/auth/server'
import { runtimePath } from '../../src/utils'
import { runModule } from '../helpers/nuxt'

// capsa's server runtime imports these from Nuxt itself, and no Nuxt runs here.
vi.mock('nuxt/server', () => ({
  createError: vi.fn((input: object) => Object.assign(new Error('refused'), input)),
  defineEventHandler: <H>(handler: H) => handler,
  deriveSecret: vi.fn(),
  useRuntimeConfig: vi.fn(),
}))

// The instance the handler reaches through #capsa/auth.
const fromCapsaAuth = vi.hoisted(() => ({ handler: vi.fn() }))
vi.mock('#capsa/auth', () => ({ useCapsaAuth: () => fromCapsaAuth }))

const ada = { id: 'ada', name: 'Ada', plan: 'free' } as AuthUser
const post = { authorId: 'ada', published: false }

const rules = mergeAbilities([
  { schedule: (user: AuthUser) => user.plan === 'pro' || 'PRO_REQUIRED' },
  {
    post: {
      view: guest((user, p: typeof post) => p.published || user?.id === p.authorId || deny('NOT_FOUND', { status: 404 })),
      edit: (user: AuthUser, p: typeof post) => user.id === p.authorId || 'NOT_THE_AUTHOR',
    },
  },
  { post: { remove: () => false }, projects: { create: (_: AuthUser, count: number) => count < 3 || deny('LIMIT_REACHED', { status: 429, details: { limit: 3 } }) } },
  { org: { transfer: (_: AuthUser, from: string, to: string) => from !== to }, broken: () => { throw new Error('db down') } },
] as Rules[])

describe('rules', () => {
  it('merges every file into one set, groups included, and stops on a name defined twice or holding a dot', () => {
    expect(Object.keys(rules.post!)).toEqual(['view', 'edit', 'remove'])
    expect(() => mergeAbilities([{ post: { edit: () => true } }, { post: { edit: () => true } }])).toThrow('[capsa] ability "post.edit" is defined in more than one place.')
    expect(() => mergeAbilities([{ post: () => true }, { post: { edit: () => true } }])).toThrow('"post" is defined in more than one place')
    expect(() => mergeAbilities([{ 'post.edit': () => true }])).toThrow('a name cannot hold a dot')
  })

  it('lets in only on true, and turns away with false, a code, or deny() with its status and details', () => {
    expect(judge(rules, ada, 'post.edit', [post])).toBeNull()
    expect(judge(rules, ada, 'post.remove', [])).toEqual({ status: 403 })
    expect(judge(rules, ada, 'schedule', [])).toEqual({ status: 403, code: 'PRO_REQUIRED' })
    expect(judge(rules, ada, 'projects.create', [5])).toEqual({ code: 'LIMIT_REACHED', status: 429, details: { limit: 3 } })
    expect(judge(rules, ada, () => 'true', [])).toEqual({ status: 403, code: 'true' })
  })

  it('turns a guest away before a rule that is not for guests runs, and runs a guest rule with no user', () => {
    expect(judge(rules, null, undefined, [])).toEqual({ code: 'SIGNED_OUT', status: 401 })
    expect(judge(rules, ada, undefined, [])).toBeNull()
    expect(judge(rules, null, 'broken', [])).toEqual({ code: 'SIGNED_OUT', status: 401 })
    expect(judge(rules, null, () => true, [])).toEqual({ code: 'SIGNED_OUT', status: 401 })
    expect(judge(rules, null, 'post.view', [post])).toEqual({ code: 'NOT_FOUND', status: 404, details: undefined })
    expect(judge(rules, null, 'post.view', [{ ...post, published: true }])).toBeNull()
  })

  it('never lets in when a rule throws, or when a name is not a rule', () => {
    expect(() => judge(rules, ada, 'broken', [])).toThrow('db down')
    expect(() => judge(rules, ada, 'post', [])).toThrow('[capsa] there is no ability named "post".')
    expect(() => judge(rules, ada, 'post.nope', [])).toThrow('[capsa] there is no ability named "post.nope".')
  })

  it('turns away a rule that returns a promise anyway', () => {
    // Past the types, from plain JavaScript: a promise is not `true`.
    expect(judge(rules, ada, (async () => true) as never, [])).toEqual({ status: 403 })
  })

  it('reads <Can :with> by the rule\'s arity: nothing, the value, or the list', () => {
    expect(argsOf(rules, 'schedule', undefined)).toEqual([])
    expect(argsOf(rules, 'post.edit', post)).toEqual([post])
    // guest() keeps the length of the rule it wraps.
    expect(argsOf(rules, 'post.view', post)).toEqual([post])
    expect(argsOf(rules, 'org.transfer', ['a', 'b'])).toEqual(['a', 'b'])
    expect(argsOf(rules, 'org.transfer', undefined)).toEqual([undefined])
  })

  it('opens a copy of the rule to guests, and leaves the rule itself closed', () => {
    const own = (user: AuthUser | null) => !!user
    const open = mergeAbilities([{ open: guest(own), closed: own }] as Rules[])

    expect(judge(open, null, 'open', [])).toEqual({ status: 403 })
    expect(judge(open, null, 'closed', [])).toEqual({ code: 'SIGNED_OUT', status: 401 })
  })

  it('shows a refusal as its code and details, and leaves the status to HTTP', () => {
    expect(shown({ status: 429, code: 'LIMIT_REACHED', details: { limit: 3 } })).toEqual({ code: 'LIMIT_REACHED', details: { limit: 3 } })
  })
})

describe('auth config files', () => {
  const defaults: ServerAuthDefaults = { baseURL: undefined, basePath: '/api/auth' }

  it('pass capsa\'s defaults in, and merge what the config returns over them', () => {
    const config = defineServerAuthConfig(given => ({ appName: `app with ${given.basePath}`, emailAndPassword: { enabled: true } }))

    expect(config(defaults)).toEqual({ ...defaults, appName: 'app with /api/auth', emailAndPassword: { enabled: true } })
  })

  it('let the config win on a key it sets, and keep the defaults it does not touch', () => {
    const config = defineServerAuthConfig(() => ({ baseURL: 'https://mine.example' }))

    expect(config(defaults)).toEqual({ baseURL: 'https://mine.example', basePath: '/api/auth' })
  })

  it('merge the client config the same way', () => {
    const fetchImpl = (() => {}) as unknown as typeof fetch
    const client = { baseURL: 'http://localhost:3000', basePath: '/api/auth', fetchOptions: { customFetchImpl: fetchImpl } }
    const config = defineClientAuthConfig(() => ({ fetchOptions: { headers: { 'x-app': '1' } } }))

    expect(config(client)).toEqual({ ...client, fetchOptions: { customFetchImpl: fetchImpl, headers: { 'x-app': '1' } } })
  })
})

/** What better-auth's session read answers, as capsa calls it: the session, and the headers with a refreshed cookie. */
const getSession = vi.fn<(context: { headers: Headers, returnHeaders: true }) => Promise<{ headers: Headers, response: AuthSession | null }>>()

/**
 * better-auth's `betterAuth`, typed as the real one: an instance that only reads sessions, and keeps the options it
 * was built with.
 */
const createAuth = vi.fn<typeof betterAuth>(options => ({ options, api: { getSession } }) as never)

/** capsa's server side of auth over the stub, with `parts` over the defaults. */
function auth(parts: Partial<AuthParts> = {}) {
  return defineAuth({ betterAuth: createAuth, env: {}, config: defaults => defaults, abilities: rules, basePath: '/api/auth', ...parts })
}

/** The options capsa built better-auth with. */
const builtWith = (instance: unknown) => (instance as { options: object }).options

/** A request as Nitro hands it over: its headers, the response's, and its own context. */
function event(cookie = '') {
  return { req: new Request('http://localhost/x', { headers: { cookie } }), res: { headers: new Headers() }, context: {} } as unknown as RequestEvent & { res: { headers: Headers } }
}

/** Silences the server log of a failed derivation, and hands back the spy. */
function quietErrors() {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => logged.mockRestore())

  return logged
}

describe('the server side of auth', () => {
  beforeEach(() => {
    vi.mocked(deriveSecret).mockReset().mockResolvedValue('derived from NUXT_APP_SECRET')
    vi.mocked(useRuntimeConfig).mockReturnValue({ app: { baseURL: '/' }, capsa: { auth: { url: '' } } } as never)
    getSession.mockReset()
  })

  afterEach(() => createAuth.mockClear())

  it('builds better-auth on first use and once, keeping capsa\'s base path and its own secret over the config\'s', async () => {
    const server = auth({ basePath: '/auth', config: defaults => ({ ...defaults, basePath: '/elsewhere', secret: 'mine', appName: 'mine' }) })

    await server.authReady()

    expect(server.useCapsaAuth()).toBe(server.useCapsaAuth())
    expect(createAuth).toHaveBeenCalledOnce()
    expect(builtWith(server.useCapsaAuth())).toEqual({ basePath: '/auth', appName: 'mine', baseURL: undefined, secret: 'derived from NUXT_APP_SECRET' })
  })

  it('hands the config no secret and no policy of its own: only the URL and the base path, under app.baseURL', async () => {
    vi.mocked(useRuntimeConfig).mockReturnValue({ app: { baseURL: '/app/' }, capsa: { auth: { url: 'https://app.example.com' } } } as never)
    const config = vi.fn((defaults: ServerAuthDefaults) => defaults)
    const server = auth({ config })

    await server.authReady()
    server.useCapsaAuth()

    expect(config).toHaveBeenCalledExactlyOnceWith({ baseURL: 'https://app.example.com', basePath: '/app/api/auth' })
  })

  // better-auth then signs with the project's first one, and reads with capsa's what it encrypted before.
  it('hands better-auth the secrets a server config returns, next to its own secret', async () => {
    const secrets = [{ version: 2, value: 'the-current-one' }, { version: 1, value: 'the-one-before' }]
    const server = auth({ config: defaults => ({ ...defaults, secrets }) })

    await server.authReady()

    expect(builtWith(server.useCapsaAuth())).toMatchObject({ secrets, secret: 'derived from NUXT_APP_SECRET' })
  })

  // better-auth reads its own variables by itself: capsa hands it no secret over them.
  it('leaves the secret to BETTER_AUTH_SECRET, and to BETTER_AUTH_SECRETS where NUXT_APP_SECRET is missing', async () => {
    // BETTER_AUTH_SECRET wins over NUXT_APP_SECRET, which is then not even derived from.
    const single = auth({ env: { BETTER_AUTH_SECRET: 'the-project-own-secret' } })
    await single.authReady()
    expect(builtWith(single.useCapsaAuth())).toHaveProperty('secret', undefined)
    expect(deriveSecret).not.toHaveBeenCalled()

    // BETTER_AUTH_SECRETS rotates the derived secret where there is one, and stands alone where there is none.
    const rotated = auth({ env: { BETTER_AUTH_SECRETS: '1:the-project-own-secret' } })
    await rotated.authReady()
    expect(builtWith(rotated.useCapsaAuth())).toMatchObject({ secret: 'derived from NUXT_APP_SECRET' })

    vi.mocked(deriveSecret).mockRejectedValue(new Error('`appSecret` is not set.'))
    const alone = auth({ env: { BETTER_AUTH_SECRETS: '1:the-project-own-secret' } })
    await alone.authReady()
    expect(builtWith(alone.useCapsaAuth())).toHaveProperty('secret', undefined)

    // Without any of them auth does not start, and neither does it on a variable that is there but empty.
    quietErrors()
    const none = auth({ env: { BETTER_AUTH_SECRET: '', BETTER_AUTH_SECRETS: '' } })
    await expect(none.authReady()).rejects.toThrow('`appSecret` is not set.')
    expect(() => none.useCapsaAuth()).toThrow('`appSecret` is not set.')
  })

  it('derives the secret once before useCapsaAuth builds better-auth, and tries again after a failure', async () => {
    vi.mocked(deriveSecret)
      .mockRejectedValueOnce(new Error('`appSecret` is not set.'))
      .mockRejectedValueOnce(new Error('`appSecret` is not set.'))
      .mockResolvedValue('derived')
    const logged = quietErrors()
    const server = auth()

    expect(() => server.useCapsaAuth()).toThrow('[capsa] useCapsaAuth() ran before the auth secret was derived. Outside a request, await authReady() first.')

    await expect(server.authReady()).rejects.toThrow('`appSecret` is not set.')
    // The failure is what useCapsaAuth reports, until a later attempt succeeds.
    expect(() => server.useCapsaAuth()).toThrow('`appSecret` is not set.')
    await expect(server.authReady()).rejects.toThrow('`appSecret` is not set.')
    // The server log names it once, not on every request.
    expect(logged.mock.calls).toEqual([['[capsa] auth cannot derive its secret:', '`appSecret` is not set.']])

    await server.authReady()
    await server.authReady()

    expect(builtWith(server.useCapsaAuth())).toMatchObject({ secret: 'derived' })
    expect(deriveSecret).toHaveBeenCalledTimes(3)
    expect(deriveSecret).toHaveBeenCalledWith('nuxt-capsa:auth')
  })

  it('reads the session once per request with the request\'s headers, and passes a refreshed cookie on to the response', async () => {
    const session = { session: { id: 's' }, user: ada } as AuthSession
    getSession.mockResolvedValue({ headers: new Headers([['set-cookie', 'token=refreshed'], ['set-cookie', 'data=cached']]), response: session })
    const server = auth()
    const request = event('token=old')
    await server.authReady()

    const [first, second] = await Promise.all([server.getSession(request), server.getSession(request)])

    expect(first).toBe(session)
    expect(second).toBe(session)
    expect(getSession).toHaveBeenCalledExactlyOnceWith({ headers: request.req.headers, returnHeaders: true })
    expect(request.res.headers.getSetCookie()).toEqual(['token=refreshed', 'data=cached'])

    // Another request reads its own.
    await server.getSession(event())
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('answers 401 from requireSession to a guest, and the rule\'s status, phrase, code and details to a user it turns away', async () => {
    const server = auth()
    await server.authReady()

    getSession.mockResolvedValue({ headers: new Headers(), response: null })
    await expect(server.requireSession(event())).rejects.toMatchObject({ status: 401, statusText: 'Unauthorized', data: { code: 'SIGNED_OUT' } })
    // A guest rule lets a guest in, with no session.
    expect(await server.requireSession(event(), 'post.view' as never, { ...post, published: true })).toBeNull()

    const session = { session: {}, user: ada } as AuthSession
    getSession.mockResolvedValue({ headers: new Headers(), response: session })
    expect(await server.requireSession(event())).toBe(session)
    expect(await server.requireSession(event(), 'post.edit' as never, post)).toBe(session)
    await expect(server.requireSession(event(), 'schedule' as never)).rejects.toMatchObject({ status: 403, statusText: 'Forbidden', data: { code: 'PRO_REQUIRED' } })
    await expect(server.requireSession(event(), 'projects.create' as never, 5)).rejects.toMatchObject({ status: 429, statusText: 'Too Many Requests', data: { code: 'LIMIT_REACHED', details: { limit: 3 } } })
    await expect(server.requireSession(event(), (user: AuthUser) => user.plan === 'pro' || 'PRO_ONLY')).rejects.toMatchObject({ status: 403, data: { code: 'PRO_ONLY' } })
    expect(createError).toHaveBeenLastCalledWith({ status: 403, statusText: 'Forbidden', data: { code: 'PRO_ONLY', details: undefined } })
  })

  it('asks the rules about any user with can, cannot and authorize, null standing for a guest', () => {
    const server = auth()
    const pro = { ...ada, plan: 'pro' } as AuthUser

    expect(server.can(pro, 'schedule' as never)).toBe(true)
    expect(server.cannot(ada, 'schedule' as never)).toBe(true)
    expect(server.can(null, 'post.view' as never, { ...post, published: true })).toBe(true)
    expect(server.can(undefined, 'schedule' as never)).toBe(false)
    expect(() => server.authorize(pro, 'org.transfer' as never, 'a', 'b')).not.toThrow()
    expect(() => server.authorize(ada, 'projects.create' as never, 3)).toThrow(expect.objectContaining({ status: 429, data: { code: 'LIMIT_REACHED', details: { limit: 3 } } }))
  })

  it('answers every request on the base path with better-auth\'s handler', async () => {
    const { default: handler } = await import('../../src/runtime/auth/handler')
    const request = new Request('http://localhost/api/auth/get-session')
    fromCapsaAuth.handler.mockResolvedValue(new Response('ok'))

    await (handler as unknown as (event: { req: Request }) => Promise<Response>)({ req: request })

    expect(fromCapsaAuth.handler).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('makes requests wait for the secret until it is derived, then takes the request hook away', async () => {
    const authReady = vi.fn()
      .mockRejectedValueOnce(new Error('`appSecret` is not set.'))
      .mockRejectedValueOnce(new Error('`appSecret` is not set.'))
      .mockResolvedValue(undefined)
    // Nitro's hooks as far as the plugin uses them: hook() hands back the function that removes it.
    const requestHooks = new Set<() => Promise<unknown>>()
    const hook = (_name: 'request', run: () => Promise<unknown>) => {
      requestHooks.add(run)
      return () => requestHooks.delete(run)
    }
    const settled = () => new Promise(resolve => setTimeout(resolve))
    // Run from its text: the file is plain JavaScript, and only so can import.meta.prerender be set.
    const code = await readFile(`${runtimePath('auth/plugin')}.ts`, 'utf8')
    // Nitro replaces import.meta.prerender when it builds: here by hand, once for a server and once for a prerender.
    const pluginFor = (prerender: boolean) => runModule(code.replace('import.meta.prerender', String(prerender)), {
      'nitro': { definePlugin: (setup: unknown) => setup },
      '#capsa/auth': { authReady },
    }, '__default') as (nitro: object) => void
    const plugin = pluginFor(false)

    // The start cannot derive it, nor can the first request: the hook stays for the next one.
    plugin({ hooks: { hook } })
    await settled()
    const [request] = requestHooks
    await expect(request!()).rejects.toThrow('`appSecret` is not set.')
    expect(requestHooks.size).toBe(1)

    // The first request that derives it removes the hook.
    await request!()
    expect(requestHooks.size).toBe(0)

    // Where the start derives it, no request ever waits.
    plugin({ hooks: { hook } })
    await settled()
    expect(requestHooks.size).toBe(0)

    // A prerender without the secret lets the request through, and stops waiting.
    authReady.mockRejectedValue(new Error('`appSecret` is not set.'))
    pluginFor(true)({ hooks: { hook } })
    await settled()
    await [...requestHooks][0]!()
    expect(requestHooks.size).toBe(0)
  })
})
