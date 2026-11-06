import { definePlugin } from 'nitro'
import { migrateOnStart } from 'nuxt-capsa/db/drizzle/migrations'
import { ensureMigrations } from '#capsa/db/logs'

export default definePlugin((nitro) => {
  // A prerender runs this server at build time, against the database of the machine that builds.
  if (!import.meta.prerender) migrateOnStart(nitro, "logs", ensureMigrations)
})
