import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { setupDriveFeature, type DriveFeatureOptions } from '../../src/drive/setup'
import { log, runtimePath } from '../../src/utils'
import { fakeNuxt, writeFiles } from '../helpers/nuxt'

const TWO_DISKS = { default: { adapter: 'fs' }, documents: { adapter: 's3-fetch' } } satisfies DriveFeatureOptions

/** A Nuxt over which the drive setup ran, with what the drive feature touches: handlers. */
type DriveNuxt = ReturnType<typeof fakeNuxt> & { options: { serverHandlers: { route: string, handler: string }[] } }

/**
 * Runs the drive setup over a fake Nuxt, and waits for the check of files-sdk's version it hands back.
 *
 * @example
 * const nuxt = await setupDrive({ default: { adapter: 'fs' } })
 * nuxt.options.nitro.virtual['#capsa/drive']!()  // the module of the disks
 */
async function setupDrive(options: DriveFeatureOptions, { root = '/app', dev = false, layers = [] as string[] } = {}) {
  const nuxt = fakeNuxt(root, { dev, layers: [root, ...layers.map(layer => join(root, layer))] })

  Object.assign(nuxt.options, { serverHandlers: [] })
  await setupDriveFeature(nuxt as never, options)

  return nuxt as DriveNuxt
}

/** What the setup generated under a filename: a server module, or a type template. */
function generated(nuxt: DriveNuxt, filename: string) {
  return nuxt.options.nitro.virtual[filename]?.() ?? nuxt.options.build.templates.find(template => template.filename === filename)!.getContents({})
}

/** A temporary project, removed after the test. */
async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'capsa-drive-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFiles(root, files)

  return root
}

describe('drive setup', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses a disk name a variable cannot spell, and an adapter name files-sdk cannot export, before it registers anything', () => {
    const nuxt = fakeNuxt('/app')

    expect(() => setupDriveFeature(nuxt as never, { 'default': { adapter: 'fs' }, 'user-files': { adapter: 'fs' } })).toThrow('[capsa] invalid drive disk name "user-files": use only letters, numbers and "_".')
    expect(() => setupDriveFeature(nuxt as never, { default: { adapter: 'S3 Fetch' } })).toThrow('[capsa] drive disk "default" names "S3 Fetch" as its adapter: write it as files-sdk exports it, like "s3-fetch" for files-sdk/s3-fetch.')
    expect(nuxt.options.nitro.virtual).toEqual({})
  })

  it('imports each adapter once from the project\'s files-sdk, by its name in camel case, and spells each disk\'s variables as Nitro does', async () => {
    const nuxt = await setupDrive({ ...TWO_DISKS, userFiles: { adapter: 's3-fetch' }, avatars: { adapter: 'vercel-blob' } })

    await expect(generated(nuxt, '#capsa/drive')).toMatchFileSnapshot('__snapshots__/drive.mjs')
  })

  it('keeps the files of an fs disk in .data/capsa/drive/<name>: under the project in dev, where the server starts in production', async () => {
    expect(generated(await setupDrive(TWO_DISKS), '#capsa/drive')).toContain(`"default": { adapter: fs, env: "NUXT_CAPSA_DRIVE_DEFAULT", defaults: {"root":".data/capsa/drive/default"} },`)
    expect(generated(await setupDrive(TWO_DISKS, { dev: true }), '#capsa/drive')).toContain(`defaults: {"root":"/app/.data/capsa/drive/default"}`)
  })

  it('mounts the route of the links capsa signs only when a disk is on fs', async () => {
    expect((await setupDrive(TWO_DISKS)).options.serverHandlers).toEqual([{ route: '/_capsa/drive/:disk/**:key', handler: runtimePath('drive/handler') }])
    expect((await setupDrive({ default: { adapter: 's3-fetch' } })).options.serverHandlers).toEqual([])
  })

  it('imports the project\'s config.ts of a disk and hands it to that disk alone, and never a layer\'s', async () => {
    const root = await project({ 'server/capsa/drive/documents/config.ts': '', 'layers/base/server/capsa/drive/default/config.ts': '' })
    const nuxt = await setupDrive(TWO_DISKS, { root, layers: ['layers/base'] })

    await expect(generated(nuxt, '#capsa/drive')).toMatchFileSnapshot('__snapshots__/drive-config.mjs')
  })

  it('types each disk as the Files of files-sdk over its adapter, and its config.ts by the adapter\'s options', async () => {
    const root = await project({ 'server/capsa/drive/documents/config.ts': '' })
    const nuxt = await setupDrive(TWO_DISKS, { root })

    await expect(generated(nuxt, 'types/capsa-drive.d.ts')).toMatchFileSnapshot('__snapshots__/capsa-drive.d.ts')
    await expect(generated(nuxt, 'types/capsa-drive-config.d.ts')).toMatchFileSnapshot('__snapshots__/capsa-drive-config.d.ts')
  })

  it('restarts Nuxt in dev when the config.ts of a disk is created or deleted, and not when one is edited', async () => {
    const nuxt = await setupDrive(TWO_DISKS, { dev: true, layers: ['layers/base'] })
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

  it('warns when the project\'s files-sdk is outside the range capsa supports', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const root = await project({
      'node_modules/files-sdk/package.json': JSON.stringify({ name: 'files-sdk', version: '2.0.0', type: 'module', exports: { '.': './index.js' } }),
      'node_modules/files-sdk/index.js': 'export {}',
    })

    await setupDrive(TWO_DISKS, { root })

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toMatch(/^`files-sdk@2\.0\.0` is installed, but capsa supports `files-sdk@/)
  })
})
