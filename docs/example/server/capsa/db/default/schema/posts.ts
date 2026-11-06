import { pgTable } from 'drizzle-orm/pg-core'
import { users } from './users'

export const posts = pgTable('posts', t => ({
  id: t.serial().primaryKey(),
  authorId: t.integer().notNull().references(() => users.id),
  title: t.text().notNull(),
  body: t.text(),
  publishedAt: t.timestamp(),
}))
