import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { $fetch, fetch, getServerLogs, setup, startServer } from '@nuxt/test-utils/e2e'

const root = fileURLToPath(new URL('../fixtures/auth-pglite', import.meta.url))
// The built server runs in the test's cwd: a store of its own, never the repo's `.data`.
const store = await mkdtemp(join(tmpdir(), 'capsa-auth-'))
const env = { NUXT_CAPSA_DB_DEFAULT_CONNECTION: store, NUXT_APP_SECRET: 'a-secret-for-the-e2e-test-0123456789' }
const ADA = { email: 'ada@example.com', password: 'password1234', name: 'Ada' }
const OWN_SECRET = 'a-secret-of-the-project-0123456789abcdef'

/** How many session reads better-auth answered since the server started. */
async function sessionReads() {
  return (await $fetch<{ reads: number }>('/api/session-reads')).reads
}

let signedUp: Promise<string> | undefined

/** Signs Ada up once, and hands back her session cookie. */
function adaCookie() {
  return signedUp ??= fetch('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': 'http://localhost' },
    body: JSON.stringify(ADA),
  }).then((response) => {
    if (response.status !== 200) throw new Error(`sign-up answered ${response.status}`)

    return response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  })
}

/** An API answer's status and the code with data capsa puts in a refusal. */
async function answer(path: string, cookie = '') {
  const response = await fetch(path, { headers: { cookie, accept: 'application/json' } })

  return { status: response.status, body: await response.json() }
}

/** A page's status and where it redirects, without following the redirect, asked for as a browser does. */
async function visit(path: string, cookie = '') {
  // Without text/html, an error answers with JSON instead of the error page.
  const response = await fetch(path, { redirect: 'manual', headers: { cookie, accept: 'text/html' } })

  return { status: response.status, location: response.headers.get('location'), headers: response.headers, html: await response.text() }
}

describe('a built app with better-auth on a pglite source', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(() => rm(store, { recursive: true, force: true }))

  await setup({ rootDir: root, env })

  it('reads no session on a page that never asks for it, and one on a page that does', async () => {
    const before = await sessionReads()
    await visit('/')
    expect(await sessionReads()).toBe(before)

    expect((await visit('/profile')).html).toContain('Not signed in')
    expect(await sessionReads()).toBe(before + 1)
  })

  it('auto-imports useCapsaAuth on the server, and nothing else of #capsa/auth', async () => {
    expect(await $fetch('/api/auto-imports')).toEqual({ handler: 'function', getSession: 'undefined' })
  })

  it('reads the session on the server with the project\'s client config', async () => {
    await visit('/profile')

    expect((await $fetch<{ clientHeader: string | null }>('/api/session-reads')).clientHeader).toBe('yes')
  })

  it('sends anonymous visitors from user pages to the login, and lets a false rule through', async () => {
    expect(await visit('/dashboard')).toMatchObject({ status: 302, location: '/login' })
    // A page whose own route rule stays in force under the guard.
    const settings = await visit('/settings')
    expect(settings).toMatchObject({ status: 302, location: '/login' })
    expect(settings.headers.get('x-settings')).toBe('own-rule')
    expect(await visit('/dashboard/public')).toMatchObject({ status: 200 })
  })

  it('answers 401 from requireSession to an anonymous caller', async () => {
    expect((await fetch('/api/me')).status).toBe(401)
  })

  it('renders a signed-in user on the server, with the fields the server config adds', async () => {
    expect((await visit('/profile', await adaCookie())).html).toContain('Signed in as Ada, on the free plan')
  })

  it('lets a signed-in user into user pages, and sends them away from guest pages', async () => {
    const cookie = await adaCookie()

    expect(await visit('/dashboard', cookie)).toMatchObject({ status: 200, html: expect.stringContaining('Hello Ada') })
    expect(await visit('/login', cookie)).toMatchObject({ status: 302, location: '/dashboard' })
  })

  it('reads the session once, however much code asks for it on a page', async () => {
    const cookie = await adaCookie()

    // The route middleware and the page, then two components that ask at the same time.
    for (const path of ['/dashboard', '/two-readers']) {
      const before = await sessionReads()
      await visit(path, cookie)
      expect(await sessionReads()).toBe(before + 1)
    }
  })

  it('hands requireSession the signed-in user', async () => {
    expect(await $fetch('/api/me', { headers: { cookie: await adaCookie() } })).toEqual({ email: ADA.email, plan: 'free' })
  })

  it('turns API callers away by the app\'s rules, with each rule\'s status, code and data', async () => {
    const cookie = await adaCookie()

    expect(await answer('/api/rules/view')).toMatchObject({ status: 404 })
    expect(await answer('/api/rules/schedule')).toMatchObject({ status: 401, body: { data: { code: 'SIGNED_OUT' } } })
    expect(await answer('/api/rules/view', cookie)).toMatchObject({ status: 404 })
    expect(await answer('/api/rules/schedule', cookie)).toMatchObject({ status: 403, body: { statusText: 'Forbidden', data: { code: 'PRO_REQUIRED' } } })
    // The same refusal <Can>'s #denied receives.
    expect((await answer('/api/rules/create', cookie)).body.data).toEqual({ code: 'LIMIT_REACHED', details: { limit: 3 } })
    expect(await answer('/api/rules/inline', cookie)).toEqual({ status: 200, body: { edit: false } })
    expect(await answer('/api/rules/reports', cookie)).toMatchObject({ status: 403, body: { data: { code: 'PRO_REQUIRED' } } })
  })

  it('authorizes a user once data that depends on them is loaded, and another user too', async () => {
    const cookie = await adaCookie()

    // Ada's name has three letters: three projects, the free limit.
    expect(await answer('/api/rules/loaded', cookie)).toMatchObject({ status: 429, body: { data: { code: 'LIMIT_REACHED' } } })
    expect(await answer('/api/rules/other', cookie)).toEqual({ status: 200, body: { schedule: true, scheduleAsAda: true } })
  })

  it('turns a visitor away from a page with authorize, showing the error page with the rule\'s status and code', async () => {
    const cookie = await adaCookie()

    expect(await visit('/authorize?count=1', cookie)).toMatchObject({ status: 200, html: expect.stringContaining('allowed to create a project') })
    expect(await visit('/authorize?count=5', cookie)).toMatchObject({ status: 429, html: expect.stringContaining('error 429: LIMIT_REACHED') })
    expect(await visit('/authorize?count=1')).toMatchObject({ status: 401, html: expect.stringContaining('error 401: SIGNED_OUT') })
    // The data never arrived: nothing to authorize.
    expect(await visit('/authorize', cookie)).toMatchObject({ status: 404, html: expect.stringContaining('error 404: no code') })
  })

  it('renders <Can>, <Cannot> and can() on the server, for a guest and for a signed-in user, with one session read', async () => {
    const before = await sessionReads()
    const guestPage = (await visit('/rules')).html

    expect(await sessionReads()).toBe(before + 1)
    expect(guestPage).toContain('schedule denied: SIGNED_OUT')
    expect(guestPage).toContain('cannot edit: SIGNED_OUT')
    expect(guestPage).not.toContain('can create projects')
    expect(guestPage).toContain('is Ada: false')
    expect(guestPage).toContain('same session object: true')

    const adaPage = (await visit('/rules', await adaCookie())).html

    expect(adaPage).toContain('schedule denied: PRO_REQUIRED')
    expect(adaPage).toContain('cannot edit: NOT_THE_AUTHOR')
    expect(adaPage).toContain('can create projects')
    expect(adaPage).toContain('is Ada: true')

    // An argument still undefined, like data on its way, decides nothing yet.
    expect(adaPage).toContain('unknown before the post arrives')
    expect(adaPage).not.toMatch(/(edit|denied) before the post arrives/)
  })

  // A build never generates NUXT_APP_SECRET, which the auth secret derives from.
  it('answers 500 and names NUXT_APP_SECRET when a production build has none', async () => {
    await startServer({ env: { ...env, NUXT_APP_SECRET: '' } })

    const response = await fetch('/api/auth/get-session')

    expect(response.status).toBe(500)
    expect((await response.json()).message).toContain('Set `NUXT_APP_SECRET` to at least 32 characters')
    expect(getServerLogs().join('\n')).toContain('[capsa] auth cannot derive its secret: `appSecret` is not set.')
  })

  // better-auth reads its own variables by itself, and signs the session cookie with what it finds there.
  it.each([
    ['BETTER_AUTH_SECRET', OWN_SECRET],
    ['BETTER_AUTH_SECRETS', `1:${OWN_SECRET}`],
  ])('signs sessions with %s when a production build has no NUXT_APP_SECRET', async (name, value) => {
    await startServer({ env: { ...env, NUXT_APP_SECRET: '', [name]: value } })

    const response = await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': 'http://localhost' },
      body: JSON.stringify({ ...ADA, email: `${name.toLowerCase()}@example.com` }),
    })
    const cookie = response.headers.getSetCookie().find(line => line.includes('session_token'))!.split(';')[0]!
    const [token, signature] = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).split('.')

    expect(response.status).toBe(200)
    expect(signature).toBe(createHmac('sha256', OWN_SECRET).update(token!).digest('base64'))
  })
})
