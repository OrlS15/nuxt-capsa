import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { ACCESS_KEY, SECRET_KEY, startFakeS3 } from './fake-s3'

const root = fileURLToPath(new URL('../fixtures/drive', import.meta.url))
const folder = await mkdtemp(join(tmpdir(), 'capsa-drive-dev-'))
const s3 = await startFakeS3()

/** Stores text on a disk through the app, and reads it back. */
async function roundTrip(disk: string, key: string, text: string) {
  await fetch(`/api/files/${disk}/${key}`, { method: 'PUT', body: text })

  return (await fetch(`/api/files/${disk}/${key}`)).text()
}

describe('disks on the file system and on S3 under nuxt dev', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(async () => {
    await s3.close()
    await rm(folder, { recursive: true, force: true })
  })

  // No NUXT_APP_SECRET: in dev, Nuxt generates the secret that a build requires.
  await setup({
    rootDir: root,
    dev: true,
    env: {
      NUXT_CAPSA_DRIVE_DEFAULT_ROOT: folder,
      NUXT_CAPSA_DRIVE_ARCHIVE_ROOT: join(folder, 'archive'),
      NUXT_CAPSA_DRIVE_DOCUMENTS_BUCKET: 'documents',
      NUXT_CAPSA_DRIVE_DOCUMENTS_ENDPOINT: s3.url,
      NUXT_CAPSA_DRIVE_DOCUMENTS_REGION: 'auto',
      NUXT_CAPSA_DRIVE_DOCUMENTS_ACCESS_KEY_ID: ACCESS_KEY,
      NUXT_CAPSA_DRIVE_DOCUMENTS_SECRET_ACCESS_KEY: SECRET_KEY,
      NUXT_CAPSA_DRIVE_DOCUMENTS_FORCE_PATH_STYLE: 'true',
    },
  })

  it('keeps the files of the fs disk in the folder its variable names', async () => {
    expect(await roundTrip('default', 'notes/hello.txt', 'hello from fs')).toBe('hello from fs')
    expect(existsSync(join(folder, 'notes/hello.txt'))).toBe(true)
  })

  it('signs every request of the S3 disk with what its variables hold', async () => {
    expect(await roundTrip('documents', 'contracts/one.txt', 'hello from S3')).toBe('hello from S3')
    expect(s3.seen.refused).toBe(0)
    expect(s3.seen.paths).toContain('/documents/contracts/one.txt')
  })

  it('builds a disk with what its config.ts sets', async () => {
    expect(await roundTrip('archive', 'old.txt', 'kept for years')).toBe('kept for years')
    expect(existsSync(join(folder, 'archive/from-config/old.txt'))).toBe(true)
    expect(await (await fetch('/api/usage')).json()).toMatchObject({ operationsByKind: { upload: 1, download: 1 } })
  })

  it('answers a link of the fs disk with no NUXT_APP_SECRET set', async () => {
    await roundTrip('default', 'docs/report.txt', 'a report on fs')
    const link = await (await fetch('/api/link/default/docs/report.txt')).text()

    expect(link).toMatch(/^\/_capsa\/drive\/default\/docs\/report\.txt\?/)
    expect(await (await fetch(link)).text()).toBe('a report on fs')
  })
})
