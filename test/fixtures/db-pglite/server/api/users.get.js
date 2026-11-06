/* global useCapsaDb -- capsa's auto-import */
import { sql } from 'drizzle-orm'
import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(async () => {
  const db = useCapsaDb()
  const { rows } = await db.execute(sql`select name from drizzle.history order by id`)

  return { users: await db.query.users.findMany(), migrations: rows.map(row => row.name) }
})
