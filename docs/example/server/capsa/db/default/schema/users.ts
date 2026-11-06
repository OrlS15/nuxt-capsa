import { pgTable } from 'drizzle-orm/pg-core'

export const users = pgTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
  createdAt: t.timestamp().defaultNow().notNull(),
}))
