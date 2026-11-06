import { defineEventHandler, getQuery, getRouterParam } from 'nuxt/server'

// A link the browser uploads one file to, for a minute, of the type the query names.
export default defineEventHandler((event) => {
  const { type } = getQuery(event) as { type?: string }

  return useCapsaDrive(getRouterParam(event, 'disk') as 'default' | 'documents')
    .signedUploadUrl(getRouterParam(event, 'key')!, { expiresIn: 60, contentType: type })
})
