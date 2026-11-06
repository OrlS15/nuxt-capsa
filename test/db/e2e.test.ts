import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, describe, expect, it } from 'vitest'
import { $fetch, getServerLogs, setup, startServer, stopServer, useTestContext } from '@nuxt/test-utils/e2e'

const root = fileURLToPath(new URL('../fixtures/db-pglite', import.meta.url))
// The built server runs in the test's cwd: a store of its own for each run, never the repo's `.data`.
const [store, cliFirstStore, primaryStore, replicaStore] = await Promise.all([0, 1, 2, 3].map(() => mkdtemp(join(tmpdir(), 'capsa-pglite-'))))
const MIGRATED = { users: [], migrations: ['20260929075826_init'] }

/** Runs `drizzle-kit migrate` against `store`, with the config capsa generated for the default source. */
function kitMigrate(store: string) {
  const bin = fileURLToPath(new URL('../../node_modules/.bin/drizzle-kit', import.meta.url))
  const config = join(useTestContext().nuxt!.options.buildDir, 'capsa/db/default/drizzle.config.ts')

  return promisify(execFile)(bin, ['migrate', '--config', config], {
    cwd: root,
    env: { ...process.env, NUXT_CAPSA_DB_DEFAULT_CONNECTION: store },
  })
}

describe('a built app with two pglite sources, one migrating on start', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(() => Promise.all([store, cliFirstStore, primaryStore, replicaStore].map(dir => rm(dir!, { recursive: true, force: true }))))

  await setup({
    rootDir: root,
    env: { NUXT_CAPSA_DB_DEFAULT_CONNECTION: store, NUXT_CAPSA_DB_ANALYTICS_DB_CONNECTION: 'memory://' },
  })

  it('answers the first request on the migrated tables', async () => {
    expect(await $fetch('/api/users')).toEqual(MIGRATED)
  })

  it('hands out each source by its name, and lists them when asked for one it does not have', async () => {
    expect(await $fetch('/api/sources')).toEqual({
      sameDefault: true,
      analyticsUsers: null,
      unknown: '[capsa] unknown db source "nope". Configured: default, analyticsDb.',
    })
    // The second source starts its own Postgres here, which is slow while the other built apps of the suite start too.
  }, 30_000)

  it('applies nothing again when the server restarts on the same store', async () => {
    await startServer()

    expect(await $fetch('/api/users')).toEqual(MIGRATED)
    expect(getServerLogs().join('\n')).not.toContain('[capsa]')
  })

  it('has no db.$replica when no replicas are set', async () => {
    expect(await $fetch('/api/replicas')).toMatchObject({ replica: null })
  })

  // Nitro hands an environment variable over as the text it is: the replicas are a JSON array in it.
  it('reads db.$replica from the store the environment variable names, and migrates only the primary', async () => {
    const replica = new PGlite(replicaStore!)

    await replica.exec(`create table users (id serial primary key, name text not null);
      insert into users (name) values ('only on the replica')`)
    await replica.close()

    await startServer({ env: { NUXT_CAPSA_DB_DEFAULT_CONNECTION: primaryStore, NUXT_CAPSA_DB_DEFAULT_REPLICAS: JSON.stringify([replicaStore]) } })

    expect(await $fetch('/api/replicas')).toEqual({
      primary: { users: [], migrations: 'drizzle.history' },
      replica: { users: [{ id: 1, name: 'only on the replica' }], migrations: null },
    })
  }, 30_000)

  // Either one applying a migration again would fail on the table it already created.
  it('agrees with drizzle-kit on what is applied, whichever of the two migrates first', async () => {
    // PGlite opens a store from one process at a time.
    await stopServer()
    await kitMigrate(store!)
    await kitMigrate(cliFirstStore!)

    await startServer()
    expect(await $fetch('/api/users')).toEqual(MIGRATED)

    await startServer({ env: { NUXT_CAPSA_DB_DEFAULT_CONNECTION: cliFirstStore } })
    expect(await $fetch('/api/users')).toEqual(MIGRATED)
  }, 30_000)
})
