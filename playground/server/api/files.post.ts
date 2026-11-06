import { createError, defineEventHandler } from 'nuxt/server'
import { requireSession } from '#capsa/auth'

// Each user uploads under a folder of their own: users/<id>/<file name>.
export default defineEventHandler(async (event) => {
  const { user } = await requireSession(event)
  const file = (await event.req.formData()).get('file')

  if (!(file instanceof File)) throw createError({ status: 400, statusText: 'Send a file in the "file" field' })

  return useCapsaDrive().upload(`users/${user.id}/${file.name}`, file)
})
