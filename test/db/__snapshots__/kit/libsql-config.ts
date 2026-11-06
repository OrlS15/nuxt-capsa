import { mkdirSync } from 'node:fs'
import config from '/app/server/capsa/db/default/config'

// Like the server: the directory of capsa's own default store, which no driver creates.
if ((process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? "file:.data/capsa/db/default.db") === "file:.data/capsa/db/default.db") mkdirSync(".data/capsa/db", { recursive: true })

const capsa = {
  dialect: "sqlite",
  schema: ["/app/server/capsa/db/default/schema.ts","/app/server/capsa/db/default/schema/**/*.ts"],
  out: "/app/server/capsa/db/default/migrations",
  dbCredentials: { url: process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? "file:.data/capsa/db/default.db" },
}

export default config.kit?.(capsa) ?? capsa
