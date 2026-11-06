/* global useCapsaDb -- capsa's auto-import */
import { sql } from 'drizzle-orm'
import { defineEventHandler } from 'nuxt/server'

/** Reads what one store holds: its users, and whether migrations ever ran on it. */
async function read(db) {
  const { rows } = await db.execute(sql`select to_regclass('drizzle.history') as migrations`)

  return { users: await db.query.users.findMany(), migrations: rows[0].migrations }
}

export default defineEventHandler(async () => {
  const db = useCapsaDb()

  return { primary: await read(db), replica: db.$replica ? await read(db.$replica) : null }
})
