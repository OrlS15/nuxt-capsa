import { defineDbConfig } from 'nuxt-capsa/db'

// @ts-expect-error The repo's typecheck loads none of this app's types: there, no source is named `default`.
export default defineDbConfig('default', {
  // Read by drizzle-kit and by the server alike: both record migrations in `drizzle.history`.
  kit: () => ({ migrations: { table: 'history' } }),
})
