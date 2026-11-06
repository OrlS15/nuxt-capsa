import { pgTable } from 'drizzle-orm/pg-core'
import { users } from './users'

export const comments = pgTable('comments', t => ({
  id: t.serial().primaryKey(),
  userId: t.integer().notNull().references(() => users.id),
  content: t.text().notNull(),
}))
