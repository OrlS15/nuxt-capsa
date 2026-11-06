import { defineEventHandler } from 'nuxt/server'
import { requireSession } from '#capsa/auth'

export default defineEventHandler(async (event) => {
  const _session = await requireSession(event)
})
