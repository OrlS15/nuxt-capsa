import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { setup, useTestContext } from '@nuxt/test-utils/e2e'

const D1 = { provider: 'drizzle', dialect: 'sqlite', driver: 'd1' } as const

/**
 * Lists the modules a built server bundles, from its source maps.
 *
 * @example
 * await bundledModules('/app/.output/server')  // ['virtual:#capsa/drive', '../node_modules/files-sdk/dist/r2/index.js', …]
 */
async function bundledModules(server: string) {
  const maps = (await readdir(server, { recursive: true })).filter(file => file.endsWith('.map'))
  const sources = await Promise.all(maps.map(async map => JSON.parse(await readFile(join(server, map), 'utf8')).sources))

  return sources.flat() as string[]
}

// Only built: running it takes workerd. So the fixture's pg tables and SQL can stay, as what the d1 sources bundle.
describe('an app with d1 sources and disks on fs, r2 and s3-fetch, built for a Worker', async () => {
  // A build that fails fails this suite here.
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/db-pglite', import.meta.url)),
    server: false,
    nuxtConfig: {
      // deployConfig would write `.wrangler` in the fixture, out of the test's build folder.
      nitro: { preset: 'cloudflare-module', cloudflare: { deployConfig: false } },
      capsa: {
        db: { default: D1, analyticsDb: D1 },
        drive: { default: { adapter: 'fs' }, media: { adapter: 'r2' }, documents: { adapter: 's3-fetch' } },
      },
    },
  })

  it('bundles every source on the d1 driver and every disk on its adapter, and no other database driver', async () => {
    const modules = await bundledModules(join(useTestContext().nuxt!.options.nitro.output!.dir!, 'server'))

    for (const module of ['#capsa/db', '#capsa/db/default', '#capsa/db/analyticsDb', '#capsa/drive'])
      expect(modules).toContain(`virtual:${module}`)

    const paths = modules.join('\n')

    for (const adapter of ['fs', 'r2', 's3-fetch'])
      expect(paths).toContain(`/files-sdk/dist/${adapter}/index.js`)

    expect(paths).toContain('/drizzle-orm/d1/driver.js')
    expect(paths).not.toMatch(/\/drizzle-orm\/(?!d1\/)[^/]+\/driver\.js/)
    expect(paths).not.toMatch(/\/node_modules\/(?:better-sqlite3|@electric-sql\/pglite)\//)
  })
})
