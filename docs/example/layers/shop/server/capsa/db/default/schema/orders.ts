import { pgTable } from 'drizzle-orm/pg-core'
import { products } from './products'

export const orders = pgTable('orders', t => ({
  id: t.serial().primaryKey(),
  productId: t.integer().notNull().references(() => products.id),
  quantity: t.integer().notNull(),
}))
