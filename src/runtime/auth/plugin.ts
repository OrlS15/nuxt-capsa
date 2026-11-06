import { definePlugin } from 'nitro'
import { authReady } from '#capsa/auth'

// Derives the auth secret when the server starts, and makes requests wait for it until it exists. Where the start
// cannot derive it, such as a Worker's global scope, the first request does; a request that fails leaves the hook for
// the next one to try again.
export default definePlugin((nitro) => {
  // A prerender builds pages where NUXT_APP_SECRET may not be set: one that never uses auth renders without it.
  const ready = import.meta.prerender ? () => authReady().catch(() => {}) : authReady
  const unhook = nitro.hooks.hook('request', async () => {
    await ready()
    unhook()
  })
  authReady().then(unhook, () => {})
})
