import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The credentials the stand-in accepts. */
export const ACCESS_KEY = 'AKIAFAKES3'
export const SECRET_KEY = 'secret-key-of-the-fake-s3'

interface StoredObject { body: Buffer, etag: string, type: string, modified: Date }

/** What a request says of its own signature: in the `Authorization` header, or in the query of a presigned URL. */
interface Signed { date: string, scope: string, signedHeaders: string, payloadHash: string, presigned: boolean }

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

/** The signature AWS would compute for a request: SigV4, worked out here with `node:crypto` and none of the client's code. */
function expectedSignature(req: IncomingMessage, url: URL, { date, scope, signedHeaders, payloadHash, presigned }: Signed) {
  const path = url.pathname.split('/').map(part => encode(decodeURIComponent(part))).join('/')
  const query = [...url.searchParams].filter(([key]) => !(presigned && key === 'X-Amz-Signature'))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`).sort().join('&')
  const headers = signedHeaders.split(';').map(name => `${name}:${String(req.headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('')
  const canonical = [req.method, path, query, headers, signedHeaders, payloadHash].join('\n')
  const [day, region, service] = scope.split('/') as [string, string, string]
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, day), region), service), 'aws4_request')

  return createHmac('sha256', key).update(['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n')).digest('hex')
}

/** Whether a request carries the signature its content calls for, made with the stand-in's credentials. */
function isSigned(req: IncomingMessage, url: URL) {
  const header = req.headers.authorization?.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\S+), SignedHeaders=(\S+), Signature=(\w+)$/)
  const query = url.searchParams

  if (header) {
    const [, accessKey, scope, signedHeaders, given] = header as unknown as [string, string, string, string, string]
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? sha256(''))

    return accessKey === ACCESS_KEY && given === expectedSignature(req, url, { date: String(req.headers['x-amz-date']), scope, signedHeaders, payloadHash, presigned: false })
  }

  if (!query.has('X-Amz-Signature')) return false

  const [accessKey, ...scope] = query.get('X-Amz-Credential')!.split('/')
  const signed = { date: query.get('X-Amz-Date')!, scope: scope.join('/'), signedHeaders: query.get('X-Amz-SignedHeaders')!, payloadHash: 'UNSIGNED-PAYLOAD', presigned: true }

  return accessKey === ACCESS_KEY && query.get('X-Amz-Signature') === expectedSignature(req, url, signed)
}

/**
 * Starts an S3 stand-in on a free port: objects in memory, addressed in path style, and a 403 for any request whose
 * signature it cannot reproduce. `seen` counts the requests it accepted and refused, and keeps the accepted paths.
 *
 * @example
 * const s3 = await startFakeS3()
 * s3.url  // 'http://localhost:51234', the `endpoint` of an s3-fetch disk
 */
export async function startFakeS3() {
  const objects = new Map<string, StoredObject>()
  const seen = { signed: 0, refused: 0, paths: [] as string[] }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)

    // A path-style request always names a bucket: `/` comes from a tool on the machine probing the new port.
    if (url.pathname === '/') {
      res.writeHead(404)
      return res.end()
    }

    if (!isSigned(req, url)) {
      seen.refused++
      res.writeHead(403, { 'content-type': 'application/xml' })
      return res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>refused by the fake S3</Message></Error>')
    }

    seen.signed++
    seen.paths.push(url.pathname)

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    // The bucket is the first segment of the path.
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'))

    if (req.method === 'PUT') {
      const etag = createHash('md5').update(body).digest('hex')

      objects.set(key, { body, etag, type: req.headers['content-type'] ?? 'application/octet-stream', modified: new Date() })
      res.writeHead(200, { etag: `"${etag}"` })
      return res.end()
    }

    if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204)
      return res.end()
    }

    const object = objects.get(key)

    if (!object) {
      res.writeHead(404, { 'content-type': 'application/xml' })
      return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code><Message>no such key</Message></Error>')
    }

    res.writeHead(200, { 'content-type': object.type, 'content-length': object.body.length, 'etag': `"${object.etag}"`, 'last-modified': object.modified.toUTCString() })
    res.end(req.method === 'HEAD' ? undefined : object.body)
  })

  await new Promise<void>(resolve => server.listen(0, resolve))

  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
