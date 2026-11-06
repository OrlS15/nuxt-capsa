import { defineClientAuthConfig } from 'nuxt-capsa/auth'

export default defineClientAuthConfig(() => ({
  fetchOptions: { headers: { 'x-client-config': 'yes' } },
}))
