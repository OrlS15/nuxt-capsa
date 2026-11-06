import type { Driver } from './drivers'

/** A drizzle instance, as far as capsa touches it: the client is the driver's own. */
export interface Instance {
  $client: unknown
}

/** What an instance is built with: capsa's `connection` and `relations`, and whatever the project's `config.ts` adds. */
interface Options {
  connection?: unknown
  relations?: object
  /** A client the project built: capsa neither opens nor closes it. */
  client?: unknown
}

/**
 * What a source's generated module hands over: the project's own drizzle, the pieces of Nitro and Nuxt it may use,
 * and the facts of the source. Nothing is imported here, so the driver, Node and Cloudflare stay the project's.
 */
export interface SourceParts {
  /** The key of the source in `capsa.db`. */
  name: string
  /** The prefix of its `NUXT_*` variables. */
  env: string
  driver: Driver
  /** `drizzle` of the driver, from the project's drizzle-orm. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drizzle: (...args: any[]) => Instance
  withReplicas: (primary: Instance, replicas: Instance[]) => Instance
  relations: object
  /** Reads `runtimeConfig.capsa.db.<name>`, which only exists once the server runs. */
  runtimeConfig: () => { connection?: unknown, replicas?: unknown }
  /** The project's `config.ts`, when it has one. */
  config?: { options?: (base: Options) => Options }
  /** The store capsa picks for a driver that has one, and Node's `mkdirSync` to create its directory. */
  local?: { connection: string, dir: string, mkdirSync: (dir: string, options: { recursive: true }) => unknown }
  /** Cloudflare's bindings, for a driver whose connection names one. */
  bindings?: Record<string, unknown>
  /** Registers what runs when the server stops, for a driver that closes its client. */
  onClose?: (close: () => unknown) => unknown
}

export type Source = ReturnType<typeof defineSource>

/**
 * Makes a source's instance, built on first use: runtime config and `NUXT_*` variables only exist once the server runs.
 *
 * @example
 * const { getDb } = defineSource({ name: 'default', env: 'NUXT_CAPSA_DB_DEFAULT', driver: DRIVERS.postgresql.pglite, drizzle, … })
 * getDb()  // the same instance on every call
 */
export function defineSource(parts: SourceParts) {
  let instance: Instance | undefined

  return {
    driver: parts.driver,
    getDb: () => instance ??= createDb(parts),
    resolveOptions: () => resolveOptions(parts),
  }
}

/** Opens the primary, then each replica, all with the source's options. */
function createDb(parts: SourceParts) {
  const { options, replicas } = resolveOptions(parts)
  const connect = (connection: unknown) => closeWithServer(parts, options, open(parts, options, connection))
  const primary = connect(options.connection)

  if (!replicas.length) return primary

  // A client the config built is one connection: every replica would read from the primary through it.
  if (options.client) throw new Error(`[capsa] db source "${parts.name}": replicas can't be used with a \`client\` from config.ts. Remove ${parts.env}_REPLICAS or the client.`)

  return parts.withReplicas(primary, replicas.map(connect))
}

/** Calls drizzle the way the driver takes its connection: a binding goes first, anything else inside the options. */
function open({ driver, drizzle, bindings }: SourceParts, options: Options, connection: unknown) {
  if (driver.connection === 'binding') return drizzle(bindings![connection as string], options)

  return drizzle({ ...options, connection })
}

/**
 * Closes a client capsa opened when the server stops: in dev, Nitro starts the next worker before this one is gone,
 * and two of them on one local store would clash. A client the config built is the config's own.
 */
function closeWithServer({ driver, onClose }: SourceParts, options: Options, db: Instance) {
  if (driver.close && !options.client) onClose!(() => driver.close!(db.$client))

  return db
}

/** Reads the source's runtime config through its `config.ts`: what every instance of it is built with. */
function resolveOptions({ name, env, driver, runtimeConfig, relations, config, local }: SourceParts) {
  const fromEnv = runtimeConfig()
  // An environment variable reaches here as the text it is: the replicas are a JSON array in it, and so is a
  // connection that is drizzle's own object.
  const replicas = fromJson(fromEnv.replicas)
  const connection = driver.connection === 'json' ? fromJson(fromEnv.connection) : fromEnv.connection

  if (!Array.isArray(replicas)) throw new Error(`[capsa] db source "${name}": replicas must be a JSON array of connection strings. Set ${env}_REPLICAS.`)
  // Only the store capsa picked: a path the project set is the project's to create.
  if (local && connection === local.connection) local.mkdirSync(local.dir, { recursive: true })

  const options = config?.options?.({ connection, relations }) ?? { connection, relations }

  // Checked after the config, whose own `client` (a pool of its own) needs no connection string.
  if (!options.connection && !options.client) throw new Error(`[capsa] db source "${name}" has no connection. Set ${env}_CONNECTION, or return a \`client\` from \`options\` in its config.ts.`)

  return { options, replicas: replicas as unknown[] }
}

/**
 * Reads the JSON a runtime config value holds as text. A value that is not text, or not JSON, comes back as it is.
 *
 * @example
 * fromJson('["postgres://replica-1"]')  // ['postgres://replica-1']
 */
function fromJson(value: unknown): unknown {
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}
