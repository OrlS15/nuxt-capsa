import { defineDbConfig } from 'nuxt-capsa/db'

export default defineDbConfig('default', {
  // Runtime: what capsa hands to `drizzle()`.
  options: () => ({ logger: true }),
})
