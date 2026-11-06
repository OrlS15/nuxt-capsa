import { defineRelationsPart } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/aws-data-api/pg'
import { withReplicas } from 'drizzle-orm/pg-core'
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
  driver: DRIVERS["postgresql"]["aws-data-api/pg"],
  drizzle,
  withReplicas,
  relations,
  runtimeConfig: () => useRuntimeConfig().capsa.db["default"],
  onClose: close => useNitroHooks().hook('close', close),
})

export const getDb = source.getDb
