import { defineEventHandler } from 'nuxt/server'
import { requireSession } from '#capsa/auth'

export default defineEventHandler(async (event) => {
  const { user } = await requireSession(event)

  return { email: user.email, plan: user.plan }
})
