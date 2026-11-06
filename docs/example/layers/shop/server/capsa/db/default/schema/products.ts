import { pgTable } from 'drizzle-orm/pg-core'

export const products = pgTable('products', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  price: t.integer().notNull(),
}))
