declare module '#capsa/db/default/schema' {
  export * from '#capsa/root/server/capsa/db/default/schema'
}

declare module '#capsa/db/default' {
  import type { defineRelationsPart } from 'drizzle-orm'
  import type { drizzle } from 'drizzle-orm/pglite'
  import type * as tables from '#capsa/db/default/schema'

  type Db = ReturnType<typeof drizzle<typeof relations>>

  export * as schema from '#capsa/db/default/schema'
  export const relations: Omit<Omit<ReturnType<typeof defineRelationsPart<typeof tables>>, keyof typeof import('#capsa/root/layers/base/relations')['default']> & typeof import('#capsa/root/layers/base/relations')['default'], keyof typeof import('#capsa/root/relations')['default']> & typeof import('#capsa/root/relations')['default']
  export function getDb(): Db & { $replica?: Db, $replicas?: Db[] }
  /** Applies the migrations the server shipped with that are not in the database yet: a new run on every call. */
  export function applyMigrations(): Promise<void>
  /** Makes sure they are applied: awaits the run under way or the one that succeeded, and starts one when there is none. */
  export function ensureMigrations(): Promise<void>
}

