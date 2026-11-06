export {}

declare module 'nuxt-capsa/db' {
  interface CapsaDbConfigs {
    "default": {
      options?: (options: { connection: Extract<Parameters<typeof import('drizzle-orm/aws-data-api/pg').drizzle>[0], { connection: unknown }>['connection'], relations: typeof import('#capsa/db/default').relations }) => Partial<Extract<Parameters<typeof import('drizzle-orm/aws-data-api/pg').drizzle>[0], object>>
      kit?: (config: import('drizzle-kit').Config) => Partial<import('drizzle-kit').Config>
    }
  }
}
