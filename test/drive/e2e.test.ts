import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fetch, getServerLogs, setup, startServer } from '@nuxt/test-utils/e2e'
import { ACCESS_KEY, SECRET_KEY, startFakeS3 } from './fake-s3'

const root = fileURLToPath(new URL('../fixtures/drive', import.meta.url))
// The built server runs in the test's cwd: a folder of its own, never the repo's `.data`.
const folder = await mkdtemp(join(tmpdir(), 'capsa-drive-'))
const s3 = await startFakeS3()
const env = {
  // What capsa derives the key of the links it signs for the fs disk from.
  NUXT_APP_SECRET: 'a-secret-of-the-drive-e2e-app-32-chars',
  NUXT_CAPSA_DRIVE_DEFAULT_ROOT: folder,
  NUXT_CAPSA_DRIVE_ARCHIVE_ROOT: join(folder, 'archive'),
  NUXT_CAPSA_DRIVE_DOCUMENTS_BUCKET: 'documents',
  NUXT_CAPSA_DRIVE_DOCUMENTS_ENDPOINT: s3.url,
  NUXT_CAPSA_DRIVE_DOCUMENTS_REGION: 'auto',
  NUXT_CAPSA_DRIVE_DOCUMENTS_ACCESS_KEY_ID: ACCESS_KEY,
  NUXT_CAPSA_DRIVE_DOCUMENTS_SECRET_ACCESS_KEY: SECRET_KEY,
  NUXT_CAPSA_DRIVE_DOCUMENTS_FORCE_PATH_STYLE: 'true',
}

/** Stores text on a disk through the app, then reads it back. */
async function roundTrip(disk: string, key: string, text: string) {
  const stored = await fetch(`/api/files/${disk}/${key}`, { method: 'PUT', body: text })
  const read = await fetch(`/api/files/${disk}/${key}`)

  return { stored: stored.status, info: await stored.json(), read: await read.text() }
}

describe('a built app with disks on the file system and on S3', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(async () => {
    await s3.close()
    await rm(folder, { recursive: true, force: true })
  })

  await setup({ rootDir: root, env })

  it('keeps the files of the default disk in the folder NUXT_CAPSA_DRIVE_DEFAULT_ROOT names', async () => {
    expect(await roundTrip('default', 'notes/hello.txt', 'hello from fs')).toMatchObject({ stored: 200, info: { key: 'notes/hello.txt', size: 13 }, read: 'hello from fs' })
    expect(existsSync(join(folder, 'notes/hello.txt'))).toBe(true)
  })

  it('signs every request of the documents disk with what its variables hold, the boolean one read back from its text', async () => {
    expect(await roundTrip('documents', 'contracts/one.txt', 'hello from S3')).toMatchObject({ stored: 200, info: { key: 'contracts/one.txt', size: 13 }, read: 'hello from S3' })
    expect(s3.seen.refused).toBe(0)
    expect(s3.seen.signed).toBeGreaterThan(0)
    // NUXT_CAPSA_DRIVE_DOCUMENTS_FORCE_PATH_STYLE is the text "true": with the boolean, the bucket is in the path.
    expect(s3.seen.paths).toContain('/documents/contracts/one.txt')
  })

  it('hands out a link files-sdk signed, which S3 answers until it expires', async () => {
    await roundTrip('documents', 'contracts/two.txt', 'a signed download')
    const link = await (await fetch('/api/link/documents/contracts/two.txt?expiresIn=60')).text()

    expect(new URL(link).searchParams.get('X-Amz-Expires')).toBe('60')
    expect(await (await globalThis.fetch(link)).text()).toBe('a signed download')
  })

  it('signs links to the files of the fs disk, and answers each one only as it was signed', async () => {
    await roundTrip('default', 'docs/report.txt', 'a report on fs')
    const link = await (await fetch('/api/link/default/docs/report.txt?expiresIn=60&disposition=attachment')).text()

    expect(link).toMatch(/^\/_capsa\/drive\/default\/docs\/report\.txt\?expires=\d+&disposition=attachment&signature=[\da-f]{64}$/)

    const response = await fetch(link)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(await response.text()).toBe('a report on fs')

    // Whatever changes in the link breaks its signature: the expiry, the disposition, the key, the method.
    for (const forged of [link.replace(/expires=\d+/, 'expires=9999999999'), link.replace('=attachment', '=inline'), link.replace('report', 'other')])
      expect((await fetch(forged)).status).toBe(403)

    expect((await fetch(link, { method: 'PUT', body: 'overwritten' })).status).toBe(403)
  })

  it('stops answering a link of the fs disk once it expires', async () => {
    await roundTrip('default', 'docs/brief.txt', 'short-lived')
    const link = await (await fetch('/api/link/default/docs/brief.txt?expiresIn=1')).text()

    await new Promise(resolve => setTimeout(resolve, 2000))

    expect((await fetch(link)).status).toBe(403)
  })

  it('signs an upload to the fs disk for one type, as S3 signs a PUT', async () => {
    const upload = await (await fetch('/api/upload-link/default/uploads/note.txt?type=text/plain')).json()

    expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'text/plain' } })
    expect((await fetch(upload.url, { method: 'PUT', body: '<p>another type</p>', headers: { 'content-type': 'text/html' } })).status).toBe(403)
    expect((await fetch(upload.url, { method: 'PUT', body: 'uploaded by the browser', headers: upload.headers })).status).toBe(200)
    expect(await (await fetch('/api/files/default/uploads/note.txt')).text()).toBe('uploaded by the browser')
    // A link to upload does not download.
    expect((await fetch(upload.url)).status).toBe(403)
  })

  it('serves a file with a redirect to a link of the store, which S3 signs, and capsa for the fs disk', async () => {
    await roundTrip('documents', 'contracts/three.txt', 'served from S3')
    const fromS3 = await fetch(`/api/serve/documents/contracts/three.txt?download=${encodeURIComponent('contratto è.txt')}`, { redirect: 'manual' })
    const location = new URL(fromS3.headers.get('location')!)

    expect(fromS3.status).toBe(302)
    expect(location.searchParams.get('response-content-disposition')).toBe(`attachment; filename="contratto _.txt"; filename*=UTF-8''contratto%20%C3%A8.txt`)
    expect(await (await globalThis.fetch(location)).text()).toBe('served from S3')

    await roundTrip('default', 'docs/served.txt', 'served from fs')
    const fromFs = await fetch('/api/serve/default/docs/served.txt', { redirect: 'manual' })

    expect(fromFs.headers.get('location')).toMatch(/^\/_capsa\/drive\/default\/docs\/served\.txt\?expires=\d+&signature=/)
    expect(await (await fetch(fromFs.headers.get('location')!)).text()).toBe('served from fs')
  })

  it('streams a file through the server in proxy mode, one range at a time when the browser asks', async () => {
    await roundTrip('default', 'videos/clip.txt', '0123456789')
    const whole = await fetch('/api/serve/default/videos/clip.txt?mode=proxy&download=clip.txt')

    expect(whole.status).toBe(200)
    expect(Object.fromEntries(whole.headers)).toMatchObject({
      'accept-ranges': 'bytes',
      'content-length': '10',
      'content-type': 'text/plain',
      'content-disposition': `attachment; filename="clip.txt"; filename*=UTF-8''clip.txt`,
      'x-content-type-options': 'nosniff',
    })
    expect(await whole.text()).toBe('0123456789')

    const ranged = async (range: string) => {
      const response = await fetch('/api/serve/default/videos/clip.txt?mode=proxy', { headers: { range } })

      return { status: response.status, range: response.headers.get('content-range'), body: await response.text() }
    }

    expect(await ranged('bytes=2-4')).toEqual({ status: 206, range: 'bytes 2-4/10', body: '234' })
    expect(await ranged('bytes=-3')).toEqual({ status: 206, range: 'bytes 7-9/10', body: '789' })
    expect(await ranged('bytes=10-')).toEqual({ status: 416, range: 'bytes */10', body: '' })
    // Several ranges are not read: the whole file goes out.
    expect(await ranged('bytes=0-1,4-5')).toEqual({ status: 200, range: null, body: '0123456789' })
    expect((await fetch('/api/serve/default/videos/none.txt?mode=proxy')).status).toBe(404)
  })

  it('answers the whole file, as a 200, when the store ignores the range it was asked for', async () => {
    // The stand-in S3 ignores Range, as some S3-compatible stores do, and files-sdk does not notice.
    await roundTrip('documents', 'videos/clip.txt', '0123456789')
    const response = await fetch('/api/serve/documents/videos/clip.txt?mode=proxy', { headers: { range: 'bytes=2-4' } })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBeNull()
    expect(await response.text()).toBe('0123456789')
  })

  it('builds a disk with what its config.ts sets: options over its variables, and the plugins of files-sdk after serve', async () => {
    expect((await roundTrip('archive', 'old.txt', 'kept for years')).read).toBe('kept for years')
    // The folder the options hook returns, from the one NUXT_CAPSA_DRIVE_ARCHIVE_ROOT names.
    expect(existsSync(join(folder, 'archive/from-config/old.txt'))).toBe(true)
    expect(await (await fetch('/api/serve/archive/old.txt?mode=proxy')).text()).toBe('kept for years')
    // The usage plugin counts every call that went through the disk, serve's own download among them.
    expect(await (await fetch('/api/usage')).json()).toMatchObject({ operationsByKind: { upload: 1, download: 2 } })
  })

  it('says which disk lacks an option, in files-sdk\'s own words, and where its options come from', async () => {
    await startServer({ env: { ...env, NUXT_CAPSA_DRIVE_DOCUMENTS_ENDPOINT: '' } })

    const response = await fetch('/api/files/documents/any.txt')

    expect(response.status).toBe(500)
    expect(getServerLogs().join('\n')).toMatch(/\[capsa\] drive disk "documents": s3-fetch adapter: missing endpoint\..* Its options are its variables: NUXT_CAPSA_DRIVE_DOCUMENTS_<OPTION>\./)
    // The default disk is another one: it still works.
    expect((await roundTrip('default', 'still.txt', 'fine')).read).toBe('fine')
  })

  it('refuses a disk that capsa.drive does not have', async () => {
    expect((await fetch('/api/files/nope/any.txt')).status).toBe(500)
    expect(getServerLogs().join('\n')).toContain('[capsa] unknown drive disk "nope". Configured: default, documents, archive.')
  })
})
