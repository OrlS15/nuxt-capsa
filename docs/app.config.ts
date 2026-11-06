export default defineAppConfig({
  // No GitHub repository yet: without a URL Docus would build a broken "Edit this page" link.
  github: false,
  seo: {
    title: 'Nuxt Capsa',
    description: 'The missing wiring for Nuxt.',
  },
  header: {
    title: 'Nuxt Capsa',
    logo: {
      alt: 'Nuxt Capsa',
      light: '/logo/mark-light.svg',
      dark: '/logo/mark-dark.svg',
      wordmark: {
        light: '/logo/wordmark-light.svg',
        dark: '/logo/wordmark-dark.svg',
      },
      display: 'wordmark',
    },
  },
  toc: {
    title: 'On this page',
  },
})
