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
      // A second database, on SQLite: its migrations run when code asks for them (server/api/visits.post.ts).
      analytics: {
        provider: 'drizzle',
        dialect: 'sqlite',
        driver: 'node-sqlite',
        dataDir: '.data/capsa',
        migrations: 'manual',
      },
    },
    auth: {
      // Signed-in visitors skip the login page, signed-out ones never reach the files.
      routes: { '/login': 'guest', '/files': 'user' },
      redirects: { user: '/login', guest: '/abilities' },
    },
    drive: {
      // A folder of this machine: capsa signs its links, as S3 would.
      default: { adapter: 'fs' },
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
