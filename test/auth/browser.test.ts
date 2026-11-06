import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { $fetch, createPage, fetch, setup, url } from '@nuxt/test-utils/e2e'

const root = fileURLToPath(new URL('../fixtures/auth-pglite', import.meta.url))
// The built server runs in the test's cwd: a store of its own, never the repo's `.data`.
const store = await mkdtemp(join(tmpdir(), 'capsa-auth-browser-'))

/** Opens a page as a visitor with no cookie, whose waits fail well before the test's own timeout. */
async function open(path: string) {
  const page = await createPage(path)
  page.setDefaultTimeout(10_000)

  return page
}

/** How many session reads better-auth answered since the server started. */
async function sessionReads() {
  return (await $fetch<{ reads: number }>('/api/session-reads')).reads
}

describe('the session in the browser', async () => {
  // Registered before `setup`, so it runs after the server is stopped.
  afterAll(() => rm(store, { recursive: true, force: true }))

  await setup({
    rootDir: root,
    env: { NUXT_CAPSA_DB_DEFAULT_CONNECTION: store, NUXT_APP_SECRET: 'a-secret-for-the-e2e-test-0123456789' },
    browser: true,
    // The Chrome installed on the machine: GitHub's Ubuntu runners have one too.
    browserOptions: { type: 'chromium', launch: { channel: 'chrome' } },
  })

  it('reads the session in the browser after a client-side navigation', async () => {
    const page = await open('/')
    const before = await sessionReads()

    await page.getByRole('link', { name: 'Profile' }).click()
    await page.getByText('Not signed in').waitFor()

    expect(await sessionReads()).toBe(before + 1)
  })

  it('signs in and lands on a user page, follows a change to the user, and signs out', async () => {
    await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': 'http://localhost' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'password1234', name: 'Ada' }),
    })
    const page = await open('/login')

    // navigateTo('/dashboard') right after signIn: the route middleware reads again before turning anyone away.
    await page.getByPlaceholder('Email').fill('ada@example.com')
    await page.getByPlaceholder('Password').fill('password1234')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText('Hello Ada').waitFor()
    expect(new URL(page.url()).pathname).toBe('/dashboard')

    // No navigation here: only better-auth's session signal can tell the page.
    await page.goto(url('/rename'), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Rename' }).click()
    await page.getByText('Name: Ada Lovelace').waitFor()

    await page.goto(url('/dashboard'), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByPlaceholder('Email').waitFor()
    expect(new URL(page.url()).pathname).toBe('/login')
  })

  it('shows <Can>\'s refusal once the session arrives after a client-side navigation', async () => {
    const page = await open('/')

    await page.getByRole('link', { name: 'Rules' }).click()
    await page.getByText('schedule denied: SIGNED_OUT').waitFor()

    expect(await page.getByText('cannot edit: SIGNED_OUT').count()).toBe(1)
    expect(await page.getByText('can create projects').count()).toBe(0)
  })

  it('shows the error page when authorize turns the visitor away after a client-side navigation', async () => {
    const page = await open('/')

    await page.getByRole('link', { name: 'Authorize' }).click()

    await page.getByText('error 401: SIGNED_OUT').waitFor()
  })

  it('reads again on the next page when a read failed', async () => {
    const page = await open('/')
    const failed = page.waitForResponse('**/api/auth/get-session*')

    // An error answer: better-auth's client hands it back as `error`, where a dropped connection would throw.
    await page.route('**/api/auth/get-session*', route => route.fulfill({ status: 500 }))
    await page.getByRole('link', { name: 'Profile' }).click()
    await failed
    await page.unroute('**/api/auth/get-session*')

    // The failed read never reached the server: only a new one counts.
    const before = await sessionReads()
    await page.goBack()
    await page.getByRole('link', { name: 'Two readers' }).click()

    await expect.poll(() => page.locator('.user-name').allTextContents()).toEqual(['anonymous', 'anonymous'])
    expect(await sessionReads()).toBe(before + 1)
  })
})
