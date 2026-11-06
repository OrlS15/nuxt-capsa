import { defineEventHandler } from 'nuxt/server'
import { products } from '#capsa/db/default/schema'

// `products` comes from the base layer's schema, and is queried like the project's own tables.
export default defineEventHandler(() => useCapsaDb().select().from(products))
