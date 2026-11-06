import { defineEventHandler } from 'nuxt/server'

// relations.ts lets `with` load each user's comments in the same query.
export default defineEventHandler(() => useCapsaDb().query.users.findMany({
  columns: { id: true, name: true, email: true },
  with: { comments: { columns: { content: true } } },
}))
