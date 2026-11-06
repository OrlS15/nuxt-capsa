// Counts the session reads better-auth answers, and remembers the header the client config adds.
import { definePlugin } from 'nitro'

export default definePlugin((nitro) => {
  nitro.hooks.hook('request', (event) => {
    if (!new URL(event.req.url).pathname.startsWith('/api/auth/get-session')) return

    globalThis.sessionReads = (globalThis.sessionReads ?? 0) + 1
    globalThis.clientHeader = event.req.headers.get('x-client-config') ?? undefined
  })
})
