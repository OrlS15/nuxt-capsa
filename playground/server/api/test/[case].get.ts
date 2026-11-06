import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { authorize, requireSession } from '#capsa/auth'

// One auth or authz error per case, to see what a caller receives.
export default defineEventHandler(async (event) => {
  switch (getRouterParam(event, 'case')) {
    // Signed out: 401 SIGNED_OUT.
    case '1':
      await requireSession(event)
      break

    // A rule that answers with a code: 403 PRO_REQUIRED for a free user.
    case '2':
      await requireSession(event, 'schedule')
      break

    // Data that depends on the user, then the rule: 429 LIMIT_REACHED with { limit: 3 }.
    case '3': {
      const { user } = await requireSession(event)

      authorize(user, 'notes.create', 3)
      break
    }

    // Someone else's draft: 404, as if it did not exist.
    case '4':
      await requireSession(event, 'notes.view', { authorId: 'someone-else', published: false })
      break

    default:
      throw createError({ status: 404, statusText: 'Not Found' })
  }

  return { ok: true }
})
