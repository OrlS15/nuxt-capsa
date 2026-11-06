import { createAuthClient } from 'better-auth/vue'

export const basePath = "/api/auth"
export const createClient = defaults => createAuthClient(defaults)
