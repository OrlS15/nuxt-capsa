import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'

const root = fileURLToPath(new URL('../fixtures/db-pglite', import.meta.url))
const [store, setupStore] = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'capsa-db-dev-'))))

// `setup` also starts the dev server once in this process, where its `env` does not reach: the store of that server migrates on start too.
process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION = setupStore

// `nuxt dev` builds the server unlike a build does, and reads the migrations from the folder instead of the bundle.
describe('db sources under nuxt dev', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(() => Promise.all([store, setupStore].map(dir => rm(dir!, { recursive: true, force: true }))))

  await setup({
    rootDir: root,
    dev: true,
    env: { NUXT_CAPSA_DB_DEFAULT_CONNECTION: store, NUXT_CAPSA_DB_ANALYTICS_DB_CONNECTION: 'memory://' },
  })

  it('answers the first request on the migrated tables', async () => {
    expect(await $fetch('/api/users')).toEqual({ users: [], migrations: ['20260929075826_init'] })
  })

  it('hands out each source by its name', async () => {
    expect(await $fetch('/api/sources')).toMatchObject({ sameDefault: true, analyticsUsers: null })
  }, 30_000)
})
