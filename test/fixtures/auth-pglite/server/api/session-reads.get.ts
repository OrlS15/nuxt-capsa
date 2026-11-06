import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(() => ({ reads: globalThis.sessionReads ?? 0, clientHeader: globalThis.clientHeader ?? null }))

// Here, not in the plugin that writes them: the app's types read this route's response.
declare global {

  var sessionReads: number | undefined

  var clientHeader: string | undefined
}
