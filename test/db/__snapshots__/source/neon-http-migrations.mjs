import { defineRelationsPart } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/neon-http'
import { withReplicas } from 'drizzle-orm/pg-core'
import { formatToMillis } from 'drizzle-orm/migrator.utils'
import { migrate } from 'drizzle-orm/pg-core/async/session'
import { drizzle as drizzleOver } from 'drizzle-orm/neon-serverless'
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
  driver: DRIVERS["postgresql"]["neon-http"],
  drizzle,
  withReplicas,
  relations,
  runtimeConfig: () => useRuntimeConfig().capsa.db["default"],
})

export const getDb = source.getDb

export const { applyMigrations, ensureMigrations } = defineMigrations(source, {
  storage: () => useStorage("assets:capsa-db-default"),
  formatToMillis,
  executor: migrate,
  lock: "select pg_advisory_xact_lock(hashtext('capsa:default'))",
  drizzle: drizzleOver,
})
