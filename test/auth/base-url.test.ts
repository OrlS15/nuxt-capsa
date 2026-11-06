import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'

const root = fileURLToPath(new URL('../fixtures/auth-pglite', import.meta.url))
const store = await mkdtemp(join(tmpdir(), 'capsa-auth-base-'))

describe('a built app with better-auth on a basePath of its own, under app.baseURL', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(() => rm(store, { recursive: true, force: true }))

  await setup({
    rootDir: root,
    nuxtConfig: { app: { baseURL: '/app/' }, capsa: { auth: { basePath: '/auth' } } },
    env: { NUXT_CAPSA_DB_DEFAULT_CONNECTION: store, NUXT_APP_SECRET: 'a-secret-for-the-e2e-test-0123456789' },
  })

  it('mounts better-auth on the base path, under the base, and reads the session there during SSR', async () => {
    const signUp = await fetch('/app/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': 'http://localhost' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'password1234', name: 'Ada' }),
    })
    const cookie = signUp.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')

    expect(signUp.status).toBe(200)
    expect((await fetch('/app/api/auth/get-session')).status).toBe(404)
    expect(await (await fetch('/app/profile', { headers: { cookie } })).text()).toContain('Signed in as Ada')
    expect((await fetch('/app/dashboard', { redirect: 'manual' })).headers.get('location')).toBe('/app/login')
  })
})
