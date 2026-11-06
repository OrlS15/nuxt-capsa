import { usage } from 'files-sdk/usage'
import { defineDriveConfig } from 'nuxt-capsa/drive'

// The plugin counts every call made through the disk: useCapsaDrive().usage() is typed from it.
export default defineDriveConfig('default', { plugins: [usage()] })
