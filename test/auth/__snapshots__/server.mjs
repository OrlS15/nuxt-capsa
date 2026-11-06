import { betterAuth, env } from 'better-auth'
import { defineAuth } from 'nuxt-capsa/auth/server'
import config from '#capsa/root/server/capsa/auth/config'
import abilities from '#capsa/auth/abilities'

export const { useCapsaAuth, authReady, getSession, requireSession, can, cannot, authorize } = defineAuth({
  betterAuth,
  env,
  config,
  abilities,
  basePath: "/api/auth",
})
