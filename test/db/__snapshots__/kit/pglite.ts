import { mkdirSync } from 'node:fs'

// Like the server: the directory of capsa's own default store, which no driver creates.
if ((process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? ".data/capsa/db/default") === ".data/capsa/db/default") mkdirSync(".data/capsa/db", { recursive: true })

const capsa = {
  dialect: "postgresql",
  driver: "pglite",
  schema: ["/app/server/capsa/db/default/schema.ts","/app/server/capsa/db/default/schema/**/*.ts"],
  out: "/app/server/capsa/db/default/migrations",
  dbCredentials: { url: process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? ".data/capsa/db/default" },
}

export default capsa
