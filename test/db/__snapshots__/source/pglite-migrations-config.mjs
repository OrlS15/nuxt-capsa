import { mkdirSync } from 'node:fs'
import { defineRelationsPart } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { withReplicas } from 'drizzle-orm/pg-core'
import { formatToMillis } from 'drizzle-orm/migrator.utils'
import { migrate } from 'drizzle-orm/pg-core/async/session'
import { useStorage } from 'nitro/storage'
import { defineMigrations } from 'nuxt-capsa/db/drizzle/migrations'
import { useNitroHooks } from 'nitro/app'
import { useRuntimeConfig } from 'nuxt/server'
import { DRIVERS } from 'nuxt-capsa/db/drizzle/drivers'
import { defineSource } from 'nuxt-capsa/db/drizzle/source'
import * as tables from '#capsa/db/default/schema'
import config from '#capsa/root/server/capsa/db/default/config'

export * as schema from '#capsa/db/default/schema'

export const relations = { ...defineRelationsPart(tables) }

const source = defineSource({
  name: "default",
  env: "NUXT_CAPSA_DB_DEFAULT",
  driver: DRIVERS["postgresql"]["pglite"],
  drizzle,
  withReplicas,
  relations,
  runtimeConfig: () => useRuntimeConfig().capsa.db["default"],
  config,
  local: { connection: ".data/capsa/db/default", dir: ".data/capsa/db", mkdirSync },
  onClose: close => useNitroHooks().hook('close', close),
})

export const getDb = source.getDb

export const { applyMigrations, ensureMigrations } = defineMigrations(source, {
  storage: () => useStorage("assets:capsa-db-default"),
  formatToMillis,
  executor: migrate,
  lock: "select pg_advisory_xact_lock(hashtext('capsa:default'))",
  kit: () => config.kit?.({
    dialect: "postgresql",
    driver: "pglite",
    schema: ["/app/server/capsa/db/default/schema.ts","/app/server/capsa/db/default/schema/**/*.ts"],
    out: "/app/server/capsa/db/default/migrations",
    dbCredentials: { url: process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? ".data/capsa/db/default" },
  }),
})
