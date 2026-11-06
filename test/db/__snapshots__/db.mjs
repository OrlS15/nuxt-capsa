import { getDb as getDb_0 } from '#capsa/db/default'
import { getDb as getDb_1 } from '#capsa/db/analytics'

export function useCapsaDb(name = "default") {
  switch (name) {
    case "default": return getDb_0()
    case "analytics": return getDb_1()
  }

  throw new Error(`[capsa] unknown db source "${name}". Configured: default, analytics.`)
}
