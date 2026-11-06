import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { setupDriveFeature, type Disk, type DriveFeatureOptions } from '../../src/drive/setup'
import { renderConfigTypes, renderDriveTypes } from '../../src/drive/templates'
import { defineDriveConfig } from '../../src/runtime/drive'
import { defineDrive } from '../../src/runtime/drive/server'
import { runtimePath } from '../../src/utils'
import { fakeNuxt, runModule, typeErrors, writeFiles } from '../db/nuxt'

vi.mock('nuxt/server', () => ({
  createError: vi.fn(),
  deriveSecret: vi.fn(),
  getRouterParams: vi.fn(),
  useRuntimeConfig: () => ({ app: { baseURL: '/' } }),
}))

const TWO_DISKS = { default: { adapter: 'fs' }, documents: { adapter: 's3-fetch' } } satisfies DriveFeatureOptions

/** Where the compiler finds a file of the repo. */
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/** Runs the drive setup over a fake Nuxt that has what the drive feature touches: handlers. */
function setupDrive(options: DriveFeatureOptions, { root = '/app', dev = false, layers = [] as string[] } = {}) {
  const nuxt = fakeNuxt(root, { dev, layers: [root, ...layers.map(layer => join(root, layer))] })

  Object.assign(nuxt.options, { serverHandlers: [] })
  setupDriveFeature(nuxt as never, options)

  return nuxt as typeof nuxt & { options: typeof nuxt.options & { serverHandlers: { route: string, handler: string }[] } }
}

/** Runs the #capsa/drive the setup generated on capsa's own runtime, over stand-ins for files-sdk and `modules`. */
function driveModule(nuxt: ReturnType<typeof setupDrive>, modules: Record<string, object> = {}) {
  const adapter = (name: string) => vi.fn((options: object) => ({ name, options }))
  const adapters = { fs: adapter('fs'), s3Fetch: adapter('s3-fetch') }
  const createFiles = vi.fn((options: object) => options)
  const { useCapsaDrive } = runModule(nuxt.options.nitro.virtual['#capsa/drive']!(), {
    'files-sdk': { createFiles },
    'files-sdk/fs': adapters,
    'files-sdk/s3-fetch': adapters,
    'nuxt-capsa/drive/server': { defineDrive },
    ...modules,
  }, '{ useCapsaDrive }') as { useCapsaDrive: (name?: string) => { adapter: { name: string, options: Record<string, unknown> } } }

  return { useCapsaDrive, createFiles, adapters }
}

describe('drive setup', () => {
  afterEach(() => void vi.unstubAllEnvs())

  it('refuses a disk name a variable cannot spell, and an adapter name files-sdk cannot export', () => {
    expect(() => setupDrive({ 'default': { adapter: 'fs' }, 'user-files': { adapter: 'fs' } })).toThrow('[capsa] invalid drive disk name "user-files": use only letters, numbers and "_".')
    expect(() => setupDrive({ default: { adapter: 'S3 Fetch' } })).toThrow('[capsa] drive disk "default" names "S3 Fetch" as its adapter: write it as files-sdk exports it, like "s3-fetch" for files-sdk/s3-fetch.')
  })

  it('imports each adapter once from the project\'s files-sdk, by its name in camel case, and knows none of them', () => {
    const nuxt = setupDrive({ ...TWO_DISKS, userFiles: { adapter: 's3-fetch' }, avatars: { adapter: 'vercel-blob' } })

    expect(nuxt.options.nitro.virtual['#capsa/drive']!()).toBe(`import { createFiles } from 'files-sdk'
import { fs } from 'files-sdk/fs'
import { s3Fetch } from 'files-sdk/s3-fetch'
import { vercelBlob } from 'files-sdk/vercel-blob'
import { defineDrive } from 'nuxt-capsa/drive/server'

export const { useCapsaDrive, serveSigned } = defineDrive({
  createFiles,
  disks: {
    "default": { adapter: fs, env: "NUXT_CAPSA_DRIVE_DEFAULT", defaults: {"root":".data/capsa/drive/default"} },
    "documents": { adapter: s3Fetch, env: "NUXT_CAPSA_DRIVE_DOCUMENTS", defaults: {} },
    "userFiles": { adapter: s3Fetch, env: "NUXT_CAPSA_DRIVE_USER_FILES", defaults: {} },
    "avatars": { adapter: vercelBlob, env: "NUXT_CAPSA_DRIVE_AVATARS", defaults: {} },
  },
})
`)
  })

  it('builds a disk on first use and once, with every variable of its own as an option of the adapter', () => {
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_BUCKET', 'docs')
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_ACCESS_KEY_ID', 'key')
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_PUBLIC_BASE_URL', 'https://cdn.example')
    // A variable is text: only `true` and `false` are read back from it.
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_FORCE_PATH_STYLE', 'true')
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_DEFAULT_URL_EXPIRES_IN', '60')
    // An empty one sets nothing, so the adapter's own default stands.
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_REGION', '')
    const { useCapsaDrive, createFiles, adapters } = driveModule(setupDrive(TWO_DISKS))

    expect(createFiles).not.toHaveBeenCalled()

    const documents = useCapsaDrive('documents')

    // An adapter other than fs is files-sdk's own, untouched.
    expect(documents.adapter).toEqual({ name: 's3-fetch', options: { bucket: 'docs', accessKeyId: 'key', publicBaseUrl: 'https://cdn.example', forcePathStyle: true, defaultUrlExpiresIn: '60' } })
    expect(useCapsaDrive('documents')).toBe(documents)
    expect(createFiles).toHaveBeenCalledOnce()
    expect(adapters.fs).not.toHaveBeenCalled()
  })

  it('keeps the files of an fs disk in .data/capsa/drive/<name>, until its ROOT variable names another folder', () => {
    const first = driveModule(setupDrive(TWO_DISKS))

    expect(first.useCapsaDrive().adapter).toMatchObject({ name: 'fs', options: { root: '.data/capsa/drive/default' } })
    expect(first.useCapsaDrive('default')).toBe(first.useCapsaDrive())

    vi.stubEnv('NUXT_CAPSA_DRIVE_DEFAULT_ROOT', '/var/files')

    expect(driveModule(setupDrive(TWO_DISKS)).useCapsaDrive().adapter.options).toEqual({ root: '/var/files' })
  })

  it('mounts the route of the links capsa signs only when a disk is on fs', () => {
    expect(setupDrive(TWO_DISKS).options.serverHandlers).toEqual([{ route: '/_capsa/drive/:disk/**:key', handler: runtimePath('drive/handler') }])
    expect(setupDrive({ default: { adapter: 's3-fetch' } }).options.serverHandlers).toEqual([])
  })

  it('gives a variable to the disk with the longest name it starts with', () => {
    vi.stubEnv('NUXT_CAPSA_DRIVE_USER_BUCKET', 'of-user')
    vi.stubEnv('NUXT_CAPSA_DRIVE_USER_FILES_BUCKET', 'of-user-files')
    const { useCapsaDrive } = driveModule(setupDrive({ default: { adapter: 'fs' }, user: { adapter: 's3-fetch' }, userFiles: { adapter: 's3-fetch' } }))

    // Not `filesBucket` of the disk `user`.
    expect(useCapsaDrive('user').adapter.options).toEqual({ bucket: 'of-user' })
    expect(useCapsaDrive('userFiles').adapter.options).toEqual({ bucket: 'of-user-files' })
  })

  it('adds the disk and the name of its variables to what files-sdk says of a wrong option, and lists the disks for an unknown name', () => {
    const nuxt = setupDrive(TWO_DISKS)
    const failing = () => {
      throw new Error('s3-fetch adapter: missing endpoint. Pass `endpoint`.')
    }
    const { useCapsaDrive } = runModule(nuxt.options.nitro.virtual['#capsa/drive']!(), {
      'files-sdk': { createFiles: (options: object) => options },
      'files-sdk/fs': { fs: (options: object) => options },
      'files-sdk/s3-fetch': { s3Fetch: failing },
      'nuxt-capsa/drive/server': { defineDrive },
    }, '{ useCapsaDrive }') as { useCapsaDrive: (name?: string) => object }

    expect(() => useCapsaDrive('documents')).toThrow('[capsa] drive disk "documents": s3-fetch adapter: missing endpoint. Pass `endpoint`. Its options are its variables: NUXT_CAPSA_DRIVE_DOCUMENTS_<OPTION>.')
    expect(() => useCapsaDrive('avatars')).toThrow('[capsa] unknown drive disk "avatars". Configured: default, documents.')
    // A name every object has is still not a disk.
    expect(() => useCapsaDrive('constructor')).toThrow('[capsa] unknown drive disk "constructor".')
  })

  it('imports the project\'s config.ts of a disk and hands it to that disk alone, and never a layer\'s', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capsa-drive-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await writeFiles(root, { 'server/capsa/drive/documents/config.ts': '', 'layers/base/server/capsa/drive/default/config.ts': '' })
    const nuxt = setupDrive(TWO_DISKS, { root, layers: ['layers/base'] })

    expect(nuxt.options.nitro.virtual['#capsa/drive']!()).toBe(`import { createFiles } from 'files-sdk'
import { fs } from 'files-sdk/fs'
import { s3Fetch } from 'files-sdk/s3-fetch'
import { defineDrive } from 'nuxt-capsa/drive/server'
import config_documents from '#capsa/root/server/capsa/drive/documents/config'

export const { useCapsaDrive, serveSigned } = defineDrive({
  createFiles,
  disks: {
    "default": { adapter: fs, env: "NUXT_CAPSA_DRIVE_DEFAULT", defaults: {"root":".data/capsa/drive/default"} },
    "documents": { adapter: s3Fetch, env: "NUXT_CAPSA_DRIVE_DOCUMENTS", defaults: {}, config: config_documents },
  },
})
`)
  })

  it('builds a disk with what its config.ts returns over its variables, and with its plugins after serve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capsa-drive-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await writeFiles(root, { 'server/capsa/drive/documents/config.ts': '' })
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_BUCKET', 'docs')
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_REGION', 'auto')
    const plugin = { name: 'audit' }
    const config = defineDriveConfig('documents' as never, {
      // `undefined` keeps what the variable set, as in a db's config.ts.
      options: ({ bucket }) => ({ bucket: `${bucket}-eu`, region: undefined, forcePathStyle: true }),
      plugins: [plugin],
    })
    const { useCapsaDrive, createFiles } = driveModule(setupDrive(TWO_DISKS, { root }), { '#capsa/root/server/capsa/drive/documents/config': { default: config } })

    expect(useCapsaDrive('documents').adapter.options).toEqual({ bucket: 'docs-eu', region: 'auto', forcePathStyle: true })
    expect(createFiles.mock.calls[0]![0]).toMatchObject({ plugins: [{ name: 'capsa:serve' }, plugin] })
    // A disk without a config.ts has capsa's plugin alone.
    useCapsaDrive()
    expect(createFiles.mock.calls[1]![0]).toMatchObject({ plugins: [{ name: 'capsa:serve' }] })
  })

  it('restarts Nuxt in dev when the config.ts of a disk is created or deleted, and not when one is edited', async () => {
    const nuxt = setupDrive(TWO_DISKS, { dev: true, layers: ['layers/base'] })
    let restarts = 0

    nuxt.hook('restart', () => void restarts++)

    await nuxt.callHook('builder:watch', 'add', '/app/server/capsa/drive/documents/config.ts')
    await nuxt.callHook('builder:watch', 'unlink', '/app/server/capsa/drive/default/config.ts')
    await nuxt.callHook('builder:watch', 'change', '/app/server/capsa/drive/documents/config.ts')
    // Not a disk of capsa.drive, and a layer's.
    await nuxt.callHook('builder:watch', 'add', '/app/server/capsa/drive/avatars/config.ts')
    await nuxt.callHook('builder:watch', 'add', '/app/layers/base/server/capsa/drive/default/config.ts')

    expect(restarts).toBe(2)
  })

  it('types each disk as the Files of files-sdk over its adapter with serve, and refuses a name capsa.drive does not have', async () => {
    const nuxt = setupDrive(TWO_DISKS)
    const types = nuxt.options.build.templates.find(template => template.filename === 'types/capsa-drive.d.ts')!.getContents({})

    expect(await typeErrors({
      'capsa-drive.d.ts': types,
      'use.ts': `import { useCapsaDrive } from '#capsa/drive'
import type { RequestEvent } from 'nuxt/server'

declare const event: RequestEvent
const fromDefault: Promise<string> = useCapsaDrive().url('a.txt')
const signs: boolean = useCapsaDrive('documents').adapter.capabilities!.signedUrl!.supported!
const served: Promise<Response> = useCapsaDrive('documents').serve(event, 'a.txt', { download: 'a.txt' })
useCapsaDrive().serve(event, 'a.txt', { mode: 'proxy' })
// @ts-expect-error a proxy streams the bytes: there is no link to expire
useCapsaDrive().serve(event, 'a.txt', { mode: 'proxy', expiresIn: 60 })
// @ts-expect-error not a disk of capsa.drive
useCapsaDrive('avatars')
export { fromDefault, signs, served }`,
    }, {
      paths: { 'nuxt-capsa/drive/server': [at('../../src/runtime/drive/server.ts')] },
      skipLibCheck: true,
    })).toEqual([])
    // The compiler reads Nuxt's server types here, which is slow while the built apps of the suite start too.
  }, 30_000)

  it('types the config.ts of a disk by its adapter, and gives the disk the methods its plugins add', async () => {
    const disk = (name: string, adapter: string, config?: string): Disk => ({ name, adapter, env: '', defaults: {}, config })
    const disks = [disk('default', 'fs'), disk('documents', 's3-fetch', './documents-config')]

    expect(await typeErrors({
      'capsa-drive.d.ts': renderDriveTypes(disks),
      'capsa-drive-config.d.ts': renderConfigTypes(disks),
      'documents-config.ts': `import { usage } from 'files-sdk/usage'
import { defineDriveConfig } from 'nuxt-capsa/drive'

export default defineDriveConfig('documents', {
  options: ({ region }) => ({ region: String(region), forcePathStyle: true }),
  plugins: [usage()],
})`,
      'use.ts': `import { useCapsaDrive } from '#capsa/drive'
import { defineDriveConfig } from 'nuxt-capsa/drive'

export const operations: number = useCapsaDrive('documents').usage().operations
// @ts-expect-error a disk without plugins has no usage
useCapsaDrive().usage()
defineDriveConfig('default', { options: () => ({ root: '/srv/files' }) })
// @ts-expect-error not a disk of capsa.drive
defineDriveConfig('avatars', {})
// @ts-expect-error not an option of s3-fetch
defineDriveConfig('documents', { options: () => ({ bucketName: 'docs' }) })
// @ts-expect-error a wrong type for an option of s3-fetch
defineDriveConfig('documents', { options: () => ({ forcePathStyle: 'yes' }) })
// @ts-expect-error not a plugin of files-sdk
defineDriveConfig('documents', { plugins: [{ nope: true }] })`,
    }, {
      paths: { 'nuxt-capsa/drive': [at('../../src/runtime/drive/index.ts')], 'nuxt-capsa/drive/server': [at('../../src/runtime/drive/server.ts')] },
      skipLibCheck: true,
    })).toEqual([])
  }, 30_000)
})
