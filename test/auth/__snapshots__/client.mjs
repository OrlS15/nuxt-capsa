import { createAuthClient } from 'better-auth/vue'
import config from '#capsa/root/app/capsa/auth.config'

export const basePath = "/api/auth"
export const createClient = defaults => createAuthClient(config(defaults))
