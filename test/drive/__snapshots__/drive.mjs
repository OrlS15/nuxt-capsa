import { createFiles } from 'files-sdk'
import { fs } from 'files-sdk/fs'
import { s3Fetch } from 'files-sdk/s3-fetch'
import { vercelBlob } from 'files-sdk/vercel-blob'
import { defineDrive } from 'nuxt-capsa/drive/server'

export const { useCapsaDrive, serveSigned } = defineDrive({
  createFiles,
  disks: {
    "default": { adapter: fs, env: "NUXT_CAPSA_DRIVE_DEFAULT", defaults: {"root":".data/capsa/drive/default"} },
    "documents": { adapter: s3Fetch, env: "NUXT_CAPSA_DRIVE_DOCUMENTS", defaults: {} },
    "userFiles": { adapter: s3Fetch, env: "NUXT_CAPSA_DRIVE_USER_FILES", defaults: {} },
    "avatars": { adapter: vercelBlob, env: "NUXT_CAPSA_DRIVE_AVATARS", defaults: {} },
  },
})
