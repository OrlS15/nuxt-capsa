import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'

const root = fileURLToPath(new URL('../fixtures/auth-pglite', import.meta.url))
const store = await mkdtemp(join(tmpdir(), 'capsa-auth-dev-'))

// `nuxt dev` builds the server unlike a build does: the app's rules have to reach both sides there too.
describe('the auth feature under nuxt dev', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(() => rm(store, { recursive: true, force: true }))

  await setup({ rootDir: root, dev: true, env: { NUXT_CAPSA_DB_DEFAULT_CONNECTION: store } })

  it('runs the app\'s rules in API routes and in pages', async () => {
    const api = await fetch('/api/rules/schedule', { headers: { accept: 'application/json' } })

    expect(api.status).toBe(401)
    expect((await api.json()).data).toEqual({ code: 'SIGNED_OUT' })
    expect(await (await fetch('/rules')).text()).toContain('schedule denied: SIGNED_OUT')
  })
})
