import { defineEventHandler } from 'nuxt/server'

// What the usage plugin of the archive disk's config.ts has counted.
export default defineEventHandler(() => useCapsaDrive('archive').usage())
