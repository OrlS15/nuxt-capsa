import { sqliteTable } from 'drizzle-orm/sqlite-core'

export const events = sqliteTable('events', t => ({
  id: t.integer().primaryKey({ autoIncrement: true }),
  name: t.text().notNull(),
  userId: t.integer(),
  at: t.integer({ mode: 'timestamp' }).notNull(),
}))
