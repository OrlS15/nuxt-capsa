import { defineEventHandler, getQuery, getRouterParam } from 'nuxt/server'

// A link to a file of the disk the path names, with the expiry and the disposition the query asks for.
export default defineEventHandler((event) => {
  const { expiresIn, disposition } = getQuery(event) as { expiresIn?: string, disposition?: string }

  return useCapsaDrive(getRouterParam(event, 'disk') as 'default' | 'documents')
    .url(getRouterParam(event, 'key')!, { expiresIn: expiresIn ? Number(expiresIn) : undefined, responseContentDisposition: disposition })
})
