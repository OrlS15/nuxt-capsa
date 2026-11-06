import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { setup, $fetch } from '@nuxt/test-utils/e2e'

describe('an app with no feature configured', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
  })

  it('builds and renders', async () => {
    const html = await $fetch('/')
    expect(html).toContain('<div>basic</div>')
  })
})
