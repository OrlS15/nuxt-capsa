import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { defineServerAuthConfig } from 'nuxt-capsa/auth'
import { useCapsaDb } from '#capsa/db'

export default defineServerAuthConfig(() => ({
  database: drizzleAdapter(useCapsaDb(), { provider: 'pg' }),
  emailAndPassword: { enabled: true, autoSignIn: true },
  user: {
    additionalFields: {
      // `input: true`, so the abilities page can switch the plan with updateUser().
      plan: { type: ['free', 'pro'], required: false, input: true, defaultValue: 'free' },
    },
  },
}))
