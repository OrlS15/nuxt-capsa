import { defineEventHandler, getRouterParam } from 'nuxt/server'

// Stores the body under the key with PUT, and hands it back with GET, on the disk the path names.
export default defineEventHandler(async (event) => {
  const disk = useCapsaDrive(getRouterParam(event, 'disk') as 'default' | 'documents' | 'archive')
  const key = getRouterParam(event, 'key')!

  if (event.req.method === 'PUT') return disk.upload(key, await event.req.text(), { contentType: 'text/plain' })

  return (await disk.download(key)).text()
})
