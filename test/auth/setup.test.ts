import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { deriveSecret } from 'nuxt/server'
import { setupAuthFeature } from '../../src/auth/setup'
import { defineAuth } from '../../src/runtime/auth/server'
import { runtimePath } from '../../src/utils'
import { fakeNuxt, runModule, writeFiles } from '../db/nuxt'
import type { AuthFeatureOptions } from '../../src/auth/setup'

// capsa's server runtime imports these from Nuxt itself, and no Nuxt runs here: no base URL, no NUXT_CAPSA_AUTH_URL.
vi.mock('nuxt/server', () => ({
  createError: vi.fn(),
  deriveSecret: vi.fn(),
  useRuntimeConfig: () => ({ app: { baseURL: '/' }, capsa: { auth: { url: '' } } }),
}))

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
  vi.mocked(deriveSecret).mockReset().mockResolvedValue('derived from NUXT_APP_SECRET')
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

/** Runs Nuxt's hook before Nitro builds, with the rules as Nitro holds them once every one is in. */
function buildWith(nuxt: Awaited<ReturnType<typeof setupAuth>>, routeRules: Rules) {
  return nuxt.callHook('nitro:build:before', { options: { routeRules } })
}

/** Runs the #capsa/auth the setup generated on capsa's own runtime, over stand-ins for better-auth and the project's files. */
function serverModule(nuxt: Awaited<ReturnType<typeof setupAuth>>, stubs: Record<string, Record<string, unknown>> = {}) {
  return runModule(nuxt.options.nitro.virtual['#capsa/auth']!(), {
    'better-auth': { betterAuth: (options: unknown) => options, env: {} },
    'nuxt-capsa/auth/server': { defineAuth },
    // As defineServerAuthConfig does with a config that returns nothing of its own.
    '#capsa/root/server/capsa/auth/config': { default: (defaults: object) => defaults },
    '#capsa/auth/abilities': { default: {} },
    ...stubs,
  }, '{ useCapsaAuth, authReady }') as { useCapsaAuth: () => Record<string, unknown>, authReady: () => Promise<void> }
}

describe('auth setup', () => {
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
      { routeRules: { '/login': { headers: { 'x-a': '1' }, appMiddleware: 'analytics' }, '/blog/**': { swr: 60 } } },
    )).options

    expect(routeRules).toEqual({
      '/dashboard/**': { appMiddleware: { 'capsa-auth': 'user' } },
      // false detaches the middleware from a page a wider pattern guards.
      '/dashboard/public': { appMiddleware: { 'capsa-auth': false } },
      '/login': { headers: { 'x-a': '1' }, appMiddleware: { 'analytics': true, 'capsa-auth': 'guest' } },
      '/blog/**': { swr: 60 },
    })
  })

  it('stops the build on a guarded page that a route rule caches, and lets a page set to false through', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    const guarded = (mode: unknown) => ({ appMiddleware: { 'capsa-auth': mode }, cache: { swr: true } })

    await expect(buildWith(nuxt, { '/feed/**': guarded('user') })).rejects.toThrow('[capsa] "/feed/**" is guarded by capsa.auth.routes and cached by a route rule')
    await expect(buildWith(nuxt, { '/feed/**': guarded(false) })).resolves.toBeUndefined()
  })

  it('creates the client from the project\'s client config when there is one', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const client = async () => (await setupAuth()).options.build.templates.find(t => t.filename === 'capsa/auth/client.mjs')!.getContents({})

    expect(await client()).toContain('createAuthClient(defaults)')

    await writeFiles(root, { 'app/capsa/auth.config.ts': 'export default () => ({})' })

    expect(await client()).toContain(`import config from '#capsa/root/app/capsa/auth.config'`)
    expect(await client()).toContain('createAuthClient(config(defaults))')
  })

  // Shared code runs in the app too, where #capsa/auth does not exist.
  it('keeps the types of #capsa/auth out of shared code', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    const app = {} as { sharedReferences: { path: string }[] }

    await nuxt.callHook('prepare:types', app)

    expect(app.sharedReferences).toEqual([{ path: join(root, '.nuxt/capsa/auth/types.d.ts') }])
  })

  it('restarts Nuxt in dev when a config or rules file is created or deleted, and not when one is edited', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth({}, { dev: true })
    let restarts = 0

    nuxt.hook('restart', () => void restarts++)

    await nuxt.callHook('builder:watch', 'add', join(root, 'app/capsa/auth.config.ts'))
    await nuxt.callHook('builder:watch', 'unlink', join(root, 'server/capsa/auth/config.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'shared/capsa/abilities.ts'))
    await nuxt.callHook('builder:watch', 'unlink', join(root, 'shared/capsa/abilities/post.ts'))
    await nuxt.callHook('builder:watch', 'change', join(root, 'server/capsa/auth/config.ts'))
    await nuxt.callHook('builder:watch', 'change', join(root, 'shared/capsa/abilities/post.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'app/capsa/auth/other.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'shared/capsa/abilities/drafts/old.ts'))

    expect(restarts).toBe(4)
  })

  it('reads the rules from shared/capsa/abilities.ts and shared/capsa/abilities/*.ts into one file the server and the client import', async () => {
    await writeFiles(root, { ...SERVER_CONFIG, ...RULES, 'shared/capsa/abilities/drafts/old.ts': '', 'shared/capsa/other.ts': '' })
    const nuxt = await setupAuth()
    const template = (filename: string) => nuxt.options.build.templates.find(t => t.filename === filename)!.getContents({})
    const imports = `import abilities_0 from '#capsa/root/shared/capsa/abilities'\nimport abilities_1 from '#capsa/root/shared/capsa/abilities/post'\n`

    // The same rules, as a virtual module for Nitro and as a template for the app.
    expect(nuxt.options.nitro.virtual['#capsa/auth/abilities']!()).toContain(imports)
    expect(template('capsa/auth/abilities.mjs')).toContain(imports)
    expect(nuxt.options.nitro.virtual['#capsa/auth']!()).toContain(`import abilities from '#capsa/auth/abilities'`)
    expect(template('capsa/auth/types.d.ts')).toContain(`abilities: typeof import('#capsa/root/shared/capsa/abilities').default & typeof import('#capsa/root/shared/capsa/abilities/post').default`)
  })

  it('reads the rules of every layer after the project\'s, and restarts in dev when one comes or goes', async () => {
    await writeFiles(root, { ...SERVER_CONFIG, 'shared/capsa/abilities.ts': 'export default {}', 'layers/billing/shared/capsa/abilities/invoices.ts': 'export default {}' })
    const nuxt = await setupAuth({}, { dev: true, layers: ['layers/billing'] })
    const template = (filename: string) => nuxt.options.build.templates.find(t => t.filename === filename)!.getContents({})
    let restarts = 0

    nuxt.hook('restart', () => void restarts++)

    expect(template('capsa/auth/abilities.mjs')).toContain(`import abilities_0 from '#capsa/root/shared/capsa/abilities'\nimport abilities_1 from '#capsa/root/layers/billing/shared/capsa/abilities/invoices'\n`)
    expect(template('capsa/auth/types.d.ts')).toContain(`typeof import('#capsa/root/layers/billing/shared/capsa/abilities/invoices').default`)

    await nuxt.callHook('builder:watch', 'add', join(root, 'layers/billing/shared/capsa/abilities/refunds.ts'))
    await nuxt.callHook('builder:watch', 'unlink', join(root, 'layers/billing/shared/capsa/abilities.ts'))
    await nuxt.callHook('builder:watch', 'add', join(root, 'layers/billing/shared/capsa/other.ts'))

    expect(restarts).toBe(2)
  })

  it('mounts better-auth on capsa.auth.basePath, and points the server and the app to the same path', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth({ basePath: '/auth/' })
    const client = nuxt.options.build.templates.find(t => t.filename === 'capsa/auth/client.mjs')!.getContents({})

    expect(nuxt.options.serverHandlers[0]!.route).toBe('/auth/**')
    expect(nuxt.options.nitro.virtual['#capsa/auth']!()).toContain(`  basePath: "/auth",\n`)
    expect(client).toContain(`export const basePath = "/auth"\n`)
    // useCapsaSession imports it where a page uses it: an app plugin would load better-auth's client on every page.
    expect(nuxt.options.plugins).toEqual([])
  })

  it('keeps capsa.auth.basePath and its own secret when a server config returns some of its own', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth({ basePath: '/auth' })
    // As defineServerAuthConfig does: the config's options over capsa's.
    const config = (defaults: object) => ({ ...defaults, basePath: '/elsewhere', secret: 'mine', appName: 'mine' })
    const { useCapsaAuth, authReady } = serverModule(nuxt, { '#capsa/root/server/capsa/auth/config': { default: config } })

    await authReady()

    expect(useCapsaAuth()).toMatchObject({ basePath: '/auth', appName: 'mine', secret: 'derived from NUXT_APP_SECRET' })
  })

  // better-auth then signs with the project's first one, and reads with capsa's what it encrypted before.
  it('hands better-auth the secrets a server config returns, next to its own secret', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    const secrets = [{ version: 2, value: 'the-current-one' }, { version: 1, value: 'the-one-before' }]
    const { useCapsaAuth, authReady } = serverModule(nuxt, { '#capsa/root/server/capsa/auth/config': { default: (defaults: object) => ({ ...defaults, secrets }) } })

    await authReady()

    expect(useCapsaAuth()).toMatchObject({ secrets, secret: 'derived from NUXT_APP_SECRET' })
  })

  it('hands the config no secret and no policy of its own: only the URL and the base path', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    const config = vi.fn((defaults: object) => defaults)
    const { useCapsaAuth, authReady } = serverModule(nuxt, { '#capsa/root/server/capsa/auth/config': { default: config } })

    await authReady()
    useCapsaAuth()

    expect(config).toHaveBeenCalledExactlyOnceWith({ baseURL: undefined, basePath: '/api/auth' })
  })

  // better-auth reads its own variables by itself: capsa hands it no secret over them.
  it('leaves the secret to BETTER_AUTH_SECRET, and to BETTER_AUTH_SECRETS where NUXT_APP_SECRET is missing', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    const withEnv = (env: Record<string, string>) => serverModule(nuxt, { 'better-auth': { betterAuth: (options: unknown) => options, env } })

    // BETTER_AUTH_SECRET wins over NUXT_APP_SECRET, which is then not even derived from.
    const single = withEnv({ BETTER_AUTH_SECRET: 'the-project-own-secret' })
    await single.authReady()
    expect(single.useCapsaAuth()).toHaveProperty('secret', undefined)
    expect(deriveSecret).not.toHaveBeenCalled()

    // BETTER_AUTH_SECRETS rotates the derived secret where there is one, and stands alone where there is none.
    const rotated = withEnv({ BETTER_AUTH_SECRETS: '1:the-project-own-secret' })
    await rotated.authReady()
    expect(rotated.useCapsaAuth()).toMatchObject({ secret: 'derived from NUXT_APP_SECRET' })

    vi.mocked(deriveSecret).mockRejectedValue(new Error('`appSecret` is not set.'))
    const alone = withEnv({ BETTER_AUTH_SECRETS: '1:the-project-own-secret' })
    await alone.authReady()
    expect(alone.useCapsaAuth()).toHaveProperty('secret', undefined)

    // Without any of them auth does not start, and neither does it on a variable that is there but empty.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    const none = withEnv({ BETTER_AUTH_SECRET: '', BETTER_AUTH_SECRETS: '' })
    await expect(none.authReady()).rejects.toThrow('`appSecret` is not set.')
    expect(() => none.useCapsaAuth()).toThrow('`appSecret` is not set.')
  })

  it('derives the secret once before useCapsaAuth builds better-auth, and tries again after a failure', async () => {
    await writeFiles(root, SERVER_CONFIG)
    const nuxt = await setupAuth()
    vi.mocked(deriveSecret)
      .mockRejectedValueOnce(new Error('`appSecret` is not set.'))
      .mockRejectedValueOnce(new Error('`appSecret` is not set.'))
      .mockResolvedValue('derived')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    const { useCapsaAuth, authReady } = serverModule(nuxt)

    expect(() => useCapsaAuth()).toThrow('[capsa] useCapsaAuth() ran before the auth secret was derived. Outside a request, await authReady() first.')

    await expect(authReady()).rejects.toThrow('`appSecret` is not set.')
    // The failure is what useCapsaAuth reports, until a later attempt succeeds.
    expect(() => useCapsaAuth()).toThrow('`appSecret` is not set.')
    await expect(authReady()).rejects.toThrow('`appSecret` is not set.')
    // The server log names it once, not on every request.
    expect(logged.mock.calls).toEqual([['[capsa] auth cannot derive its secret:', '`appSecret` is not set.']])

    await authReady()
    await authReady()

    expect(useCapsaAuth()).toMatchObject({ secret: 'derived' })
    expect(deriveSecret).toHaveBeenCalledTimes(3)
    expect(deriveSecret).toHaveBeenCalledWith('nuxt-capsa:auth')
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

  it('registers <Can> and <Cannot> under the prefix capsa.auth.components gives', async () => {
    await writeFiles(root, { ...SERVER_CONFIG, ...RULES })
    const nuxt = await setupAuth({ components: { prefix: 'auth' } })
    const components: { pascalName: string }[] = []

    await nuxt.callHook('components:dirs', [])
    await nuxt.callHook('components:extend', components)

    expect(components.map(c => c.pascalName)).toEqual(['AuthCan', 'AuthCannot'])
  })

  it('registers <Can> and <Cannot> only when the app has rules, and ships no rule code without them', async () => {
    const setUp = async (files: Record<string, string>) => {
      await writeFiles(root, files)
      const nuxt = await setupAuth()
      const components: { pascalName: string }[] = []

      await nuxt.callHook('components:dirs', [])
      await nuxt.callHook('components:extend', components)

      return { names: components.map(c => c.pascalName), rules: nuxt.options.build.templates.find(t => t.filename === 'capsa/auth/abilities.mjs')!.getContents({}) }
    }

    const without = await setUp(SERVER_CONFIG)
    expect(without.names).toEqual([])
    expect(without.rules).toBe('export default {}\n')

    expect((await setUp(RULES)).names).toEqual(['Can', 'Cannot'])
  })
})
