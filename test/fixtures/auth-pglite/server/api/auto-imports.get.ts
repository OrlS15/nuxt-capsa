import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(() => ({
  handler: typeof useCapsaAuth().handler,
  // @ts-expect-error The rest of #capsa/auth stays an explicit import.
  getSession: typeof getSession,
}))
