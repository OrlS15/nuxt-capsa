import type { RequestEvent } from 'nuxt/server'
import { defineDriveConfig } from 'nuxt-capsa/drive'

// Read by vue-tsc alone: no route imports it. Each error below is one an `any` would let through.
declare const event: RequestEvent

export const link: Promise<string> = useCapsaDrive().url('a.txt')
export const root: string = useCapsaDrive().adapter.root
export const operations: number = useCapsaDrive('archive').usage().operations
export const served: Promise<Response> = useCapsaDrive('documents').serve(event, 'a.txt', { mode: 'proxy' })

// @ts-expect-error Not a disk of capsa.drive.
useCapsaDrive('avatars')
// @ts-expect-error A disk on s3-fetch has no root: the adapter is the one the disk names.
export const noRoot = useCapsaDrive('documents').adapter.root
// @ts-expect-error A disk without plugins has no usage.
useCapsaDrive('documents').usage()
// @ts-expect-error A proxy streams the bytes: there is no link to expire.
useCapsaDrive().serve(event, 'a.txt', { mode: 'proxy', expiresIn: 60 })

defineDriveConfig('documents', { options: () => ({ forcePathStyle: true }) })
// @ts-expect-error Not a disk of capsa.drive.
defineDriveConfig('avatars', {})
// @ts-expect-error Not an option of s3-fetch.
defineDriveConfig('documents', { options: () => ({ bucketName: 'docs' }) })
// @ts-expect-error Not a plugin of files-sdk.
defineDriveConfig('documents', { plugins: [{ nope: true }] })
