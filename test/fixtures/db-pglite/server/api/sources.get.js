/* global useCapsaDb -- capsa's auto-import */
import { sql } from 'drizzle-orm'
import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(async () => {
  const analytics = useCapsaDb('analyticsDb')
  const { rows } = await analytics.execute(sql`select to_regclass('users') as users`)
  let unknown = ''

  try {
    useCapsaDb('nope')
  }
  catch (error) {
    unknown = error.message
  }

  // `analyticsDb` has a store of its own, where the default source's migrations never ran.
  return { sameDefault: useCapsaDb() === useCapsaDb('default'), analyticsUsers: rows[0].users, unknown }
})
