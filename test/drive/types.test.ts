import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Disk } from '../../src/drive/setup'
import { renderConfigTypes, renderDriveTypes } from '../../src/drive/templates'
import { typeErrors } from '../helpers/types'

/** Where the compiler finds a file of the repo. */
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/** What an app's tsconfig gives: capsa's drive runtime, and files-sdk's own declarations, unchecked. */
const APP = {
  paths: { 'nuxt-capsa/drive': [at('../../src/runtime/drive/index.ts')], 'nuxt-capsa/drive/server': [at('../../src/runtime/drive/server.ts')] },
  skipLibCheck: true,
}

const disk = (name: string, adapter: string, config?: string): Disk => ({ name, adapter, env: '', defaults: {}, config })

// Each test compiles against files-sdk's own types, and Nuxt's server types: a few seconds each, past vitest's default.
describe('types of the drive feature', { timeout: 30_000 }, () => {
  it('types each disk as the Files of files-sdk over its adapter with serve, and refuses a name capsa.drive does not have', async () => {
    expect(await typeErrors({
      'capsa-drive.d.ts': renderDriveTypes([disk('default', 'fs'), disk('documents', 's3-fetch')]),
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
    }, APP)).toEqual([])
  })

  it('types the config.ts of a disk by its adapter, and gives the disk the methods its plugins add', async () => {
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
    }, APP)).toEqual([])
  })

  it('finds in files-sdk\'s adapters and disks what capsa\'s runtime calls on them', async () => {
    // capsa's runtime never imports files-sdk: it declares what it calls, and these are those declarations.
    expect(await typeErrors({
      'contract.ts': `import type { Files, FilesPlugin } from 'files-sdk'
import type { fs } from 'files-sdk/fs'
import type { memory } from 'files-sdk/memory'
import type { r2 } from 'files-sdk/r2'
import type { s3Fetch } from 'files-sdk/s3-fetch'
import type { vercelBlob } from 'files-sdk/vercel-blob'
import type { DiskParts, DriveParts, Serve } from 'nuxt-capsa/drive/server'

type Adapter = ReturnType<DiskParts['adapter']>
type Disk = ReturnType<DriveParts['createFiles']>
type IsAdapter<A extends Adapter> = A
type IsDisk<D extends Disk> = D

export type Adapters = [
  IsAdapter<ReturnType<typeof fs>>,
  IsAdapter<ReturnType<typeof memory>>,
  IsAdapter<ReturnType<typeof r2>>,
  IsAdapter<ReturnType<typeof s3Fetch>>,
  IsAdapter<ReturnType<typeof vercelBlob>>,
]
export type Disks = [IsDisk<Files<ReturnType<typeof fs>>>, IsDisk<Files<ReturnType<typeof s3Fetch>>>]

// capsa's serve plugin receives the disk files-sdk hands a plugin's extend.
export const serve: FilesPlugin<{ serve: Serve['serve'] }> = { name: 'capsa:serve', extend: (disk: Disk) => ({ serve: async () => new Response(String(disk)) }) }`,
    }, APP)).toEqual([])
  })
})
