import { createHmac } from 'node:crypto'
import { betterAuth, env } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import * as betterAuthVue from 'better-auth/vue'
import { deriveSecret, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderClientModule } from '../../src/auth/templates'
import { defineServerAuthConfig, type AuthSession, type ClientAuthDefaults } from '../../src/runtime/auth'
import { mergeAbilities } from '../../src/runtime/auth/rules'
import { defineAuth } from '../../src/runtime/auth/server'
import { runModule } from '../helpers/nuxt'

/**
 * What capsa takes for granted about better-auth, checked on the real one: in memory, through capsa's own code where
 * there is some, with no server and no network.
 */

vi.mock('nuxt/server', () => ({
  createError: (input: object) => Object.assign(new Error('refused'), input),
  deriveSecret: vi.fn(),
  useRuntimeConfig: vi.fn(),
}))

const ORIGIN = 'http://localhost:3000'
const DERIVED = 'a-secret-derived-from-nuxt-app-secret-0123'
const OWN_SECRET = 'a-secret-of-the-project-0123456789abcdef'
const ADA = { email: 'ada@example.com', password: 'password1234', name: 'Ada' }

/**
 * capsa's server side of auth on the real better-auth, over a database in memory: the config a project would write,
 * with a field of its own and sessions refreshed on every read.
 */
function capsaAuth({ basePath = '/api/auth' } = {}) {
  const config = defineServerAuthConfig(() => ({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    user: { additionalFields: { plan: { type: ['free', 'pro'], required: false, defaultValue: 'free', input: true } } },
    session: { updateAge: 0 },
  }))
  const abilities = mergeAbilities([{ schedule: user => user.plan === 'pro' || 'PRO_REQUIRED' }])

  return defineAuth({ betterAuth, env, config, abilities, basePath })
}

/** A request to better-auth's handler, as the browser sends one. */
function request(path: string, body?: object, cookie = '') {
  return new Request(`${ORIGIN}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'origin': ORIGIN, cookie },
    body: body && JSON.stringify(body),
  })
}

/** The `name=value` pairs a response sets, as a `cookie` header. */
const cookieOf = (response: { headers: Headers }) => response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')

/** A request as Nitro hands it over to capsa: its headers, the response's, and its own context. */
function event(cookie: string) {
  return { req: request('/page', undefined, cookie), res: { headers: new Headers() }, context: {} } as unknown as RequestEvent & { res: { headers: Headers } }
}

/**
 * The client capsa generates, on the real better-auth/vue, calling the handler in-process as capsa's does during SSR,
 * and keeping the cookies it is given as a browser would.
 */
function capsaClient(handler: (request: Request) => Promise<Response>, basePath = '/api/auth') {
  const { createClient } = runModule(renderClientModule(undefined, basePath), { 'better-auth/vue': betterAuthVue }, '{ createClient }') as { createClient: (defaults: ClientAuthDefaults) => ReturnType<typeof betterAuthVue.createAuthClient> }
  let cookie = ''

  const customFetchImpl = (async (input, init) => {
    const sent = new Request(input, init)
    sent.headers.set('cookie', cookie)
    const response = await handler(sent)
    if (response.headers.getSetCookie().length) cookie = cookieOf(response)

    return response
  }) as typeof fetch

  return createClient({ baseURL: ORIGIN, basePath, fetchOptions: { customFetchImpl } })
}

beforeEach(() => {
  vi.mocked(deriveSecret).mockReset().mockResolvedValue(DERIVED)
  vi.mocked(useRuntimeConfig).mockReturnValue({ app: { baseURL: '/' }, capsa: { auth: { url: ORIGIN } } } as never)
})

afterEach(() => void vi.unstubAllEnvs())

describe('better-auth, as capsa builds it', () => {
  it('answers on capsa\'s base path, under app.baseURL, and nowhere else', async () => {
    vi.mocked(useRuntimeConfig).mockReturnValue({ app: { baseURL: '/app/' }, capsa: { auth: { url: ORIGIN } } } as never)
    const auth = capsaAuth({ basePath: '/auth' })
    await auth.authReady()
    const { handler } = auth.useCapsaAuth()

    expect((await handler(request('/app/auth/ok'))).status).toBe(200)
    expect((await handler(request('/app/api/auth/ok'))).status).toBe(404)
    expect((await handler(request('/app/auth/sign-up/email', ADA))).status).toBe(200)
  })

  it('reads a session as { session, user }, with the fields the config adds, and hands back the refreshed cookie for capsa to pass on', async () => {
    const auth = capsaAuth()
    await auth.authReady()
    const signedUp = await auth.useCapsaAuth().handler(request('/api/auth/sign-up/email', ADA))
    const page = event(cookieOf(signedUp))

    const session = await auth.getSession(page)

    expect(Object.keys(session!).sort()).toEqual(['session', 'user'])
    expect(session!.user).toMatchObject({ email: ADA.email, name: 'Ada', plan: 'free' })
    expect(page.res.headers.getSetCookie()).toEqual([expect.stringMatching(/^better-auth\.session_token=/)])
    expect(await auth.getSession(event(''))).toBeNull()
  })

  it('lets capsa turn a signed-in user away by the app\'s rules', async () => {
    const auth = capsaAuth()
    await auth.authReady()
    const signedUp = await auth.useCapsaAuth().handler(request('/api/auth/sign-up/email', ADA))

    await expect(auth.requireSession(event(cookieOf(signedUp)), 'schedule' as never)).rejects.toMatchObject({ status: 403, data: { code: 'PRO_REQUIRED' } })
    await expect(auth.requireSession(event(''))).rejects.toMatchObject({ status: 401 })
  })

  // capsa hands better-auth no secret over its own variables: better-auth has to read them by itself.
  it.each([
    ['NUXT_APP_SECRET', {}, DERIVED],
    ['BETTER_AUTH_SECRET', { BETTER_AUTH_SECRET: OWN_SECRET }, OWN_SECRET],
    ['BETTER_AUTH_SECRETS', { BETTER_AUTH_SECRETS: `1:${OWN_SECRET}` }, OWN_SECRET],
  ])('signs the session cookie with the secret from %s', async (_, variables: Record<string, string>, secret) => {
    for (const [name, value] of Object.entries(variables)) vi.stubEnv(name, value)
    if (Object.keys(variables).length) vi.mocked(deriveSecret).mockRejectedValue(new Error('`appSecret` is not set.'))
    const auth = capsaAuth()
    await auth.authReady()

    const response = await auth.useCapsaAuth().handler(request('/api/auth/sign-up/email', ADA))
    const cookie = response.headers.getSetCookie().find(line => line.startsWith('better-auth.session_token='))!.split(';')[0]!
    const [token, signature] = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).split('.')

    expect(response.status).toBe(200)
    expect(signature).toBe(createHmac('sha256', secret).update(token!).digest('base64'))
  })
})

describe('better-auth\'s client, as capsa creates it', () => {
  it('signs up, reads the session with { data, error } and the response, and signs out, through the handler in-process', async () => {
    const auth = capsaAuth()
    await auth.authReady()
    const client = capsaClient(auth.useCapsaAuth().handler)
    const onResponse = vi.fn<(context: { response: Response }) => void>()

    expect((await client.signUp.email(ADA)).error).toBeNull()

    const read = await client.getSession({ fetchOptions: { onResponse } })
    expect(read.error).toBeNull()
    expect((read.data as AuthSession).user).toMatchObject({ name: 'Ada', plan: 'free' })
    expect(onResponse.mock.calls[0]![0].response).toBeInstanceOf(Response)

    await client.signOut()
    expect(await client.getSession()).toMatchObject({ data: null, error: null })
  })

  it('hands back a failed read as an error with no data, rather than throwing', async () => {
    const client = capsaClient(async () => new Response('down', { status: 500 }))

    expect(await client.getSession()).toMatchObject({ data: null, error: { status: 500 } })
  })

  // An internal of better-auth: useCapsaSession listens to it to read the session again after each change.
  it('signals a change of session after a sign-in and after a sign-out', async () => {
    const auth = capsaAuth()
    await auth.authReady()
    await auth.useCapsaAuth().handler(request('/api/auth/sign-up/email', ADA))
    const client = capsaClient(auth.useCapsaAuth().handler)
    const signals = vi.fn()

    // Optional in better-auth's own types: capsa listens with `?.`, and here it has to be there.
    client.$store.atoms.$sessionSignal!.listen(signals)

    await client.signIn.email({ email: ADA.email, password: ADA.password })
    await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(1))

    await client.signOut()
    await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(2))
  })
})
