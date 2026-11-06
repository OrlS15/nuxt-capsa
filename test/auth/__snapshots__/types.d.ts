export {}

// The client options, plus better-auth's type-only plugin that makes the server's additional fields known to the client.
type WithServerFields<O, Auth> = Omit<O, 'plugins'> & {
  plugins: [...(O extends { plugins: infer P extends readonly unknown[] } ? P : []), ReturnType<typeof import('better-auth/client/plugins').inferAdditionalFields<Auth>>]
}

declare module 'nuxt-capsa/auth' {
  interface CapsaAuthTypes {
    // capsa's own to set: basePath is capsa.auth.basePath in nuxt.config, and the secret comes from the environment.
    serverOptions: Omit<import('better-auth').BetterAuthOptions, 'basePath' | 'secret'> & { basePath?: never, secret?: never }
    clientOptions: import('better-auth/client').BetterAuthClientOptions
    auth: import('better-auth').Auth<ReturnType<typeof import('#capsa/root/server/capsa/auth/config').default>>
    session: CapsaAuthTypes['auth']['$Infer']['Session']
    client: import('better-auth/vue').VueAuthClient<WithServerFields<ReturnType<typeof import('#capsa/root/app/capsa/auth.config').default>, CapsaAuthTypes['auth']>>
    abilities: typeof import('#capsa/root/shared/capsa/abilities').default
  }
}
