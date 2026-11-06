import { usage } from 'files-sdk/usage'
import { defineDriveConfig } from 'nuxt-capsa/drive'

// A folder of its own under the one NUXT_CAPSA_DRIVE_ARCHIVE_ROOT names, and a count of every call.
export default defineDriveConfig('archive', {
  options: ({ root }) => ({ root: `${root}/from-config` }),
  plugins: [usage()],
})
