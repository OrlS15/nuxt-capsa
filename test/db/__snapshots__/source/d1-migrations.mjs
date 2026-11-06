import { env } from 'cloudflare:workers'
import { defineRelationsPart } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { withReplicas } from 'drizzle-orm/sqlite-core'
import { formatToMillis } from 'drizzle-orm/migrator.utils'
import { migrateAsync } from 'drizzle-orm/sqlite-core/async/session'
import { useStorage } from 'nitro/storage'
import { defineMigrations } from 'nuxt-capsa/db/drizzle/migrations'
import { useRuntimeConfig } from 'nuxt/server'
import { DRIVERS } from 'nuxt-capsa/db/drizzle/drivers'
import { defineSource } from 'nuxt-capsa/db/drizzle/source'
import * as tables from '#capsa/db/default/schema'

export * as schema from '#capsa/db/default/schema'

export const relations = { ...defineRelationsPart(tables) }

const source = defineSource({
  name: "default",
  env: "NUXT_CAPSA_DB_DEFAULT",
  driver: DRIVERS["sqlite"]["d1"],
  drizzle,
  withReplicas,
  relations,
  runtimeConfig: () => useRuntimeConfig().capsa.db["default"],
  bindings: env,
})

export const getDb = source.getDb

export const { applyMigrations, ensureMigrations } = defineMigrations(source, {
  storage: () => useStorage("assets:capsa-db-default"),
  formatToMillis,
  executor: migrateAsync,
})
