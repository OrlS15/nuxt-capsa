import capsa from '../../../src/module'

export default defineNuxtConfig({
  modules: [capsa],
  capsa: {
    db: {
      default: { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', migrations: 'onStart' },
      analyticsDb: { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite' },
    },
  },
})
