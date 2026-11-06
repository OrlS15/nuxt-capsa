import { defineEventHandler } from 'nuxt/server'
import { useCapsaAuth } from '#capsa/auth'

// The handler on `capsa.auth.basePath`, the one every better-auth endpoint goes through.
export default defineEventHandler(event => useCapsaAuth().handler(event.req))
