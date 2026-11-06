import { defineRelationsPart } from 'drizzle-orm'
import * as schema from '#capsa/db/default/schema'

export default defineRelationsPart(schema, r => ({
  products: {
    orders: r.many.orders(),
  },
  orders: {
    product: r.one.products({ from: r.orders.productId, to: r.products.id }),
  },
}))
