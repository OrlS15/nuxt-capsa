import { count } from 'drizzle-orm'
import { defineEventHandler, readBody } from 'nuxt/server'
import { ensureMigrations } from '#capsa/db/analytics'
import { visits } from '#capsa/db/analytics/schema'

// The analytics database migrates 'manual'ly: the first call applies its migrations, the others find them done.
export default defineEventHandler(async (event) => {
  const { path } = await readBody<{ path: string }>(event)

  await ensureMigrations()

  const db = useCapsaDb('analytics')
  await db.insert(visits).values({ path, at: new Date() })
  const [total] = await db.select({ count: count() }).from(visits)

  return total!.count
})
