import { defineNuxtModule } from '@nuxt/kit'
import { setupAuthFeature, type AuthFeatureOptions } from './auth/setup'
import { setupDbFeature, type DbFeatureOptions } from './db/setup'
import { setupDriveFeature, type DriveFeatureOptions } from './drive/setup'
import { ROOT, runtimePath } from './utils'

export type * from './auth/setup'
export type * from './db/setup'
export type * from './drive/setup'

export interface ModuleOptions {
  /** Database connections, keyed by name. Leave it out to keep the db feature off. */
  db?: DbFeatureOptions
  /** better-auth, wired into Nuxt. Leave it out to keep the auth feature off. */
  auth?: AuthFeatureOptions
  /** Disks for files, on files-sdk, keyed by name. Leave it out to keep the drive feature off. */
  drive?: DriveFeatureOptions
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-capsa',
    configKey: 'capsa',
    compatibility: { nuxt: '>=5.0.0-0' },
  },
  async setup(options, nuxt) {
    // What generated code imports capsa's runtime and the project's own files by.
    nuxt.options.alias['nuxt-capsa/db'] = runtimePath('db')
    nuxt.options.alias['nuxt-capsa/auth'] = runtimePath('auth')
    nuxt.options.alias['nuxt-capsa/drive'] = runtimePath('drive')
    nuxt.options.alias[ROOT] = nuxt.options.rootDir

    if (options.db)
      await setupDbFeature(nuxt, options.db)

    if (options.auth)
      await setupAuthFeature(nuxt, options.auth)

    if (options.drive)
      await setupDriveFeature(nuxt, options.drive)
  },
})
