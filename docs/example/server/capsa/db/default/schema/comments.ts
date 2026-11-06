import { pgTable } from 'drizzle-orm/pg-core'
import { posts } from './posts'
import { users } from './users'

export const comments = pgTable('comments', t => ({
  id: t.serial().primaryKey(),
  postId: t.integer().notNull().references(() => posts.id),
  authorId: t.integer().notNull().references(() => users.id),
  content: t.text().notNull(),
}))
