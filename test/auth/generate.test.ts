import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupAuthFeature } from '../../src/auth/setup'
import type { AuthFeatureOptions } from '../../src/auth/setup'
import { renderAbilities, renderClientModule, renderServerModule, renderServerTypes, renderTypes } from '../../src/auth/templates'
import { runtimePath } from '../../src/utils'
import { fakeNuxt, runModule, writeFiles } from '../helpers/nuxt'

const SERVER_CONFIG = { 'server/capsa/auth/config.ts': 'export default () => ({})' }
const RULES = { 'shared/capsa/abilities.ts': 'export default {}', 'shared/capsa/abilities/post.ts': 'export default {}' }

type Rules = Record<string, Record<string, unknown>>

/** The runtime config the auth setup writes, and what a test may put there first. */
interface RuntimeConfig {
  capsa?: { auth: Record<string, string> }
  public: { capsa?: { auth: { redirects: Record<string, string> } } }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'capsa-auth-'))
})

afterEach(() => rm(root, { recursive: true, force: true }))

/** Runs the auth setup over a fake Nuxt that has what the auth feature touches: route rules, handlers, plugins. */
async function setupAuth(options: AuthFeatureOptions = {}, { dev = false, routeRules = {} as Rules, runtimeConfig = { public: {} } as RuntimeConfig, layers = [] as string[] } = {}) {
  const nuxt = fakeNuxt(root, { dev, layers: [root, ...layers.map(layer => join(root, layer))] })

  // Nuxt 4's layout: the app in app/, the server beside it.
  Object.assign(nuxt.options, { srcDir: join(root, 'app'), serverDir: join(root, 'server'), routeRules, runtimeConfig, serverHandlers: [], plugins: [] })
  await setupAuthFeature(nuxt as never, options)

  return nuxt as typeof nuxt & { options: typeof nuxt.options & { routeRules: Rules, serverHandlers: { route: string, handler: string }[], plugins: unknown[], runtimeConfig: RuntimeConfig } }
}

type SetUp = Awaited<ReturnType<typeof setupAuth>>

/** A template of the app's build, rendered. */
function template(nuxt: SetUp, filename: string) {
  return nuxt.options.build.templates.find(t => t.filename === filename)!.getContents({})
}

/** What the setup adds to Nitro's config: its auto-imports. */
async function nitroConfig(nuxt: SetUp) {
  const config = { imports: { imports: [] as { name: string, from: string }[] } }
  await nuxt.callHook('nitro:config', config)

  return config
}

/** What the setup adds to the app: its auto-imports, its route middleware, and its components. */
async function appParts(nuxt: SetUp) {
  const imports: { name: string, from: string }[] = []
  const middleware: { name: string, path: string }[] = []
  const components: { pascalName: string }[] = []

  await nuxt.callHook('imports:extend', imports)
  await nuxt.callHook('app:resolve', { middleware })
  await nuxt.callHook('components:dirs', [])
  await nuxt.callHook('components:extend', components)

  return { imports, middleware, components: components.map(c => c.pascalName) }
}

/** Runs Nuxt's hook before Nitro builds, with the rules as Nitro holds them once every one is in. */
function buildWith(nuxt: SetUp, routeRules: Rules) {
  return nuxt.callHook('nitro:build:before', { options: { routeRules } })
}

describe('what the auth setup registers', () => {
  it('needs the server config, and shows one in the error', async () => {
    await expect(setupAuth()).rejects.toThrow(/auth needs .*server\/capsa\/auth\/config\.ts[\s\S]*defineServerAuthConfig/)
  })

  it('reads the URL from private runtime config, and the redirects from public, with defaults', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const { runtimeConfig } = (await setupAuth({ redirects: { guest: '/dashboard' } })).options

    expect(runtimeConfig.capsa).toEqual({ auth: { url: '' } })
    expect(runtimeConfig.public.capsa).toEqual({ auth: { redirects: { user: '/login', guest: '/dashboard' } } })
  })

  it('keeps a value the project already put in runtime config', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const { runtimeConfig } = (await setupAuth({}, { runtimeConfig: { capsa: { auth: { url: 'https://app.example.com' } }, public: {} } })).options

    expect(runtimeConfig.capsa?.auth).toEqual({ url: 'https://app.example.com' })
  })

  it('attaches the route middleware to the pages of capsa.auth.routes, next to what their rules already hold', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const { routeRules } = (await setupAuth(
      { routes: { '/dashboard/**': 'user', '/dashboard/public': false, '/login': 'guest' } },
      { routeRules: { '/login': { headers: { 'x-a': '1' }, appMiddleware: 'analytics' }, '/settings': { appMiddleware: ['a', 'b'] }, '/blog/**': { swr: 60 } } },
    )).options

    expect(routeRules).toEqual({
      '/dashboard/**': { appMiddleware: { 'capsa-auth': 'user' } },
      // false detaches the middleware from a page a wider pattern guards.
      '/dashboard/public': { appMiddleware: { 'capsa-auth': false } },
      '/login': { headers: { 'x-a': '1' }, appMiddleware: { 'analytics': true, 'capsa-auth': 'guest' } },
      '/settings': { appMiddleware: ['a', 'b'] },
      '/blog/**': { swr: 60 },
    })
  })

  it('stops the build on a guarded page that a route rule caches, whichever key caches it, and lets a page set to false through', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    const guarded = (mode: unknown, cache: Record<string, unknown>) => ({ appMiddleware: { 'capsa-auth': mode }, ...cache })

    for (const cache of [{ cache: { swr: true } }, { isr: 60 }, { prerender: true }, { static: true }])
      await expect(buildWith(nuxt, { '/feed/**': guarded('user', cache) })).rejects.toThrow('[capsa] "/feed/**" is guarded by capsa.auth.routes and cached by a route rule')

    await expect(buildWith(nuxt, { '/feed/**': guarded(false, { cache: { swr: true } }) })).resolves.toBeUndefined()
    await expect(buildWith(nuxt, { '/feed/**': { cache: { swr: true } } })).resolves.toBeUndefined()
  })

  it('mounts better-auth\'s handler on capsa.auth.basePath, and derives its secret in a Nitro plugin', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth({ basePath: '/auth/' })

    expect(nuxt.options.serverHandlers).toEqual([{ route: '/auth/**', handler: runtimePath('auth/handler') }])
    expect(nuxt.options._serverPlugins.map(p => p.plugin)).toEqual([runtimePath('auth/plugin')])
    expect(nuxt.options.nitro.virtual['#capsa/auth']!()).toContain(`  basePath: "/auth",\n`)
    expect(template(nuxt, 'capsa/auth/client.mjs')).toContain(`export const basePath = "/auth"\n`)
    // useCapsaSession imports the client where a page uses it: an app plugin would load better-auth's client on every page.
    expect(nuxt.options.plugins).toEqual([])
  })

  it('auto-imports useCapsaAuth on the server and useCapsaSession in the app, and nothing else', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()

    expect((await nitroConfig(nuxt)).imports.imports).toEqual([{ name: 'useCapsaAuth', from: '#capsa/auth' }])
    expect(await appParts(nuxt)).toMatchObject({
      imports: [{ name: 'useCapsaSession', from: runtimePath('app/auth/session') }],
      middleware: [{ name: 'capsa-auth', path: runtimePath('app/auth/middleware') }],
    })
  })

  it('creates the client from the project\'s client config when there is one', async () => {
    await writeFiles(root, SERVER_CONFIG)
    expect(template(await setupAuth(), 'capsa/auth/client.mjs')).toContain('createAuthClient(defaults)')

    await writeFiles(root, { 'app/capsa/auth.config.ts': 'export default () => ({})' })
    const client = template(await setupAuth(), 'capsa/auth/client.mjs')

    expect(client).toContain(`import config from '#capsa/root/app/capsa/auth.config'`)
    expect(client).toContain('createAuthClient(config(defaults))')
  })

  // Shared code runs in the app too, where #capsa/auth does not exist.
  it('keeps the types of #capsa/auth out of shared code', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    const app = {} as { sharedReferences: { path: string }[] }

    await nuxt.callHook('prepare:types', app)

    expect(app.sharedReferences).toEqual([{ path: join(root, '.nuxt/capsa/auth/types.d.ts') }])
  })

  it('reads the rules from shared/capsa/abilities.ts and shared/capsa/abilities/*.ts into one file the server and the client import', async () => {
    await writeFiles(root, { ...SERVER_CONFIG, ...RULES, 'shared/capsa/abilities/drafts/old.ts': '', 'shared/capsa/other.ts': '' })
    const nuxt = await setupAuth()
    const imports = `import abilities_0 from '#capsa/root/shared/capsa/abilities'\nimport abilities_1 from '#capsa/root/shared/capsa/abilities/post'\n`

    // The same rules, as a virtual module for Nitro and as a template for the app.
    expect(nuxt.options.nitro.virtual['#capsa/auth/abilities']!()).toContain(imports)
    expect(template(nuxt, 'capsa/auth/abilities.mjs')).toContain(imports)
    expect(nuxt.options.nitro.virtual['#capsa/auth']!()).toContain(`import abilities from '#capsa/auth/abilities'`)
    expect(template(nuxt, 'capsa/auth/types.d.ts')).toContain(`abilities: typeof import('#capsa/root/shared/capsa/abilities').default & typeof import('#capsa/root/shared/capsa/abilities/post').default`)
  })

  it('reads the rules of every layer after the project\'s', async () => {
    await writeFiles(root, { ...SERVER_CONFIG, 'shared/capsa/abilities.ts': 'export default {}', 'layers/billing/shared/capsa/abilities/invoices.ts': 'export default {}' })
    const nuxt = await setupAuth({}, { layers: ['layers/billing'] })

    expect(template(nuxt, 'capsa/auth/abilities.mjs')).toContain(`import abilities_0 from '#capsa/root/shared/capsa/abilities'\nimport abilities_1 from '#capsa/root/layers/billing/shared/capsa/abilities/invoices'\n`)
    expect(template(nuxt, 'capsa/auth/types.d.ts')).toContain(`typeof import('#capsa/root/layers/billing/shared/capsa/abilities/invoices').default`)
  })

  it('registers <Can> and <Cannot> under the prefix capsa.auth.components gives', async () => {
    await writeFiles(root, { ...SERVER_CONFIG, ...RULES })

    expect((await appParts(await setupAuth({ components: { prefix: 'auth' } }))).components).toEqual(['AuthCan', 'AuthCannot'])
  })

  it('registers <Can> and <Cannot> only when the app has rules, and ships no rule code without them', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const without = await setupAuth()

    expect((await appParts(without)).components).toEqual([])
    expect(template(without, 'capsa/auth/abilities.mjs')).toBe('export default {}\n')

    await writeFiles(root, RULES)

    expect((await appParts(await setupAuth())).components).toEqual(['Can', 'Cannot'])
  })

  it('restarts Nuxt in dev when a config or rules file of any layer is created or deleted, and not when one is edited', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth({}, { dev: true, layers: ['layers/billing'] })
    let restarts = 0

    nuxt.hook('restart', () => void restarts++)

    await nuxt.callHook('builder:watch', 'add', join(root, 'app/capsa/auth.config.ts'))
    await nuxt.callHook('builder:watch', 'unlink', join(root, 'server/capsa/auth/config.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'shared/capsa/abilities.ts'))
    await nuxt.callHook('builder:watch', 'unlink', join(root, 'shared/capsa/abilities/post.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'layers/billing/shared/capsa/abilities/refunds.ts'))
    await nuxt.callHook('builder:watch', 'unlink', join(root, 'layers/billing/shared/capsa/abilities.ts'))
    expect(restarts).toBe(6)

    await nuxt.callHook('builder:watch', 'change', join(root, 'server/capsa/auth/config.ts'))
    await nuxt.callHook('builder:watch', 'change', join(root, 'shared/capsa/abilities/post.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'app/capsa/auth/other.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'shared/capsa/abilities/drafts/old.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'layers/billing/shared/capsa/other.ts'))
    // A layer's config is never read: only the project's.
    await nuxt.callHook('builder:watch', 'add', join(root, 'layers/billing/server/capsa/auth/config.ts'))
    expect(restarts).toBe(6)
  })

  it('wires the project\'s server config, the merged rules and the base path into defineAuth', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth({ basePath: '/auth' })
    const defineAuth = vi.fn(() => ({}))
    const modules = {
      'better-auth': { betterAuth: () => {}, env: { BETTER_AUTH_URL: 'x' } },
      'nuxt-capsa/auth/server': { defineAuth },
      '#capsa/root/server/capsa/auth/config': { default: () => 'the config' },
      '#capsa/auth/abilities': { default: { the: 'rules' } },
    }

    runModule(nuxt.options.nitro.virtual['#capsa/auth']!(), modules, 'undefined')

    expect(defineAuth).toHaveBeenCalledExactlyOnceWith({
      betterAuth: modules['better-auth'].betterAuth,
      env: modules['better-auth'].env,
      config: modules['#capsa/root/server/capsa/auth/config'].default,
      abilities: { the: 'rules' },
      basePath: '/auth',
    })
  })
})

describe('what the auth templates render', () => {
  it('renders #capsa/auth over the project\'s better-auth and capsa\'s defineAuth', async () => {
    await expect(renderServerModule('#capsa/root/server/capsa/auth/config', '/api/auth')).toMatchFileSnapshot('__snapshots__/server.mjs')
  })

  it('renders the client module, with the project\'s client config and without it', async () => {
    await expect(renderClientModule('#capsa/root/app/capsa/auth.config', '/api/auth')).toMatchFileSnapshot('__snapshots__/client.mjs')
    await expect(renderClientModule(undefined, '/api/auth')).toMatchFileSnapshot('__snapshots__/client-no-config.mjs')
  })

  it('renders the rules merged once, and an empty set without rules files', async () => {
    await expect(renderAbilities(['#capsa/root/shared/capsa/abilities', '#capsa/root/shared/capsa/abilities/post'])).toMatchFileSnapshot('__snapshots__/abilities.mjs')
    expect(renderAbilities([])).toBe('export default {}\n')
  })

  it('renders the types from both config files and the rules, and those of #capsa/auth', async () => {
    await expect(renderTypes('#capsa/root/server/capsa/auth/config', '#capsa/root/app/capsa/auth.config', ['#capsa/root/shared/capsa/abilities'])).toMatchFileSnapshot('__snapshots__/types.d.ts')
    await expect(renderTypes('#capsa/root/server/capsa/auth/config', undefined, [])).toMatchFileSnapshot('__snapshots__/types-no-client.d.ts')
    await expect(renderServerTypes()).toMatchFileSnapshot('__snapshots__/types-server.d.ts')
  })
})
