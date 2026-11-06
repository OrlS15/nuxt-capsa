export default defineNuxtConfig({
  modules: ['nuxt-capsa'],
  devtools: { enabled: true },
  compatibilityDate: 'latest',
  capsa: {
    db: {
      default: {
        provider: 'drizzle',
        dialect: 'postgresql',
        driver: 'pglite',
        dataDir: '.data/capsa',
        migrations: 'onStart',
      },
    },
    auth: {
      // Signed-in visitors skip the login page.
      routes: { '/login': 'guest' },
      redirects: { user: '/login', guest: '/abilities' },
    },
  },
  /* $development: {
    capsa: {
      db: {
        default: {
          dialect: 'postgresql',
          driver: 'pglite',
        dataDir: '.data/capsa',
        },
      },
    },
  }, */

})
