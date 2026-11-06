import { camelCase } from 'scule'
import type { Disk } from './setup'

/**
 * Renders `#capsa/drive`, the module `useCapsaDrive` is auto-imported from. It only imports and hands over: what it
 * does lives in `runtime/drive/server.ts`.
 *
 * files-sdk is imported here, in generated code, and never by capsa itself: it stays the project's dependency, and
 * only the adapters the disks name reach the bundle. An adapter's factory is its name in camel case. A disk's
 * `config.ts` is imported as `config_<name>`, which no factory's name can be.
 *
 * @example
 * With a `default` disk on fs and a `documents` one on s3-fetch, which has a `config.ts`:
 * ```js
 * import { createFiles } from 'files-sdk'
 * import { fs } from 'files-sdk/fs'
 * import { s3Fetch } from 'files-sdk/s3-fetch'
 * import { defineDrive } from 'nuxt-capsa/drive/server'
 * import config_documents from '#capsa/root/server/capsa/drive/documents/config'
 *
 * export const { useCapsaDrive, serveSigned } = defineDrive({
 *   createFiles,
 *   disks: {
 *     "default": { adapter: fs, env: "NUXT_CAPSA_DRIVE_DEFAULT", defaults: {"root":".data/capsa/drive/default"} },
 *     "documents": { adapter: s3Fetch, env: "NUXT_CAPSA_DRIVE_DOCUMENTS", defaults: {}, config: config_documents },
 *   },
 * })
 * ```
 */
export function renderDriveModule(disks: Disk[]) {
  const adapters = [...new Set(disks.map(disk => disk.adapter))]
  const imports = [
    ...adapters.map(adapter => `import { ${camelCase(adapter)} } from 'files-sdk/${adapter}'`),
    `import { defineDrive } from 'nuxt-capsa/drive/server'`,
    ...disks.filter(disk => disk.config).map(disk => `import config_${disk.name} from '${disk.config}'`),
  ]
  const entries = disks.map(disk => `    ${JSON.stringify(disk.name)}: { adapter: ${camelCase(disk.adapter)}, env: ${JSON.stringify(disk.env)}, defaults: ${JSON.stringify(disk.defaults)}${disk.config ? `, config: config_${disk.name}` : ''} },`)

  return `import { createFiles } from 'files-sdk'
${imports.join('\n')}

export const { useCapsaDrive, serveSigned } = defineDrive({
  createFiles,
  disks: {
${entries.join('\n')}
  },
})
`
}

/**
 * Renders the types of `#capsa/drive`: each disk is the `Files` of files-sdk, over the adapter it names, with capsa's
 * `serve` and the methods the plugins of its `config.ts` add.
 *
 * @example
 * With a `default` disk on fs and a `documents` one on s3-fetch, which has a `config.ts`:
 * ```ts
 * declare module '#capsa/drive' {
 *   export interface CapsaDisks {
 *     "default": import('files-sdk').Files<ReturnType<typeof import('files-sdk/fs').fs>> & import('nuxt-capsa/drive/server').Serve
 *     "documents": import('files-sdk').Files<ReturnType<typeof import('files-sdk/s3-fetch').s3Fetch>> & import('nuxt-capsa/drive/server').Serve & import('files-sdk').ExtensionsOf<NonNullable<typeof import('#capsa/root/server/capsa/drive/documents/config').default['plugins']>>
 *   }
 *
 *   export function useCapsaDrive<N extends "default" | "documents" = "default">(name?: N): CapsaDisks[N]
 *   export const serveSigned: ReturnType<typeof import('nuxt-capsa/drive/server').defineDrive>['serveSigned']
 * }
 * ```
 */
export function renderDriveTypes(disks: Disk[]) {
  const entries = disks.map((disk) => {
    const plugins = disk.config ? ` & import('files-sdk').ExtensionsOf<NonNullable<typeof import('${disk.config}').default['plugins']>>` : ''

    return `    ${JSON.stringify(disk.name)}: import('files-sdk').Files<ReturnType<typeof import('files-sdk/${disk.adapter}').${camelCase(disk.adapter)}>> & import('nuxt-capsa/drive/server').Serve${plugins}`
  })
  // Written out, so that a wrong name is reported against the names themselves, not `keyof CapsaDisks`.
  const names = disks.map(disk => JSON.stringify(disk.name)).join(' | ')

  return `declare module '#capsa/drive' {
  export interface CapsaDisks {
${entries.join('\n')}
  }

  export function useCapsaDrive<N extends ${names} = "default">(name?: N): CapsaDisks[N]
  export const serveSigned: ReturnType<typeof import('nuxt-capsa/drive/server').defineDrive>['serveSigned']
}
`
}

/**
 * Renders the augmentation that types each disk's `config.ts`: the first parameter of its adapter's factory, and the
 * plugins of files-sdk.
 *
 * A file of its own, and a module: a `declare module 'nuxt-capsa/drive'` in a script file is an ambient declaration,
 * which replaces the package instead of extending it.
 *
 * @example
 * With a `default` disk on fs:
 * ```ts
 * export {}
 *
 * declare module 'nuxt-capsa/drive' {
 *   interface CapsaDriveConfigs {
 *     "default": { options: NonNullable<Parameters<typeof import('files-sdk/fs').fs>[0]>, plugin: import('files-sdk').FilesPlugin }
 *   }
 * }
 * ```
 */
export function renderConfigTypes(disks: Disk[]) {
  const entries = disks.map(disk => `    ${JSON.stringify(disk.name)}: { options: NonNullable<Parameters<typeof import('files-sdk/${disk.adapter}').${camelCase(disk.adapter)}>[0]>, plugin: import('files-sdk').FilesPlugin }`)

  return `export {}

declare module 'nuxt-capsa/drive' {
  interface CapsaDriveConfigs {
${entries.join('\n')}
  }
}
`
}
