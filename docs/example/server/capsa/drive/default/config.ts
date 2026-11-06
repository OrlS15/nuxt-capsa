import { usage } from 'files-sdk/usage'
import { defineDriveConfig } from 'nuxt-capsa/drive'

export default defineDriveConfig('default', {
  options: () => ({
    fetch: (request) => {
      console.log(request.method, request.url)
      return fetch(request)
    },
  }),
  plugins: [usage()],
})
