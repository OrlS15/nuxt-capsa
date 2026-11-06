import { defineEventHandler, readBody } from 'nuxt/server'
import { comments, users } from '#capsa/db/default/schema'

export default defineEventHandler(async (event) => {
  const { name, email } = await readBody<{ name: string, email: string }>(event)
  const db = useCapsaDb()

  const [user] = await db.insert(users).values({ name, email }).returning()
  await db.insert(comments).values({ userId: user!.id, content: `Hello, I'm ${name}` })

  return user
})
