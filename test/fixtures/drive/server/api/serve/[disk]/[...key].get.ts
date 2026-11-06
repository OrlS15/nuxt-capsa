import { defineEventHandler, getQuery, getRouterParam } from 'nuxt/server'

// Answers with a file of the disk the path names, in the mode the query asks for.
export default defineEventHandler((event) => {
  const { mode, download } = getQuery(event) as { mode?: 'proxy', download?: string }

  return useCapsaDrive(getRouterParam(event, 'disk') as 'default' | 'documents')
    .serve(event, getRouterParam(event, 'key')!, mode ? { mode, download } : { download })
})
