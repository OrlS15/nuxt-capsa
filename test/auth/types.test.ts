import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderServerTypes, renderTypes } from '../../src/auth/templates'
import { typeErrors } from '../helpers/types'

/** Where the files are, as a path the compiler resolves. */
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// What an app's tsconfig gives: nuxt-capsa/auth is the runtime file the generated types augment, vue comes with
// Nuxt, and the libraries' own declarations go unchecked.
const app = {
  paths: {
    'nuxt-capsa/auth': [at('../../src/runtime/auth/index.ts')],
    // Where the types of #capsa/auth are read from.
    'nuxt-capsa/auth/server': [at('../../src/runtime/auth/server.ts')],
    'vue': [at('../../node_modules/.pnpm/node_modules/vue')],
  },
  skipLibCheck: true,
}

const SERVER_CONFIG = `import { admin } from 'better-auth/plugins'
import { defineServerAuthConfig } from 'nuxt-capsa/auth'

export default defineServerAuthConfig(() => ({
  user: { additionalFields: { plan: { type: ['free', 'pro'], required: false, input: true } } },
  plugins: [admin()],
}))`

const CLIENT_CONFIG = `import { adminClient } from 'better-auth/client/plugins'
import { defineClientAuthConfig } from 'nuxt-capsa/auth'

export default defineClientAuthConfig(() => ({ plugins: [adminClient()] }))`

const RULES = `import { defineAbilities, deny, guest } from 'nuxt-capsa/auth'

export default defineAbilities({
  schedule: user => user.plan === 'pro' || 'PRO_REQUIRED',
  post: {
    view: guest((user, post: { authorId: string, published: boolean }) => post.published || user?.id === post.authorId || deny('NOT_FOUND', { status: 404 })),
    edit: (user, post: { authorId: string }) => user.id === post.authorId || 'NOT_THE_AUTHOR',
  },
  projects: {
    create: (_, count: number) => count < 3 || deny('LIMIT_REACHED', { status: 429, details: { limit: 3 } }),
  },
})`

const SIGN_UP = `{ email: 'ada@example.com', password: 'password1234', name: 'Ada', plan: 'pro' }`

// Each test compiles against better-auth's own types: a few seconds each on a busy machine, past vitest's default of 5.
describe('better-auth\'s types, where capsa expects them', { timeout: 30_000 }, () => {
  // What capsa's runtime declares of better-auth before any type is generated: the real one has to fit it.
  it('lets the real betterAuth, env, instance and client stand where capsa\'s runtime takes them', async () => {
    const errors = await typeErrors({
      'contract.ts': `import { betterAuth, env } from 'better-auth'
import { createAuthClient } from 'better-auth/vue'
import type { AuthClient, AuthInstance } from 'nuxt-capsa/auth'
import type { AuthParts } from 'nuxt-capsa/auth/server'

export const parts: Pick<AuthParts, 'betterAuth' | 'env'> = { betterAuth, env }
export const instance: AuthInstance = betterAuth({ emailAndPassword: { enabled: true } })
export const client: AuthClient = createAuthClient({ baseURL: 'http://localhost:3000' })`,
    }, app)

    expect(errors).toEqual([])
  })
})

describe('the types capsa generates for auth', { timeout: 30_000 }, () => {
  it('types the session, the server instance and the client from the two config files', async () => {
    const errors = await typeErrors({
      'auth.d.ts': renderTypes('./server-config', './client-config', []),
      'auth-server.d.ts': renderServerTypes(),
      'server-config.ts': SERVER_CONFIG,
      'client-config.ts': CLIENT_CONFIG,
      'use.ts': `import type { RequestEvent } from 'nuxt/server'
import type { AuthClient, AuthSession } from 'nuxt-capsa/auth'
import { getSession, useCapsaAuth } from '#capsa/auth'

declare const client: AuthClient
declare const session: AuthSession
declare const event: RequestEvent

export const plan: 'free' | 'pro' | null | undefined = session.user.plan
export const role: string | null | undefined = session.user.role
export const onServer: 'free' | 'pro' | null | undefined = (await getSession(event))?.user.plan
export const listUsers = useCapsaAuth().api.listUsers
export const listUsersOnClient = client.admin.listUsers
export const signUp = client.signUp.email(${SIGN_UP})
export const wrongPlan = client.signUp.email({ ...${SIGN_UP}, plan: 'gold' })
export const noField = session.user.nope`,
    }, app)

    expect(errors).toEqual(['use.ts:15 TS2322', 'use.ts:16 TS2339'])
  })

  it('keeps basePath and the secret out of the server config: capsa sets them, and leaves better-auth\'s own secrets to the project', async () => {
    const errors = await typeErrors({
      'auth.d.ts': renderTypes('./server-config', undefined, []),
      'server-config.ts': `import { defineServerAuthConfig } from 'nuxt-capsa/auth'

export default defineServerAuthConfig(() => ({ basePath: '/auth' }))
export const secret = defineServerAuthConfig(() => ({ secret: 'mine' }))
export const secrets = defineServerAuthConfig(() => ({ secrets: [{ version: 1, value: 'mine' }] }))
export const fromDefaults = defineServerAuthConfig(defaults => ({ appName: defaults.secret }))
export const allowed = defineServerAuthConfig(() => ({ appName: 'mine', emailAndPassword: { enabled: true } }))`,
    }, app)

    expect(errors).toEqual(['server-config.ts:3 TS2322', 'server-config.ts:4 TS2322', 'server-config.ts:6 TS2339'])
  })

  it('makes the server fields known to the client when there is no client config', async () => {
    const errors = await typeErrors({
      'auth.d.ts': renderTypes('./server-config', undefined, []),
      'server-config.ts': SERVER_CONFIG,
      'use.ts': `import type { AuthClient } from 'nuxt-capsa/auth'

declare const client: AuthClient

export const signUp = client.signUp.email(${SIGN_UP})
export const updateUser = client.updateUser({ plan: 'free' })
export const listUsersOnClient = client.admin`,
    }, app)

    expect(errors).toEqual(['use.ts:7 TS2339'])
  })

  it('names the rules of every file, types their arguments, and follows guest rules, inline checks and refusals', async () => {
    const errors = await typeErrors({
      'auth.d.ts': renderTypes('./server-config', undefined, ['./abilities', './abilities-org']),
      'auth-server.d.ts': renderServerTypes(),
      'server-config.ts': SERVER_CONFIG,
      'abilities.ts': RULES,
      'abilities-org.ts': `import { defineAbilities } from 'nuxt-capsa/auth'

export default defineAbilities({
  org: { transfer: (_, from: string, to: string) => from !== to },
})`,
      'server.ts': `import type { RequestEvent } from 'nuxt/server'
import type { AuthUser } from 'nuxt-capsa/auth'
import { authorize, can, cannot, getSession, requireSession } from '#capsa/auth'

declare const event: RequestEvent
declare const post: { authorId: string, published: boolean }

export const edited: string = (await requireSession(event, 'post.edit', post)).user.id
export const viewer = await requireSession(event, 'post.view', post)
export const inline = await requireSession(event, user => user.plan === 'pro' || 'PRO_ONLY')
export const flag: boolean = can((await getSession(event))?.user, 'org.transfer', 'a', 'b')
export const guestRule = viewer.user
await requireSession(event, 'post.edt', post)
await requireSession(event, 'post.edit')
await requireSession(event, 'post', post)
await requireSession(event, user => user.nope === 1)
await requireSession(event, async user => user.plan === 'pro')
// The docs' way to decide on stored data: load it first, then decide right away.
const open = await Promise.resolve(false)
await requireSession(event, () => !open || 'OPEN_INVOICES')
// Another user, or the signed-in one once data that depends on them is loaded.
declare const other: AuthUser
export const not: boolean = cannot(other, 'org.transfer', 'a', 'b')
authorize(other, 'post.edit', post)
authorize(null, 'post.view', post)
authorize(other, user => user.plan === 'pro' || 'PRO_ONLY')
authorize(other, 'post.edit')
cannot(other, 'org.transfer', 'a', 1)`,
      'rules.ts': `import { defineAbilities, deny } from 'nuxt-capsa/auth'

defineAbilities({ gold: user => user.plan === 'gold' })
defineAbilities({ untyped: (_, record) => record.id })
deny('BROKEN', { status: 500 })
defineAbilities({ audit: async () => true })
deny({ status: 404 })`,
      'app.ts': `import type { AbilityRefusal, Authorize, Can, CanComponent } from 'nuxt-capsa/auth'

declare const can: Can
declare const authorize: Authorize
declare const Can: CanComponent
declare const post: { authorId: string, published: boolean } | undefined

export const editable: boolean | undefined = can('post.edit', post)
export const pro: boolean | undefined = can(user => user.plan === 'pro')
export const props = [Can({ do: 'post.edit', with: post }), Can({ do: 'org.transfer', with: ['a', 'b'] }), Can({ do: 'schedule' })]
export const limit: AbilityRefusal<'projects.create'> = { code: 'LIMIT_REACHED', details: { limit: 3 } }
type Denied = NonNullable<NonNullable<ReturnType<typeof Can<'projects.create'>>['__ctx']>['slots']['denied']>
export const slot: Parameters<Denied>[0]['code'] = 'SIGNED_OUT'
await authorize('org.transfer', 'a', undefined)
can(async user => user.plan === 'pro')
can('org.transfer', 'a')
Can({ do: 'post.edit' })
export const wrongDetails: AbilityRefusal<'projects.create'> = { code: 'LIMIT_REACHED', details: { limit: 'three' } }`,
    }, app)

    expect(errors).toEqual([
      'app.ts:15 TS2345', // a check written in place is synchronous
      'app.ts:16 TS2554', // org.transfer takes two arguments
      'app.ts:17 TS2345', // post.edit needs \`with\`
      'app.ts:18 TS2322', // the details are the rule's own
      'rules.ts:3 TS2367', // 'gold' is not a plan
      'rules.ts:4 TS18046', // an argument without a type is unknown, never any
      'rules.ts:5 TS2322', // a refusal is a 4xx
      'rules.ts:6 TS2322', // a rule is synchronous
      'rules.ts:7 TS2345', // deny needs a code: a plain refusal is \`false\`
      'server.ts:12 TS18047', // a guest rule may hand back no session
      'server.ts:13 TS2345', // not a rule's name
      'server.ts:14 TS2554', // post.edit needs the post
      'server.ts:15 TS2345', // a group is not a rule
      'server.ts:16 TS2339', // the user has no such field
      'server.ts:17 TS2345', // a check written in place on the server is synchronous too
      'server.ts:27 TS2554', // authorize needs the rule's arguments too
      'server.ts:28 TS2345', // and of the rule's types
    ])
  })
})
