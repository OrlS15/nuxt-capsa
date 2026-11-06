import capsa from '../../../src/module'

export default defineNuxtConfig({
  // From src, or the build of the package prepared-types.test.ts points at.
  modules: [process.env.CAPSA_BUILT_MODULE ?? capsa],
  // A page with a rule of its own, which capsa.auth.routes guards on top.
  routeRules: {
    '/settings': { headers: { 'x-settings': 'own-rule' } },
  },
  capsa: {
    db: {
      default: { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', migrations: 'onStart' },
    },
    auth: {
      routes: { '/dashboard/**': 'user', '/dashboard/public': false, '/login': 'guest', '/settings': 'user' },
      redirects: { user: '/login', guest: '/dashboard' },
    },
  },
})
