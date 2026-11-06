import { pgTable, serial, text } from 'drizzle-orm/pg-core'

// The tables the type tests compile a source against.
export const users = pgTable('users', {
  id: serial().primaryKey(),
  name: text().notNull(),
})
