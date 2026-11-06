import { defineAbilities } from 'nuxt-capsa/auth'

export default defineAbilities({
  schedule: user => user.plan === 'pro' || 'PRO_REQUIRED',
})
