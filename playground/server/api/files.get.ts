import { defineEventHandler } from 'nuxt/server'
import { requireSession } from '#capsa/auth'

// The visitor's files, each with a link capsa signed for five minutes: the disk is on fs, which signs none of its own.
export default defineEventHandler(async (event) => {
  const { user } = await requireSession(event)
  const disk = useCapsaDrive()
  const { items } = await disk.list({ prefix: `users/${user.id}/` })

  return {
    files: await Promise.all(items.map(async file => ({
      key: file.key,
      size: file.size,
      link: await disk.url(file.key, { expiresIn: 300 }),
    }))),
    // Added by the usage plugin of server/capsa/drive/default/config.ts.
    operations: disk.usage().operationsByKind,
  }
})
