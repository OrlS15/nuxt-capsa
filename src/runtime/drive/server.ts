import { createError, deriveSecret, getRouterParams, useRuntimeConfig, type RequestEvent } from 'nuxt/server'

/** One disk, as `#capsa/drive` hands it over. */
export interface DiskParts {
  /** The adapter's factory, from the project's files-sdk. */
  adapter: (options: object) => Adapter
  /** The prefix of its variables: each `<env>_<OPTION>` is one option of the adapter. */
  env: string
  /** The options capsa fills in, under what the variables set. */
  defaults: Record<string, string>
  /** What the disk's `config.ts` exports, when it has one. */
  config?: { options?: (options: Record<string, string | boolean>) => object, plugins?: readonly object[] }
}

/**
 * What `#capsa/drive` hands over, which only the project's build has: its own files-sdk and its disks. files-sdk is
 * never imported here, so it stays the project's dependency.
 */
export interface DriveParts {
  /** `createFiles` of the project's files-sdk. */
  createFiles: (options: { adapter: Adapter, plugins: object[] }) => Disk
  /** The disks of `capsa.drive`, keyed by name. */
  disks: Record<string, DiskParts>
}

/**
 * How `serve` answers. `download` names the file the browser saves, instead of showing it.
 *
 * @example
 * { download: 'report.pdf' }  // a redirect to a link that downloads as report.pdf
 * { mode: 'proxy' }           // the bytes, through the server
 */
export type ServeOptions
  /** A redirect to a link of the store, made as `url()` makes it: `expiresIn` is the link's. */
  = | { mode?: 'redirect', expiresIn?: number, download?: string }
  /** The bytes, streamed through the server, one range at a time when the browser asks for one. */
    | { mode: 'proxy', download?: string }

/** What capsa adds to every disk. */
export interface Serve {
  /**
   * Answers a request with a file: a redirect to a link of the store by default, or its bytes with `mode: 'proxy'`.
   *
   * @example
   * export default defineEventHandler(event => useCapsaDrive('avatars').serve(event, 'users/42.png'))
   */
  serve(event: RequestEvent, key: string, options?: ServeOptions): Promise<Response>
}

/** A file, as `head` and `download` describe it. */
interface FileInfo {
  size: number
  contentType?: string
}

/** The calls that read one file, the same on a disk and on its adapter. */
interface Reader {
  head: (key: string) => Promise<FileInfo>
  download: (key: string, options: { as: 'stream', range?: ByteRange }) => Promise<FileInfo & { stream: () => ReadableStream<Uint8Array> }>
}

/** A files-sdk adapter, as far as capsa touches it. */
interface Adapter extends Reader {
  readonly name: string
  readonly capabilities?: object
  upload: (key: string, body: ReadableStream<Uint8Array> | Uint8Array, options: { contentType?: string }) => Promise<{ etag?: string }>
  url: (key: string, options?: UrlOptions) => Promise<string>
  signedUploadUrl: (key: string, options: { expiresIn: number, contentType?: string }) => Promise<object>
}

/** A disk: files-sdk's `Files`, as far as capsa calls it. */
interface Disk extends Reader {
  readonly adapter: Adapter
  url: (key: string, options?: UrlOptions) => Promise<string>
}

interface UrlOptions {
  expiresIn?: number
  responseContentDisposition?: string
}

/** Bytes `start` to `end` of a file, both included. */
interface ByteRange {
  start: number
  end: number
}

/** Where capsa answers the links it signs for a disk on fs, under `app.baseURL`. */
const SIGNED_ROUTE = '_capsa/drive'

/** How long a link lasts when the call does not say: files-sdk's own default for `url()`. */
const EXPIRES_IN = 3600

/**
 * Makes `useCapsaDrive`, each disk built on first use since its variables only exist once the server runs, and
 * `serveSigned`, the handler of the links a disk on fs signs.
 *
 * @example
 * export const { useCapsaDrive, serveSigned } = defineDrive({ createFiles, disks: { default: { adapter: s3Fetch, env: 'NUXT_CAPSA_DRIVE_DEFAULT', defaults: {} } } })
 */
export function defineDrive({ createFiles, disks }: DriveParts) {
  const built: Record<string, Disk> = {}

  function useCapsaDrive(name = 'default') {
    if (!Object.hasOwn(disks, name)) throw new Error(`[capsa] unknown drive disk "${name}". Configured: ${Object.keys(disks).join(', ')}.`)

    return built[name] ??= createDisk(name)
  }

  // files-sdk says which option is wrong or missing: capsa adds the disk, and where its options come from.
  function createDisk(name: string) {
    const disk = disks[name]!
    const { options, plugins = [] } = disk.config ?? {}

    try {
      const variables = readOptions(disk, Object.values(disks))
      const adapter = disk.adapter(options ? options(variables) : variables)

      return createFiles({ adapter: adapter.name === 'fs' ? signLocally(adapter, name) : adapter, plugins: [SERVE, ...plugins] })
    }
    catch (error) {
      throw new Error(`[capsa] drive disk "${name}": ${(error as Error).message} Its options are its variables: ${disk.env}_<OPTION>.`, { cause: error })
    }
  }

  // The link reaches the adapter itself, as a signed link reaches the bucket on S3: past the disk's plugins.
  async function serveSigned(event: RequestEvent) {
    const { disk, key } = getRouterParams(event, { decode: true }) as { disk: string, key: string }
    const { method, headers, body } = event.req
    const query = event.url.searchParams
    const expires = Number(query.get('expires'))
    const bound = query.get(method === 'PUT' ? 'type' : 'disposition') ?? ''
    const contentType = headers.get('content-type') ?? undefined

    const allowed = (method === 'GET' || method === 'PUT') && expires * 1000 > Date.now()
      && (method === 'GET' || !bound || contentType === bound)
      && await verify(query.get('signature'), [method, disk, key, expires, bound])

    if (!allowed) throw createError({ status: 403, message: 'The link is not valid, or it has expired.' })

    const { adapter } = useCapsaDrive(disk)

    if (method === 'GET') return respond(event.req, adapter, key, bound || undefined)

    const { etag } = await adapter.upload(key, body ?? new Uint8Array(), { contentType })

    return new Response(null, { headers: etag ? { etag } : {} })
  }

  return { useCapsaDrive, serveSigned }
}

/**
 * Reads a disk's options from its variables, over capsa's defaults. What follows the disk's prefix is the option,
 * spelled as Nitro spells a runtime config key; a variable is text, of which only `true` and `false` are read back.
 *
 * @example
 * // NUXT_CAPSA_DRIVE_DOCUMENTS_ACCESS_KEY_ID=key NUXT_CAPSA_DRIVE_DOCUMENTS_FORCE_PATH_STYLE=true
 * readOptions(disks.documents, Object.values(disks))  // { accessKeyId: 'key', forcePathStyle: true }
 */
function readOptions({ env, defaults }: DiskParts, disks: DiskParts[]) {
  const options: Record<string, string | boolean> = { ...defaults }

  for (const [variable, value] of Object.entries(process.env)) {
    if (!value || !variable.startsWith(`${env}_`)) continue

    // A longer prefix is another disk's: NUXT_CAPSA_DRIVE_USER_FILES_BUCKET is not the `filesBucket` of the disk `user`.
    if (disks.some(other => other.env.length > env.length && variable.startsWith(`${other.env}_`))) continue

    const option = variable.slice(env.length + 1).toLowerCase().replace(/_(.)/g, (_, letter: string) => letter.toUpperCase())

    options[option] = value === 'true' ? true : value === 'false' ? false : value
  }

  return options
}

/** The plugin that gives every disk `serve`: it only adds the method, and leaves the disk's own calls alone. */
const SERVE = {
  name: 'capsa:serve',
  extend: (disk: Disk): Serve => ({
    async serve(event, key, options = {}) {
      const disposition = options.download === undefined ? undefined : attachment(options.download)

      if (options.mode === 'proxy') return respond(event.req, disk, key, disposition)

      const location = await disk.url(key, { expiresIn: options.expiresIn, responseContentDisposition: disposition })

      return new Response(null, { status: 302, headers: { location } })
    },
  }),
}

/**
 * Answers with a file's bytes, streamed and never held in memory: the whole file, or the one range the request asks
 * for. files-sdk does not check that the store honoured the range: a store that sent the whole file is answered with
 * all of it, as a 200.
 *
 * @example
 * await respond(request, disk, 'videos/intro.mp4')  // with `Range: bytes=0-1023`: a 206 with the first KB
 */
async function respond(request: Request, reader: Reader, key: string, disposition?: string) {
  try {
    const header = request.headers.get('range')
    // A ranged download says only the length of the range: the size of the file comes from `head`.
    const size = header ? (await reader.head(key)).size : 0
    const range = header ? parseRange(header, size) : undefined

    if (range === null) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })

    const file = await reader.download(key, { as: 'stream', range })
    const partial = range && file.size === range.end - range.start + 1
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'content-length': String(file.size),
      'content-type': file.contentType || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    })

    if (partial) headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`)
    if (disposition) headers.set('content-disposition', disposition)

    return new Response(file.stream(), { status: partial ? 206 : 200, headers })
  }
  catch (error) {
    if ((error as { code?: string }).code === 'NotFound') throw createError({ status: 404, message: `No file "${key}".` })

    throw error
  }
}

/**
 * Reads the one byte range a `Range` header asks for, against the file's size. A header capsa does not read (several
 * ranges, another unit) gives `undefined`, and the whole file goes out; a range past the end gives `null`.
 *
 * @example
 * parseRange('bytes=0-99', 1000)   // { start: 0, end: 99 }
 * parseRange('bytes=-100', 1000)   // { start: 900, end: 999 }
 * parseRange('bytes=1000-', 1000)  // null
 */
function parseRange(header: string, size: number): ByteRange | null | undefined {
  const [, from, to] = /^bytes=(\d*)-(\d*)$/.exec(header) ?? []

  if (!from && !to) return undefined

  const start = from ? Number(from) : Math.max(size - Number(to), 0)
  const end = from && to ? Math.min(Number(to), size - 1) : size - 1

  return start <= end ? { start, end } : null
}

/**
 * The `Content-Disposition` that downloads a file under a name: plain ASCII for older clients, encoded for the rest.
 *
 * @example
 * attachment('résumé.pdf')  // `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`
 */
function attachment(name: string) {
  const plain = name.replace(/[^\x20-\x7E]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`
}

/**
 * Lets a disk on fs sign links as S3 does: `url` and `signedUploadUrl` point to capsa's route, which checks the
 * signature. Every other call is fs's own; files-sdk wraps its r2 and alibaba adapters the same way.
 */
function signLocally(adapter: Adapter, disk: string): Adapter {
  return {
    ...adapter,
    capabilities: {
      ...adapter.capabilities,
      signedUrl: { supported: true, expiry: 'exact', disposition: true },
      signedUpload: { supported: true, contentType: true, maxSize: false },
    },
    url: (key, options = {}) => signedLink('GET', disk, key, options.expiresIn ?? EXPIRES_IN, options.responseContentDisposition),
    signedUploadUrl: async (key, { expiresIn, contentType }) => ({
      method: 'PUT',
      url: await signedLink('PUT', disk, key, expiresIn, contentType),
      ...contentType && { headers: { 'content-type': contentType } },
    }),
  }
}

/**
 * A link to capsa's route for one file of a disk on fs, signed for one method until it expires. What the request
 * must match, the disposition of a download or the type of an upload, is signed too.
 *
 * @example
 * await signedLink('GET', 'default', 'docs/a.pdf', 60)  // '/_capsa/drive/default/docs/a.pdf?expires=1760000060&signature=…'
 */
async function signedLink(method: 'GET' | 'PUT', disk: string, key: string, expiresIn: number, bound = '') {
  const expires = Math.floor(Date.now() / 1000) + expiresIn
  const query = new URLSearchParams({ expires: String(expires) })

  if (bound) query.set(method === 'PUT' ? 'type' : 'disposition', bound)

  query.set('signature', await sign([method, disk, key, expires, bound]))

  const path = [disk, ...key.split('/')].map(encodeURIComponent).join('/')

  return `${useRuntimeConfig().app.baseURL.replace(/\/?$/, '/')}${SIGNED_ROUTE}/${path}?${query}`
}

let signing: Promise<CryptoKey> | undefined

/** The key links are signed with, derived from NUXT_APP_SECRET once. A failure is forgotten, so the next call tries again. */
function signingKey() {
  return signing ??= deriveSecret('nuxt-capsa:drive')
    .then(secret => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']))
    .catch((error: unknown) => {
      signing = undefined
      throw error
    })
}

/** What is signed: as JSON, so that no key can pass for another key followed by other parts. */
function payload(parts: unknown[]) {
  return new TextEncoder().encode(JSON.stringify(parts))
}

/** Signs the parts of a link, in hex. */
async function sign(parts: unknown[]) {
  const signature = await crypto.subtle.sign('HMAC', await signingKey(), payload(parts))

  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether a signature is the one capsa made for these parts. Web Crypto compares it in constant time. */
async function verify(signature: string | null, parts: unknown[]) {
  if (!signature || !/^[\da-f]{64}$/.test(signature)) return false

  const bytes = Uint8Array.from(signature.match(/../g)!, byte => Number.parseInt(byte, 16))

  return crypto.subtle.verify('HMAC', await signingKey(), bytes, payload(parts))
}
