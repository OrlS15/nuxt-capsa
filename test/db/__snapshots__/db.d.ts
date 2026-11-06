declare module '#capsa/db' {
  export interface CapsaDbSources {
    "default": ReturnType<typeof import('#capsa/db/default').getDb>
    "analytics": ReturnType<typeof import('#capsa/db/analytics').getDb>
  }

  export function useCapsaDb<N extends "default" | "analytics" = "default">(name?: N): CapsaDbSources[N]
}
