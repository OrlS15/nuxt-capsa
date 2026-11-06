import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { authorize, can, cannot, getSession, requireSession } from '#capsa/auth'

// Someone else's draft: Ada may not see it, nor edit it.
const draft = { authorId: 'someone-else', published: false }

export default defineEventHandler(async (event) => {
  const check = getRouterParam(event, 'check')

  if (check === 'view') await requireSession(event, 'post.view', draft)
  if (check === 'schedule') await requireSession(event, 'schedule')
  if (check === 'create') await requireSession(event, 'projects.create', 5)
  if (check === 'inline') await requireSession(event, user => user.name === 'Ada' || 'NOT_ADA')
  // A rule the reports layer brings.
  if (check === 'reports') await requireSession(event, 'reports.view')

  // Data that depends on the user, loaded once the session is in hand, then the rule.
  if (check === 'loaded') {
    const { user } = await requireSession(event)
    const projects = user.name.length

    authorize(user, 'projects.create', projects)
  }

  // Another user's abilities: here, Ada on the pro plan.
  if (check === 'other') {
    const { user } = await requireSession(event)
    const pro = { ...user, plan: 'pro' as const }

    authorize(pro, 'schedule')

    return { schedule: can(pro, 'schedule'), scheduleAsAda: cannot(user, 'schedule') }
  }

  return { edit: can((await getSession(event))?.user, 'post.edit', draft) }
})
