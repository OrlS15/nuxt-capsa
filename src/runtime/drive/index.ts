import { defu } from 'defu'

/**
 * What each disk's `config.ts` may set: the options of its adapter and the plugins of files-sdk, filled in by the
 * types capsa generates.
 *
 * Empty here on purpose: an augmentation target has to be. Nothing in this file imports files-sdk, so it stays the
 * project's own dependency.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an augmentation target has to be empty
export interface CapsaDriveConfigs {}

/**
 * What the types capsa generates give the disk `N` under `K`.
 *
 * @example
 * Of<'documents', 'options'>  // the first parameter of s3Fetch, for a disk on s3-fetch
 */
type Of<N extends keyof CapsaDriveConfigs, K extends string> = CapsaDriveConfigs[N] extends Record<K, infer T> ? T : never

/**
 * Types a disk's `config.ts`: the adapter options that are not text, and the plugins of files-sdk. `options` returns
 * only what it changes: what the disk's variables set fills in the rest.
 *
 * The disk's name is a value, not a type argument: TypeScript infers all the type arguments or none, and written as
 * `<'documents'>` the name would leave the plugins, and the methods they add to the disk, untyped. The names are a
 * mapped type and not `keyof`, so that a wrong one is reported against the names themselves.
 *
 * @example
 * import { usage } from 'files-sdk/usage'
 * import { defineDriveConfig } from 'nuxt-capsa/drive'
 *
 * export default defineDriveConfig('documents', { options: () => ({ forcePathStyle: true }), plugins: [usage()] })
 */
export function defineDriveConfig<N extends { [D in keyof CapsaDriveConfigs]: D }[keyof CapsaDriveConfigs], const P extends readonly Of<N, 'plugin'>[] = []>(disk: N, config: {
  /** Receives the options the disk's variables set. */
  options?: (options: Record<string, string | boolean>) => Partial<Of<N, 'options'>>
  /** Plugins of files-sdk, run after capsa's own: the methods they add are the disk's. */
  plugins?: P
}): typeof config {
  const { options } = config

  return options ? { ...config, options: base => defu(options(base), base) as Partial<Of<N, 'options'>> } : config
}
