import { defineEventHandler, getQuery, getRouterParam } from 'nuxt/server'
import { requireSession } from '#capsa/auth'

// The same checks the page makes, enforced here: a page can hide a button, only the server can refuse the call.
export default defineEventHandler(async (event) => {
  const check = getRouterParam(event, 'check')

  if (check === 'schedule') await requireSession(event, 'schedule')
  if (check === 'create') await requireSession(event, 'notes.create', Number(getQuery(event).count ?? 0))

  return { ok: true }
})
