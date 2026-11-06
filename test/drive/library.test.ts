import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFiles, type Adapter } from 'files-sdk'
import { fs } from 'files-sdk/fs'
import { memory } from 'files-sdk/memory'
import { s3Fetch } from 'files-sdk/s3-fetch'
import { describe, expect, it, onTestFinished } from 'vitest'

/**
 * What capsa's drive takes for granted of files-sdk, checked on the real library: in memory, or in a temporary folder.
 * A failure here, after an update of files-sdk, names the assumption that no longer holds.
 */

/** A real fs adapter, in a folder removed after the test. */
async function fsAdapter() {
  const root = await mkdtemp(join(tmpdir(), 'capsa-files-sdk-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))

  return fs({ root })
}

describe('files-sdk, as capsa uses it', () => {
  it('adds the methods a plugin\'s extend returns to the disk, handing it the disk itself', async () => {
    let extended: unknown
    const files = createFiles({
      adapter: memory(),
      plugins: [{ name: 'serve', extend: (disk) => {
        extended = disk
        return { serve: () => 'served' }
      } }],
    })

    expect(files.serve()).toBe('served')
    expect(extended).toBe(files)
  })

  it('makes a disk\'s url and signedUploadUrl the adapter\'s, once the adapter says it signs', async () => {
    const adapter = await fsAdapter()

    // fs signs nothing: capsa's link is what makes it, past this capability.
    expect(adapter.name).toBe('fs')
    expect(adapter.capabilities?.signedUrl).toEqual({ supported: false })

    // What capsa's signLocally does: the same adapter, spread, with its own url, signedUploadUrl and capabilities.
    const signing: Adapter = {
      ...adapter,
      capabilities: { ...adapter.capabilities, signedUrl: { supported: true, expiry: 'exact', disposition: true }, signedUpload: { supported: true, contentType: true, maxSize: false } },
      url: async (key, options) => `signed:${key}:${options?.expiresIn}:${options?.responseContentDisposition}`,
      signedUploadUrl: async (key, options) => ({ method: 'PUT', url: `upload:${key}:${options.expiresIn}:${options.contentType}`, headers: {} }),
    }
    const files = createFiles({ adapter: signing })

    expect(await files.url('a.txt', { expiresIn: 60, responseContentDisposition: 'attachment' })).toBe('signed:a.txt:60:attachment')
    expect(await files.signedUploadUrl('a.txt', { expiresIn: 60, contentType: 'text/plain' })).toMatchObject({ method: 'PUT', url: 'upload:a.txt:60:text/plain' })
    // Every other call is still the adapter's own: the spread keeps them working.
    await files.upload('a.txt', 'kept')
    expect(await (await files.download('a.txt')).text()).toBe('kept')
  })

  it('downloads only the bytes of a range from fs, and says their length as the size', async () => {
    const files = createFiles({ adapter: await fsAdapter() })
    await files.upload('clip.txt', '0123456789', { contentType: 'text/plain' })

    const file = await files.download('clip.txt', { as: 'stream', range: { start: 2, end: 4 } })

    expect(file).toMatchObject({ size: 3, contentType: 'text/plain' })
    expect(await new Response(file.stream()).text()).toBe('234')
    // The size of the whole file comes from head: capsa writes it in Content-Range.
    expect(await files.head('clip.txt')).toMatchObject({ size: 10, contentType: 'text/plain' })
  })

  it('throws an error whose code is NotFound for a file that does not exist, on fs and in memory', async () => {
    for (const adapter of [await fsAdapter(), memory()]) {
      const files = createFiles({ adapter })

      await expect(files.download('none.txt', { as: 'stream' })).rejects.toMatchObject({ code: 'NotFound' })
      await expect(files.head('none.txt')).rejects.toMatchObject({ code: 'NotFound' })
    }
  })

  it('names the adapter and the option in the error of a missing option, which capsa completes with the disk', () => {
    // capsa writes this message after `[capsa] drive disk "<name>": `, and its variables after it.
    expect(() => s3Fetch({ bucket: 'docs' } as never)).toThrow(/^s3-fetch adapter: missing endpoint\. /)
    expect(() => fs({} as never)).toThrow(/^fs adapter: missing `root`/)
  })

  it('signs a link of s3-fetch offline, with the expiry and the disposition it was asked for', async () => {
    const files = createFiles({ adapter: s3Fetch({ bucket: 'docs', endpoint: 'http://s3.test', region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret', forcePathStyle: true }) })

    const link = new URL(await files.url('a.txt', { expiresIn: 60, responseContentDisposition: 'attachment' }))

    expect(link.pathname).toBe('/docs/a.txt')
    expect(link.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(link.searchParams.get('response-content-disposition')).toBe('attachment')
  })
})
