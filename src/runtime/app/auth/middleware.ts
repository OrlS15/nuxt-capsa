import { defineNuxtRouteMiddleware, getRouteRules, navigateTo, useRuntimeConfig } from '#imports'
import type { AuthRouteMode } from '../../auth'
import { useCapsaSession } from './session'

/** Sends visitors away from the pages a `user` or `guest` rule does not admit. It runs only on those pages. */
export default defineNuxtRouteMiddleware(async (to) => {
  const mode = getRouteRules({ path: to.path }).appMiddleware?.['capsa-auth'] as AuthRouteMode | undefined
  // Anything but 'guest' needs a user: a value Nuxt ever rewrote locks the page instead of opening it.
  const needsUser = mode !== 'guest'
  const { loggedIn, resolved, fetchSession } = useCapsaSession()

  // An anonymous state is read again before turning the visitor away: right after a sign-in, better-auth
  // updates it only once the call has resolved, and a navigateTo right after would bounce to the login.
  if (!resolved.value || (needsUser && !loggedIn.value)) await fetchSession()

  // Written by capsa at build time. Typed here, since the runtime config types Nuxt generates belong to the app.
  const { redirects } = (useRuntimeConfig().public.capsa as { auth: { redirects: Record<'user' | 'guest', string> } }).auth
  const target = needsUser ? !loggedIn.value && redirects.user : loggedIn.value && redirects.guest

  // A redirect to the page itself would loop: its own rule turns the visitor away again.
  if (target && target !== to.path) return navigateTo(target)
})
