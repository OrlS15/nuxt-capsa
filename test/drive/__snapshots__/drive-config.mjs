import { createFiles } from 'files-sdk'
import { fs } from 'files-sdk/fs'
import { s3Fetch } from 'files-sdk/s3-fetch'
import { defineDrive } from 'nuxt-capsa/drive/server'
import config_documents from '#capsa/root/server/capsa/drive/documents/config'

export const { useCapsaDrive, serveSigned } = defineDrive({
  createFiles,
  disks: {
    "default": { adapter: fs, env: "NUXT_CAPSA_DRIVE_DEFAULT", defaults: {"root":".data/capsa/drive/default"} },
    "documents": { adapter: s3Fetch, env: "NUXT_CAPSA_DRIVE_DOCUMENTS", defaults: {}, config: config_documents },
  },
})
