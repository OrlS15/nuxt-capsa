const capsa = {
  dialect: "postgresql",
  driver: "aws-data-api",
  schema: ["/app/server/capsa/db/default/schema.ts","/app/server/capsa/db/default/schema/**/*.ts"],
  out: "/app/server/capsa/db/default/migrations",
  dbCredentials: JSON.parse(process.env.NUXT_CAPSA_DB_DEFAULT_CONNECTION ?? '{}'),
}

export default capsa
