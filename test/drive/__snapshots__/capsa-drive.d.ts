declare module '#capsa/drive' {
  export interface CapsaDisks {
    "default": import('files-sdk').Files<ReturnType<typeof import('files-sdk/fs').fs>> & import('nuxt-capsa/drive/server').Serve
    "documents": import('files-sdk').Files<ReturnType<typeof import('files-sdk/s3-fetch').s3Fetch>> & import('nuxt-capsa/drive/server').Serve & import('files-sdk').ExtensionsOf<NonNullable<typeof import('#capsa/root/server/capsa/drive/documents/config').default['plugins']>>
  }

  export function useCapsaDrive<N extends "default" | "documents" = "default">(name?: N): CapsaDisks[N]
  export const serveSigned: ReturnType<typeof import('nuxt-capsa/drive/server').defineDrive>['serveSigned']
}
