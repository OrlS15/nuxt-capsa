// The app the docs' `twoslash` code blocks are type-checked against: its files are the ones the docs show.
import capsa from '../../src/module'

export default defineNuxtConfig({
  modules: [capsa],
  compatibilityDate: '2026-09-01',
  // Types `capsa` in nuxt.config, where Nuxt imports the module by its package name.
  typescript: { nodeTsConfig: { compilerOptions: { paths: { 'nuxt-capsa': ['../../../src/module'] } } } },
  capsa: {
    db: {
      default: { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', migrations: 'onStart' },
      analytics: { provider: 'drizzle', dialect: 'sqlite', driver: 'node-sqlite', migrations: 'manual' },
    },
    drive: {
      default: { adapter: 's3-fetch' },
      avatars: { adapter: 's3-fetch' },
    },
  },
})
