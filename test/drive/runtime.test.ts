import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFiles, type ExtensionsOf, type Files } from 'files-sdk'
import { fs } from 'files-sdk/fs'
import { memory } from 'files-sdk/memory'
import { s3Fetch } from 'files-sdk/s3-fetch'
import { usage } from 'files-sdk/usage'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Disk } from '../../src/drive/setup'
import { renderDriveModule } from '../../src/drive/templates'
import { defineDriveConfig } from '../../src/runtime/drive'
import type { Serve } from '../../src/runtime/drive/server'
import { runModule } from '../helpers/nuxt'

/** What `nuxt/server` gives the drive runtime here: the secret is fixed, and `baseURL` can move. */
const server = vi.hoisted(() => ({
  config: { app: { baseURL: '/' } },
  deriveSecret: vi.fn(async (_salt: string) => 'a-secret-of-the-drive-tests-32-chars'),
}))

vi.mock('nuxt/server', () => ({
  createError: (input: { status: number, message?: string }) => Object.assign(new Error(input.message), input),
  deriveSecret: server.deriveSecret,
  // Nitro decodes the params of the route, as `{ decode: true }` asks.
  getRouterParams: (event: { context: { params: Record<string, string> } }) => event.context.params,
  useRuntimeConfig: () => server.config,
}))

const S3 = {
  NUXT_CAPSA_DRIVE_DOCUMENTS_BUCKET: 'docs',
  NUXT_CAPSA_DRIVE_DOCUMENTS_ENDPOINT: 'http://s3.test',
  NUXT_CAPSA_DRIVE_DOCUMENTS_REGION: 'auto',
  NUXT_CAPSA_DRIVE_DOCUMENTS_ACCESS_KEY_ID: 'key',
  NUXT_CAPSA_DRIVE_DOCUMENTS_SECRET_ACCESS_KEY: 'secret',
}

/** A disk of capsa.drive as the setup hands it to the module. */
function disk(name: string, adapter: string, { defaults = {}, config }: { defaults?: Record<string, string>, config?: string } = {}): Disk {
  return { name, adapter, env: `NUXT_CAPSA_DRIVE_${name.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`, defaults, config }
}

/** A disk as `useCapsaDrive` hands it back. */
type CapsaDisk = Files & Serve & Partial<ExtensionsOf<[ReturnType<typeof usage>]>>

/** What `#capsa/drive` exports. */
interface DriveModule {
  useCapsaDrive: (name?: string) => CapsaDisk
  serveSigned: (event: object) => Promise<Response>
}

/**
 * Runs the `#capsa/drive` capsa generates for `disks` on its own runtime and on the real files-sdk, each factory
 * spied on so a test sees what capsa called it with. `modules` adds or replaces modules, such as a disk's config.ts.
 *
 * @example
 * const { useCapsaDrive, factories } = await drive([disk('default', 'memory')])
 * useCapsaDrive().upload('a.txt', 'a')  // stored in memory
 */
async function drive(disks: Disk[], modules: Record<string, Record<string, unknown>> = {}) {
  // A module per test: its disks are built once, and the key links are signed with is derived once.
  vi.resetModules()
  const { defineDrive } = await import('../../src/runtime/drive/server')
  const factories = { createFiles: vi.fn(createFiles), fs: vi.fn(fs), memory: vi.fn(memory), s3Fetch: vi.fn(s3Fetch) }
  const exported = runModule(renderDriveModule(disks), {
    'files-sdk': { createFiles: factories.createFiles },
    'files-sdk/fs': { fs: factories.fs },
    'files-sdk/memory': { memory: factories.memory },
    'files-sdk/s3-fetch': { s3Fetch: factories.s3Fetch },
    'nuxt-capsa/drive/server': { defineDrive },
    ...modules,
  }, '{ useCapsaDrive, serveSigned }') as DriveModule

  return { ...exported, factories }
}

/** A folder for a disk on fs, removed after the test. */
async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'capsa-drive-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))

  return root
}

/** A request as Nitro hands it to `serve`. */
const event = (headers: Record<string, string> = {}) => ({ req: new Request('http://localhost/any', { headers }) })

/**
 * Sends a request to a link capsa signed, through `serveSigned`, the way Nitro routes `/_capsa/drive/:disk/**:key` to
 * it. A refusal is answered with its status, as Nitro would.
 *
 * @example
 * await answer(serveSigned, '/_capsa/drive/default/a.txt?expires=…&signature=…')  // { status: 200, body: 'a', headers }
 */
async function answer(serveSigned: DriveModule['serveSigned'], link: string, init: RequestInit = {}) {
  const url = new URL(link, 'http://localhost')
  const [disk, ...key] = url.pathname.slice(`${server.config.app.baseURL}_capsa/drive/`.length).split('/').map(decodeURIComponent)

  try {
    const response = await serveSigned({ req: new Request(url, init), url, context: { params: { disk, key: key.join('/') } } })

    return { status: response.status, body: await response.text(), headers: response.headers }
  }
  catch (error) {
    return { status: (error as { status: number }).status, body: '', headers: new Headers() }
  }
}

describe('a disk', () => {
  afterEach(() => void vi.unstubAllEnvs())

  it('is built on first use and once, with every variable of its own as an option of its adapter', async () => {
    for (const [name, value] of Object.entries(S3)) vi.stubEnv(name, value)
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_PUBLIC_BASE_URL', 'https://cdn.example')
    // A variable is text: only `true` and `false` are read back from it.
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_FORCE_PATH_STYLE', 'true')
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_DEFAULT_URL_EXPIRES_IN', '60')
    // An empty one sets nothing, so the adapter's own default stands.
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_SESSION_TOKEN', '')
    const { useCapsaDrive, factories } = await drive([disk('default', 'fs', { defaults: { root: '.data/capsa/drive/default' } }), disk('documents', 's3-fetch')])

    expect(factories.createFiles).not.toHaveBeenCalled()

    const documents = useCapsaDrive('documents')

    expect(factories.s3Fetch).toHaveBeenCalledExactlyOnceWith({
      bucket: 'docs',
      endpoint: 'http://s3.test',
      region: 'auto',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      publicBaseUrl: 'https://cdn.example',
      forcePathStyle: true,
      defaultUrlExpiresIn: '60',
    })
    // An adapter other than fs is files-sdk's own, untouched.
    expect(factories.createFiles.mock.calls[0]![0].adapter).toBe(factories.s3Fetch.mock.results[0]!.value)
    expect(useCapsaDrive('documents')).toBe(documents)
    expect(factories.createFiles).toHaveBeenCalledOnce()
    expect(factories.fs).not.toHaveBeenCalled()
  })

  it('keeps the files of an fs disk where capsa\'s default puts them, until its ROOT variable names another folder', async () => {
    const first = await drive([disk('default', 'fs', { defaults: { root: '.data/capsa/drive/default' } })])

    expect(first.useCapsaDrive()).toBe(first.useCapsaDrive('default'))
    expect(first.factories.fs).toHaveBeenCalledExactlyOnceWith({ root: '.data/capsa/drive/default' })

    vi.stubEnv('NUXT_CAPSA_DRIVE_DEFAULT_ROOT', '/var/files')
    const second = await drive([disk('default', 'fs', { defaults: { root: '.data/capsa/drive/default' } })])
    second.useCapsaDrive()

    expect(second.factories.fs).toHaveBeenCalledExactlyOnceWith({ root: '/var/files' })
  })

  it('gives a variable to the disk with the longest name it starts with', async () => {
    vi.stubEnv('NUXT_CAPSA_DRIVE_USER_ROOT', '/srv/user')
    vi.stubEnv('NUXT_CAPSA_DRIVE_USER_FILES_ROOT', '/srv/user-files')
    const { useCapsaDrive, factories } = await drive([disk('default', 'memory'), disk('user', 'fs'), disk('userFiles', 'fs')])

    useCapsaDrive('user')
    useCapsaDrive('userFiles')

    // Not `filesRoot` of the disk `user`.
    expect(factories.fs.mock.calls).toEqual([[{ root: '/srv/user' }], [{ root: '/srv/user-files' }]])
  })

  it('adds the disk and the name of its variables to what files-sdk says of a wrong option, and lists the disks for an unknown name', async () => {
    const { useCapsaDrive } = await drive([disk('default', 'memory'), disk('documents', 's3-fetch')])

    expect(() => useCapsaDrive('documents')).toThrow(/^\[capsa\] drive disk "documents": s3-fetch adapter: missing .+ Its options are its variables: NUXT_CAPSA_DRIVE_DOCUMENTS_<OPTION>\.$/)
    expect(() => useCapsaDrive('avatars')).toThrow('[capsa] unknown drive disk "avatars". Configured: default, documents.')
    // A name every object has is still not a disk.
    expect(() => useCapsaDrive('constructor')).toThrow('[capsa] unknown drive disk "constructor".')
  })

  it('is built with what its config.ts returns over its variables, and with its plugins after serve', async () => {
    for (const [name, value] of Object.entries(S3)) vi.stubEnv(name, value)
    const config = defineDriveConfig('documents' as never, {
      // `undefined` keeps what the variable set, as in a db's config.ts.
      options: ({ bucket }) => ({ bucket: `${bucket}-eu`, region: undefined, forcePathStyle: true }),
      plugins: [usage()],
    })
    const { useCapsaDrive, factories } = await drive(
      [disk('default', 'memory'), disk('documents', 's3-fetch', { config: '#capsa/root/server/capsa/drive/documents/config' })],
      { '#capsa/root/server/capsa/drive/documents/config': { default: config } },
    )

    const documents = useCapsaDrive('documents')

    expect(factories.s3Fetch).toHaveBeenCalledExactlyOnceWith({ bucket: 'docs-eu', endpoint: 'http://s3.test', region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret', forcePathStyle: true })
    expect(factories.createFiles.mock.calls[0]![0].plugins!.map(plugin => plugin.name)).toEqual(['capsa:serve', 'usage'])
    expect(typeof documents.usage).toBe('function')

    // A disk without a config.ts has capsa's plugin alone.
    useCapsaDrive()
    expect(factories.createFiles.mock.calls[1]![0].plugins!.map(plugin => plugin.name)).toEqual(['capsa:serve'])
  })
})

describe('serve', () => {
  afterEach(() => void vi.unstubAllEnvs())

  it('redirects to a link the store signs, for as long as asked, downloading under a name when asked', async () => {
    for (const [name, value] of Object.entries(S3)) vi.stubEnv(name, value)
    vi.stubEnv('NUXT_CAPSA_DRIVE_DOCUMENTS_FORCE_PATH_STYLE', 'true')
    const { useCapsaDrive } = await drive([disk('default', 'memory'), disk('documents', 's3-fetch')])

    const response = await useCapsaDrive('documents').serve(event() as never, 'contracts/three.txt', { expiresIn: 60, download: 'contratto è.txt' })
    const location = new URL(response.headers.get('location')!)

    expect(response.status).toBe(302)
    // The boolean read back from its text puts the bucket in the path.
    expect(location.pathname).toBe('/docs/contracts/three.txt')
    expect(location.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(location.searchParams.get('response-content-disposition')).toBe(`attachment; filename="contratto _.txt"; filename*=UTF-8''contratto%20%C3%A8.txt`)
  })

  it('streams a file through the server in proxy mode, one range at a time when the browser asks', async () => {
    const { useCapsaDrive } = await drive([disk('default', 'memory')])
    const files = useCapsaDrive()
    await files.upload('videos/clip.txt', '0123456789', { contentType: 'text/plain' })

    const whole = await files.serve(event() as never, 'videos/clip.txt', { mode: 'proxy', download: 'clip.txt' })

    expect(whole.status).toBe(200)
    expect(Object.fromEntries(whole.headers)).toEqual({
      'accept-ranges': 'bytes',
      'content-length': '10',
      'content-type': 'text/plain',
      'content-disposition': `attachment; filename="clip.txt"; filename*=UTF-8''clip.txt`,
      'x-content-type-options': 'nosniff',
    })
    expect(await whole.text()).toBe('0123456789')

    const ranged = async (range: string) => {
      const response = await files.serve(event({ range }) as never, 'videos/clip.txt', { mode: 'proxy' })

      return { status: response.status, range: response.headers.get('content-range'), body: await response.text() }
    }

    expect(await ranged('bytes=2-4')).toEqual({ status: 206, range: 'bytes 2-4/10', body: '234' })
    expect(await ranged('bytes=-3')).toEqual({ status: 206, range: 'bytes 7-9/10', body: '789' })
    expect(await ranged('bytes=8-20')).toEqual({ status: 206, range: 'bytes 8-9/10', body: '89' })
    expect(await ranged('bytes=10-')).toEqual({ status: 416, range: 'bytes */10', body: '' })
    // Several ranges, or another unit, are not read: the whole file goes out.
    expect(await ranged('bytes=0-1,4-5')).toEqual({ status: 200, range: null, body: '0123456789' })
    expect(await ranged('lines=1-2')).toEqual({ status: 200, range: null, body: '0123456789' })
    await expect(files.serve(event() as never, 'videos/none.txt', { mode: 'proxy' })).rejects.toMatchObject({ status: 404, message: 'No file "videos/none.txt".' })
  })

  it('answers the whole file, as a 200, when the store ignores the range it was asked for', async () => {
    // Some S3-compatible stores ignore Range, and files-sdk does not notice.
    const ignoresRanges = () => {
      const store = memory()

      return { ...store, download: ((key, options) => store.download(key, { ...options, range: undefined })) as typeof store.download }
    }
    const { useCapsaDrive } = await drive([disk('default', 'memory')], { 'files-sdk/memory': { memory: ignoresRanges } })
    const files = useCapsaDrive()
    await files.upload('videos/clip.txt', '0123456789')

    const response = await files.serve(event({ range: 'bytes=2-4' }) as never, 'videos/clip.txt', { mode: 'proxy' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBeNull()
    expect(await response.text()).toBe('0123456789')
  })

  it('names a download in plain ASCII for older clients, and encoded for the rest', async () => {
    const { useCapsaDrive } = await drive([disk('default', 'memory')])
    const files = useCapsaDrive()
    await files.upload('a.pdf', 'pdf')

    const disposition = async (name: string) => (await files.serve(event() as never, 'a.pdf', { mode: 'proxy', download: name })).headers.get('content-disposition')

    expect(await disposition('résumé.pdf')).toBe(`attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`)
    expect(await disposition('a "quoted" \\ name (1).pdf')).toBe(`attachment; filename="a _quoted_ _ name (1).pdf"; filename*=UTF-8''a%20%22quoted%22%20%5C%20name%20%281%29.pdf`)
  })

  it('reads the file through the disk, so the plugins of its config.ts see it', async () => {
    const config = defineDriveConfig('default' as never, { plugins: [usage()] })
    const { useCapsaDrive } = await drive([disk('default', 'memory', { config: '#capsa/root/server/capsa/drive/default/config' })], { '#capsa/root/server/capsa/drive/default/config': { default: config } })
    const files = useCapsaDrive()
    await files.upload('old.txt', 'kept for years')

    await (await files.serve(event() as never, 'old.txt', { mode: 'proxy' })).text()

    expect(files.usage!().operationsByKind).toMatchObject({ upload: 1, download: 1 })
  })
})

describe('links of a disk on fs', () => {
  beforeEach(() => {
    server.config.app.baseURL = '/'
    server.deriveSecret.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  /** A drive whose default disk is on fs, in a folder of its own. */
  async function fsDrive() {
    const root = await folder()
    vi.stubEnv('NUXT_CAPSA_DRIVE_DEFAULT_ROOT', root)

    return { ...await drive([disk('default', 'fs')]), root }
  }

  it('are signed by capsa, and answered only as they were signed', async () => {
    const { useCapsaDrive, serveSigned, root } = await fsDrive()
    const files = useCapsaDrive()
    await files.upload('docs/report.txt', 'a report on fs')

    // fs signs nothing of its own: capsa advertises it as signing, so files-sdk lets `url` through.
    expect(files.adapter.capabilities?.signedUrl).toEqual({ supported: true, expiry: 'exact', disposition: true })

    const link = await files.url('docs/report.txt', { expiresIn: 60, responseContentDisposition: 'attachment' })

    expect(link).toMatch(/^\/_capsa\/drive\/default\/docs\/report\.txt\?expires=\d+&disposition=attachment&signature=[\da-f]{64}$/)

    const answered = await answer(serveSigned, link)

    expect(answered).toMatchObject({ status: 200, body: 'a report on fs' })
    expect(answered.headers.get('content-disposition')).toBe('attachment')

    // Whatever changes in the link breaks its signature: the expiry, the disposition, the key, the method.
    for (const forged of [link.replace(/expires=\d+/, 'expires=9999999999'), link.replace('=attachment', '=inline'), link.replace('report', 'other'), link.replace(/signature=\w+/, 'signature=nope')])
      expect((await answer(serveSigned, forged)).status).toBe(403)

    expect((await answer(serveSigned, link, { method: 'PUT', body: 'overwritten' })).status).toBe(403)
    expect((await answer(serveSigned, link, { method: 'DELETE' })).status).toBe(403)
    expect(await readFile(join(root, 'docs/report.txt'), 'utf8')).toBe('a report on fs')
  })

  it('last as long as asked, or an hour, and are refused once they expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T12:00:00Z') })
    const { useCapsaDrive, serveSigned } = await fsDrive()
    const files = useCapsaDrive()
    await files.upload('docs/brief.txt', 'short-lived')

    const brief = await files.url('docs/brief.txt', { expiresIn: 1 })
    const hour = await files.url('docs/brief.txt')

    expect(new URL(hour, 'http://localhost').searchParams.get('expires')).toBe(String(Date.UTC(2026, 10, 6, 13) / 1000))
    expect((await answer(serveSigned, brief)).status).toBe(200)

    vi.setSystemTime(new Date('2026-11-06T12:00:02Z'))

    expect((await answer(serveSigned, brief)).status).toBe(403)
    expect((await answer(serveSigned, hour)).status).toBe(200)
  })

  it('sign an upload for one type, as S3 signs a PUT, which never downloads', async () => {
    const { useCapsaDrive, serveSigned } = await fsDrive()
    const files = useCapsaDrive()

    const upload = await files.signedUploadUrl('uploads/note.txt', { expiresIn: 60, contentType: 'text/plain' }) as { method: string, url: string, headers: Record<string, string> }

    expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'text/plain' } })
    expect((await answer(serveSigned, upload.url, { method: 'PUT', body: '<p>another type</p>', headers: { 'content-type': 'text/html' } })).status).toBe(403)
    expect((await answer(serveSigned, upload.url, { method: 'PUT', body: 'uploaded by the browser', headers: upload.headers })).status).toBe(200)
    expect(await (await files.download('uploads/note.txt')).text()).toBe('uploaded by the browser')
    // A link to upload does not download.
    expect((await answer(serveSigned, upload.url)).status).toBe(403)
  })

  it('serve a file with a redirect to a link capsa signed', async () => {
    const { useCapsaDrive, serveSigned } = await fsDrive()
    const files = useCapsaDrive()
    await files.upload('docs/served.txt', 'served from fs')

    const response = await files.serve(event() as never, 'docs/served.txt')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toMatch(/^\/_capsa\/drive\/default\/docs\/served\.txt\?expires=\d+&signature=/)
    expect((await answer(serveSigned, response.headers.get('location')!)).body).toBe('served from fs')
  })

  it('sit under app.baseURL, with each part of the key encoded', async () => {
    server.config.app.baseURL = '/base'
    const { useCapsaDrive, serveSigned } = await fsDrive()
    const files = useCapsaDrive()
    await files.upload('a dir/è?.txt', 'encoded')

    const link = await files.url('a dir/è?.txt')
    server.config.app.baseURL = '/base/'

    expect(link).toMatch(/^\/base\/_capsa\/drive\/default\/a%20dir\/%C3%A8%3F\.txt\?expires=/)
    expect((await answer(serveSigned, link)).body).toBe('encoded')
  })

  it('are signed with a key derived from NUXT_APP_SECRET once, and a failure to derive it is tried again', async () => {
    const { useCapsaDrive } = await fsDrive()
    const files = useCapsaDrive()
    server.deriveSecret.mockRejectedValueOnce(new Error('NUXT_APP_SECRET is not set'))

    await expect(files.url('a.txt')).rejects.toThrow('NUXT_APP_SECRET is not set')
    await files.url('a.txt')
    await files.url('b.txt')

    expect(server.deriveSecret.mock.calls).toEqual([['nuxt-capsa:drive'], ['nuxt-capsa:drive']])
  })
})
