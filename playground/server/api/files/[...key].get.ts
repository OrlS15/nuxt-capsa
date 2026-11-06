import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { requireSession } from '#capsa/auth'

// A stable address for a file: the route checks who asks, then streams it through the server as a download.
export default defineEventHandler(async (event) => {
  const { user } = await requireSession(event)
  const key = getRouterParam(event, 'key')!

  if (!key.startsWith(`users/${user.id}/`)) throw createError({ status: 404, statusText: 'Not Found' })

  return useCapsaDrive().serve(event, key, { mode: 'proxy', download: key.split('/').pop() })
})
