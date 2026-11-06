import capsa from '../../../src/module'

export default defineNuxtConfig({
  // From src, or the build of the package prepared-types.test.ts points at.
  modules: [process.env.CAPSA_BUILT_MODULE ?? capsa],
  capsa: {
    drive: {
      default: { adapter: 'fs' },
      documents: { adapter: 's3-fetch' },
      archive: { adapter: 'fs' },
    },
  },
})
