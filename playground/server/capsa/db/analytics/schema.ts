import { sqliteTable } from 'drizzle-orm/sqlite-core'

export const visits = sqliteTable('visits', t => ({
  id: t.integer().primaryKey({ autoIncrement: true }),
  path: t.text().notNull(),
  at: t.integer({ mode: 'timestamp' }).notNull(),
}))
