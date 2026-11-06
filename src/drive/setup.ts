import { existsSync } from 'node:fs'
import { addServerHandler, addServerImports, addServerTemplate, addTypeTemplate, getLayerDirectories } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
// Nuxt hands every path over with forward slashes, on Windows too: joined the same way, they stay so.
import { join } from 'node:path/posix'
import { snakeCase } from 'scule'
import { checkPeers, rootAlias, runtimePath } from '../utils'
import { renderConfigTypes, renderDriveModule, renderDriveTypes } from './templates'

/**
 * One disk: where files are kept. Only its adapter is written here: its options are its variables, one per option
 * of the adapter (`NUXT_CAPSA_DRIVE_<NAME>_<OPTION>`), and what is not text goes in `server/capsa/drive/<name>/config.ts`.
 *
 * @example
 * { adapter: 's3-fetch' }  // NUXT_CAPSA_DRIVE_<NAME>_BUCKET, _ENDPOINT, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY
 */
export interface DiskConfig {
  /** The adapter of files-sdk that stores the files, by the name files-sdk exports it under: `files-sdk/<adapter>`. */
  adapter: string
}

/**
 * Disks, keyed by name: letters, numbers and `_`. `default` is required, any other is optional.
 *
 * The name says what the disk is for, not where it stores: it is what `useCapsaDrive('<name>')` takes, and part of
 * its variables, spelled the way Nitro reads them (`userFiles` → `NUXT_CAPSA_DRIVE_USER_FILES_BUCKET`).
 *
 * @example
 * { default: { adapter: 's3-fetch' }, avatars: { adapter: 's3-fetch' } }
 */
export interface DriveFeatureOptions {
  /** The disk `useCapsaDrive()` hands back when it is called with no name. */
  default: DiskConfig
  [name: string]: DiskConfig
}

/**
 * One disk, as the generated code receives it.
 *
 * @example
 * { name: 'default', adapter: 'fs', env: 'NUXT_CAPSA_DRIVE_DEFAULT', defaults: { root: '.data/capsa/drive/default' } }
 */
export interface Disk {
  /** The key of the disk in `capsa.drive`. */
  readonly name: string
  readonly adapter: string
  /** The prefix of its variables. */
  readonly env: string
  /** The options capsa fills in, under what the disk's variables set. */
  readonly defaults: Record<string, string>
  /** The project's `config.ts` for the disk, as generated code imports it, when there is one. */
  readonly config?: string
}

/** What a disk name may hold: it becomes part of a `NUXT_*` variable, where Nitro reads "-" as "_". */
const DISK_NAME = /^\w+$/

/** How files-sdk names its adapters, each one a module of its own: `s3-fetch` is `files-sdk/s3-fetch`. */
const ADAPTER_NAME = /^[a-z\d]+(?:-[a-z\d]+)*$/

/**
 * The options capsa fills in for an adapter. A disk on the machine goes next to the local stores of the db sources: in
 * dev under the project, wherever `nuxt dev` was started from.
 */
const DEFAULTS: Record<string, (disk: string, nuxt: Nuxt) => Record<string, string>> = {
  fs: (disk, { options }) => ({ root: join(options.dev ? options.rootDir : '', `.data/capsa/drive/${disk}`) }),
}

/**
 * Wires the drive feature into the build: the shared `#capsa/drive`, the route of the links a disk on fs signs, and
 * the types.
 *
 * Every disk is made before anything is registered, so a name that is wrong stops the build first.
 */
export function setupDriveFeature(nuxt: Nuxt, options: DriveFeatureOptions) {
  const disks = Object.entries(options).map(([name, config]) => createDisk(nuxt, name, config))

  // The auto-import is also what keeps an unused drive out of the bundle: with nothing referencing
  // `useCapsaDrive`, nothing imports this module and no adapter is pulled in.
  addServerTemplate({ filename: '#capsa/drive', getContents: () => renderDriveModule(disks) })
  addServerImports([{ name: 'useCapsaDrive', from: '#capsa/drive' }])

  // fs has no links of its own: capsa signs them, and answers them here.
  if (disks.some(disk => disk.adapter === 'fs'))
    addServerHandler({ route: '/_capsa/drive/:disk/**:key', handler: runtimePath('drive/handler') })

  // In the nitro and the app context, not `shared/`: `nuxt/server` would pull every route in, where server auto-imports do not exist.
  addTypeTemplate({ filename: 'types/capsa-drive.d.ts', getContents: () => renderDriveTypes(disks) }, { nitro: true, nuxt: true })
  addTypeTemplate({ filename: 'types/capsa-drive-config.d.ts', getContents: () => renderConfigTypes(disks) }, { nitro: true, nuxt: true })

  // In dev, creating or deleting a disk's config.ts changes what is generated: only a restart picks that up.
  restartOnConfigs(nuxt, disks)

  // Last, and handed back: everything above stays synchronous, so a wrong disk still throws as the setup is called.
  return checkPeers(nuxt.options.rootDir, ['files-sdk'])
}

/** Restarts Nuxt when a disk's `config.ts` is created or deleted. */
function restartOnConfigs(nuxt: Nuxt, disks: Disk[]) {
  const configs = disks.map(disk => configPath(nuxt, disk.name))

  nuxt.hook('builder:watch', async (event, file) => {
    if ((event === 'add' || event === 'unlink') && configs.includes(file)) await nuxt.callHook('restart')
  })
}

/**
 * Where a disk's `config.ts` goes: in the project's server directory, never a layer's.
 *
 * @example
 * configPath(nuxt, 'documents')  // '/app/server/capsa/drive/documents/config.ts'
 */
function configPath(nuxt: Nuxt, disk: string) {
  return join(getLayerDirectories(nuxt)[0]!.server, 'capsa/drive', disk, 'config.ts')
}

/**
 * Makes a disk from its entry in `capsa.drive`, and its `config.ts` when the project has one.
 *
 * @example
 * createDisk(nuxt, 'userFiles', { adapter: 's3-fetch' }).env  // 'NUXT_CAPSA_DRIVE_USER_FILES'
 */
function createDisk(nuxt: Nuxt, name: string, { adapter }: DiskConfig): Disk {
  if (!DISK_NAME.test(name))
    throw new Error(`[capsa] invalid drive disk name "${name}": use only letters, numbers and "_".`)

  if (!ADAPTER_NAME.test(adapter))
    throw new Error(`[capsa] drive disk "${name}" names "${adapter}" as its adapter: write it as files-sdk exports it, like "s3-fetch" for files-sdk/s3-fetch.`)

  const config = configPath(nuxt, name)

  return {
    name,
    adapter,
    // Spelled as Nitro spells a runtime config key, from the same scule function: `userFiles` is `NUXT_CAPSA_DRIVE_USER_FILES`.
    env: `NUXT_${snakeCase<string>(`capsa_drive_${name}`).toUpperCase()}`,
    defaults: DEFAULTS[adapter]?.(name, nuxt) ?? {},
    config: existsSync(config) ? rootAlias(nuxt.options.rootDir, config) : undefined,
  }
}
