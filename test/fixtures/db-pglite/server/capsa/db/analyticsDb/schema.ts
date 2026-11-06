import { pgTable, serial } from 'drizzle-orm/pg-core'

export const events = pgTable('events', {
  id: serial().primaryKey(),
})
