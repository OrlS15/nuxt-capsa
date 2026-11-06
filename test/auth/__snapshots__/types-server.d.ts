declare module '#capsa/auth' {
  export const { useCapsaAuth, authReady, getSession, requireSession, can, cannot, authorize }: import('nuxt-capsa/auth/server').AuthServer
}
