import { describe, expect, it } from 'vitest'
import { defineClientAuthConfig, defineServerAuthConfig } from '../../src/runtime/auth'
import type { ServerAuthDefaults } from '../../src/runtime/auth'

const DEFAULTS: ServerAuthDefaults = {
  baseURL: undefined,
  basePath: '/api/auth',
}

describe('auth config files', () => {
  it('pass capsa\'s defaults in, and merge what the config returns over them', () => {
    const config = defineServerAuthConfig(defaults => ({ appName: `app with ${defaults.basePath}`, emailAndPassword: { enabled: true } }))

    expect(config(DEFAULTS)).toEqual({ ...DEFAULTS, appName: 'app with /api/auth', emailAndPassword: { enabled: true } })
  })

  it('let the config win on a key it sets, and keep the defaults it does not touch', () => {
    const config = defineServerAuthConfig(() => ({ baseURL: 'https://mine.example' }))

    expect(config(DEFAULTS)).toEqual({ baseURL: 'https://mine.example', basePath: '/api/auth' })
  })

  it('merge the client config the same way', () => {
    const fetchImpl = (() => {}) as unknown as typeof fetch
    const defaults = { baseURL: 'http://localhost:3000', basePath: '/api/auth', fetchOptions: { customFetchImpl: fetchImpl } }
    const config = defineClientAuthConfig(() => ({ fetchOptions: { headers: { 'x-app': '1' } } }))

    expect(config(defaults)).toEqual({ ...defaults, fetchOptions: { customFetchImpl: fetchImpl, headers: { 'x-app': '1' } } })
  })
})
