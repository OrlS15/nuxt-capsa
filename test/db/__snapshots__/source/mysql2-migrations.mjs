import { defineRelationsPart } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { withReplicas } from 'drizzle-orm/mysql-core'
import { formatToMillis } from 'drizzle-orm/migrator.utils'
import { migrate } from 'drizzle-orm/mysql-core/async/session'
import { useStorage } from 'nitro/storage'
import { defineMigrations } from 'nuxt-capsa/db/drizzle/migrations'
import { useNitroHooks } from 'nitro/app'
import { useRuntimeConfig } from 'nuxt/server'
import { DRIVERS } from 'nuxt-capsa/db/drizzle/drivers'
import { defineSource } from 'nuxt-capsa/db/drizzle/source'
import * as tables from '#capsa/db/default/schema'

export * as schema from '#capsa/db/default/schema'

export const relations = { ...defineRelationsPart(tables) }

const source = defineSource({
  name: "default",
  env: "NUXT_CAPSA_DB_DEFAULT",
  driver: DRIVERS["mysql"]["mysql2"],
  drizzle,
  withReplicas,
  relations,
  runtimeConfig: () => useRuntimeConfig().capsa.db["default"],
  onClose: close => useNitroHooks().hook('close', close),
})

export const getDb = source.getDb

export const { applyMigrations, ensureMigrations } = defineMigrations(source, {
  storage: () => useStorage("assets:capsa-db-default"),
  formatToMillis,
  executor: migrate,
  lock: "select get_lock(md5(concat(database(), ':capsa:default')), -1)",
  unlock: "select release_lock(md5(concat(database(), ':capsa:default')))",
})
