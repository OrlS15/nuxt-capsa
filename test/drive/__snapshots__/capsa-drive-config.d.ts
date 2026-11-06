export {}

declare module 'nuxt-capsa/drive' {
  interface CapsaDriveConfigs {
    "default": { options: NonNullable<Parameters<typeof import('files-sdk/fs').fs>[0]>, plugin: import('files-sdk').FilesPlugin }
    "documents": { options: NonNullable<Parameters<typeof import('files-sdk/s3-fetch').s3Fetch>[0]>, plugin: import('files-sdk').FilesPlugin }
  }
}
