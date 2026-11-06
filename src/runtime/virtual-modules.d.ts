// The modules capsa generates inside an app's build, which its runtime imports. Declared here so that capsa's own
// typecheck compiles the runtime before any app has prepared it.

declare module '#build/capsa/auth/abilities.mjs' {
  const abilities: import('./auth').Rules
  export default abilities
}

declare module '#build/capsa/auth/client.mjs' {
  /** `capsa.auth.basePath`. */
  export const basePath: string
  /** Creates better-auth's client, with the project's client config when there is one. */
  export const createClient: (defaults: import('./auth').ClientAuthDefaults) => import('./auth').AuthClient
}

declare module '#capsa/auth' {
  /** What `#capsa/auth` exports, as `defineAuth` makes it. */
  type Auth = ReturnType<typeof import('./auth/server').defineAuth>

  export const useCapsaAuth: Auth['useCapsaAuth']
  export const authReady: Auth['authReady']
}

declare module '#capsa/drive' {
  export const serveSigned: ReturnType<typeof import('./drive/server').defineDrive>['serveSigned']
}
