import { fileURLToPath } from 'node:url'
import { twoslashAsText } from './mdc.config'

declare module '@nuxt/schema' {
  interface NuxtHooks {
    // Nuxt Content's own, whose types this config doesn't load: a page it parsed, before it is stored.
    'content:file:afterParse': (ctx: { content: { body?: { value?: Parameters<typeof twoslashAsText>[0][] } } }) => void
  }
}

// GitHub Pages serves the docs under the repository's name: the deploy sets it, with its trailing slash.
const baseURL = process.env.NUXT_APP_BASE_URL || '/'

// https://docus.dev
export default defineNuxtConfig({
  extends: ['docus'],
  app: {
    head: {
      // Nuxt prefixes its own assets with the base URL, but not a link written here.
      link: [{ rel: 'icon', type: 'image/svg+xml', href: `${baseURL}favicon.svg`, tagPriority: 'low' }],
    },
  },
  // The styles of the `twoslash` code blocks: types on hover, pinned types, errors.
  css: ['@shikijs/twoslash/style-rich.css', '~/assets/twoslash.css'],
  site: {
    name: 'Nuxt Capsa',
  },
  content: {
    // Content reuses a page's parsed output while the page is unchanged: twoslash must run again, since the types may have changed.
    build: { markdown: { twoslashRun: Date.now() } },
  },
  alias: {
    // Docus' modules import `nuxt/app` without depending on nuxt, so it would resolve to the repository's Nuxt 5.
    'nuxt/app': fileURLToPath(new URL('./node_modules/nuxt/dist/app/index.js', import.meta.url)),
  },
  // The example app has its own build: the docs neither scan nor watch it.
  ignore: ['example/**'],
  // A navigation group has no page of its own: its path leads to the group's first page.
  routeRules: {
    '/getting-started': { redirect: '/getting-started/introduction' },
    '/database': { redirect: '/database/overview' },
    '/database/drizzle': { redirect: '/database/drizzle/setup' },
    '/drive': { redirect: '/drive/overview' },
  },
  compatibilityDate: '2026-09-01',
  nitro: {
    prerender: {
      // Nothing links to these paths, so the crawler would skip them and the static site would 404.
      routes: ['/getting-started', '/database', '/database/drizzle', '/drive'],
      // `page/index.html`, not Docus' `page.html` next to a `page/` folder: GitHub Pages sends `/page` to that folder.
      autoSubfolderIndex: true,
    },
  },
  hooks: {
    // The markdown copy of each page, for agents and the copy button, gets the types and errors the page shows.
    'content:file:afterParse': ({ content }) => content.body?.value?.forEach(twoslashAsText),
  },
  // The images are SVGs that need no resizing, and IPX would add the base URL twice to the logo's path.
  image: { provider: 'none' },
  // The docs are a static site, and an MCP server needs a server to answer.
  mcp: { enabled: false },
})
