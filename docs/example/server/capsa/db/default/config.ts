import { defineDbConfig } from 'nuxt-capsa/db'

export default defineDbConfig('default', {
  options: () => ({ logger: true }),
})
