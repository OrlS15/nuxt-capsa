import type { useCapsaDb } from '#capsa/db'
import type { schema } from '#capsa/db/default'
import type { AuthUser } from 'nuxt-capsa/auth'
import type { CapsaDbConfigs } from 'nuxt-capsa/db'

// Read by shared code and the server here, and by the app through app/types/capsa.ts.
export type User = typeof schema.user.$inferSelect
export type Db = ReturnType<typeof useCapsaDb>
export type Options = CapsaDbConfigs['default']['options']

// @ts-expect-error A user is typed from the server config, where 'gold' is no plan.
export const gold: AuthUser['plan'] = 'gold'
