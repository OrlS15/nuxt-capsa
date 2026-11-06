import { defineRelationsPart } from 'drizzle-orm'
import * as schema from '#capsa/db/default/schema'

export default defineRelationsPart(schema, r => ({
  users: { comments: r.many.comments({ from: r.users.id, to: r.comments.userId }) },
  comments: { author: r.one.users({ from: r.comments.userId, to: r.users.id }) },
}))
