import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runWithNuxtContext } from '@nuxt/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import capsa from '../../src/module'
import { setupDbFeature, type DbFeatureOptions } from '../../src/db/setup'
import { renderDbModule } from '../../src/db/templates'
import { log } from '../../src/utils'
import { fakeNuxt, writeFiles } from './nuxt'

const PGLITE = { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' } as const

// A source with no schema file warns: these tests are about something else.
beforeEach(() => void vi.spyOn(log, 'warn').mockImplementation(() => {}))

afterEach(() => vi.restoreAllMocks())

describe('module', () => {
  const root = join(import.meta.dirname, '.tmp-module')

  afterEach(() => rm(root, { recursive: true, force: true }))

  it('reads its options from the `capsa` key of nuxt.config', async () => {
    const nuxt = fakeNuxt(root)

    Object.assign(nuxt.options, { capsa: { db: { default: PGLITE } } })
    await writeFiles(root, { 'server/capsa/db/default/schema.ts': '' })
    await runWithNuxtContext(nuxt as never, () => capsa({}, nuxt as never))

    expect(Object.keys(nuxt.options.nitro.virtual)).toContain('#capsa/db/default')
  })
})

describe('sources', () => {
  const root = join(import.meta.dirname, '.tmp-core')

  afterEach(() => rm(root, { recursive: true, force: true }))

  /** Runs the db feature's setup over a fake Nuxt, which it hands back to look at what was registered. */
  async function setupDb(options: Record<string, unknown>) {
    const nuxt = fakeNuxt(root)
    const error = await runWithNuxtContext(nuxt as never, () => setupDbFeature(nuxt as never, options as DbFeatureOptions)).catch((error: Error) => error)

    return { nuxt, error }
  }

  it('takes names of letters, numbers and "_", camelCase included', async () => {
    const { nuxt, error } = await setupDb({ default: PGLITE, analyticsDb: PGLITE, logs_2: PGLITE })

    expect(error).toBeUndefined()
    expect(Object.keys(nuxt.options.nitro.virtual)).toEqual(expect.arrayContaining(['#capsa/db', '#capsa/db/default', '#capsa/db/analyticsDb', '#capsa/db/logs_2']))
  })

  it.each(['my-db', 'my db', 'db.2'])('refuses the name "%s"', async (name) => {
    const { error } = await setupDb({ default: PGLITE, [name]: PGLITE })

    expect(error).toEqual(new Error(`[capsa] invalid db source name "${name}": use only letters, numbers and "_".`))
  })

  // `constructor` is a key every object answers to: only a provider of the registry's own counts.
  it.each(['prisma', 'constructor'])('refuses the provider "%s" it does not know, and names the ones it has', async (provider) => {
    const { error } = await setupDb({ default: { provider } })

    expect(error).toEqual(new Error(`[capsa] db source "default" names an unknown provider "${provider}". Available: drizzle.`))
  })

  it('stops on a wrong source before it registers anything', async () => {
    const { nuxt, error } = await setupDb({ default: PGLITE, logs: { ...PGLITE, dir: '/abs/logs' } })

    expect(error?.message).toContain('`dir` is a path inside the server directory')
    expect(nuxt.options.nitro.virtual).toEqual({})
    expect(nuxt.options.build.templates).toEqual([])
  })
})

describe('#capsa/db', () => {
  /** Runs the rendered module, with each source's `getDb` stubbed to hand back its name. */
  function useCapsaDbFor(names: string[]) {
    const module = renderDbModule(names.map(name => ({ name, moduleId: `#capsa/db/${name}` as const })))
    const body = module.replace(/^import .*\n/gm, '').replace('export function', 'function')

    return new Function(...names.map((_, index) => `getDb_${index}`), `${body}\nreturn useCapsaDb`)(...names.map(name => () => `db of ${name}`))
  }

  it('hands out the default with no name, and any source by its name', () => {
    const useCapsaDb = useCapsaDbFor(['default', 'analytics'])

    expect(useCapsaDb()).toBe('db of default')
    expect(useCapsaDb('analytics')).toBe('db of analytics')
  })

  it('refuses a name no source has, and lists the ones there are', () => {
    expect(() => useCapsaDbFor(['default', 'analytics'])('nope')).toThrow('[capsa] unknown db source "nope". Configured: default, analytics.')
  })
})
