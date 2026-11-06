import { defu } from 'defu'
import type { VNode } from 'vue'

/**
 * What a page asks of the visitor, in `capsa.auth.routes` or in `routeRules`: signed in, signed out, or no rule
 * (`false`, which lifts a wider one).
 *
 * @example { '/dashboard/**': 'user', '/login': 'guest', '/dashboard/public': false }
 */
export type AuthRouteMode = 'user' | 'guest' | false

/**
 * Filled in by the types capsa generates, from better-auth and from the two config files.
 *
 * Empty on purpose: an augmentation target has to be. Nothing in this file imports better-auth, so the package
 * stays the project's own dependency, like drizzle-orm for the db feature.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CapsaAuthTypes {}

/**
 * What capsa fills in on the server, under the options your config returns. The secret is not among them: capsa
 * derives it from `NUXT_APP_SECRET` and hands it to better-auth itself.
 */
export interface ServerAuthDefaults {
  /** `NUXT_CAPSA_AUTH_URL`. Left empty, better-auth works the URL out from each request. */
  baseURL: string | undefined
  /** Where capsa mounts better-auth's handler: `capsa.auth.basePath`, under `app.baseURL`. */
  basePath: string
}

/** What capsa fills in on the client: where better-auth is, and on the server a fetch that calls Nitro in-process. */
export interface ClientAuthDefaults {
  /** The origin of the page. */
  baseURL: string
  /** `capsa.auth.basePath`, under `app.baseURL`. */
  basePath: string
  fetchOptions?: { customFetchImpl: typeof fetch }
}

/**
 * Types `server/capsa/auth/config.ts`: the options capsa hands to `betterAuth()`. Return only what you add or
 * change, capsa merges it over the defaults.
 *
 * @example
 * export default defineServerAuthConfig(() => ({ emailAndPassword: { enabled: true } }))
 */
export function defineServerAuthConfig<const O extends Generated<'serverOptions', object>>(config: (defaults: ServerAuthDefaults) => O) {
  return (defaults: ServerAuthDefaults): O => defu(config(defaults), defaults) as O
}

/**
 * Types `app/capsa/auth.config.ts`: the options capsa hands to better-auth's `createAuthClient()`, merged over
 * the defaults the same way.
 *
 * @example
 * export default defineClientAuthConfig(() => ({ plugins: [adminClient()] }))
 */
export function defineClientAuthConfig<const O extends Generated<'clientOptions', object>>(config: (defaults: ClientAuthDefaults) => O) {
  return (defaults: ClientAuthDefaults): O => defu(config(defaults), defaults) as O
}

/** `{ session, user }` of a signed-in visitor, typed from the server config. */
export type AuthSession = Generated<'session', { session: Record<string, unknown>, user: Record<string, unknown> }>

/** The signed-in user, typed from the server config with whatever the app adds to it. */
export type AuthUser = AuthSession['user']

/** A 4xx status a rule may turn a visitor away with. */
export type DenialStatus = 400 | 401 | 402 | 403 | 404 | 405 | 406 | 407 | 408 | 409 | 410 | 411 | 412 | 413 | 414 | 415
  | 416 | 417 | 418 | 421 | 422 | 423 | 424 | 425 | 426 | 428 | 429 | 431 | 451

declare const denialBrand: unique symbol

/** A refusal made by `deny()`: its code, the details for its message, and its HTTP status. */
export interface Denial<C extends string = string, D = unknown> {
  readonly [denialBrand]: true
  readonly code: C
  readonly details: D
  readonly status: DenialStatus
}

/**
 * Turns the visitor away with a code, when it needs a status other than 403 or details for its message. A rule that
 * needs neither returns the code itself, or `false` for a plain refusal.
 *
 * @example
 * deny('LIMIT_REACHED', { status: 429, details: { limit: 5 } })
 * deny('NOT_FOUND', { status: 404 })  // as if the record did not exist
 */
export function deny<const C extends string, const D = undefined>(code: C, { status = 403, details }: { status?: DenialStatus, details?: D } = {}): Denial<C, D> {
  // Marked with a registered symbol, so the server and the client bundle recognise it alike.
  return { [Symbol.for('capsa.denial')]: true, code, details, status } as unknown as Denial<C, D>
}

/** What a rule answers: only `true` lets in; `false`, a code or `deny()` turn away. */
export type Verdict = boolean | string | Denial

/**
 * A rule: the signed-in user, then what it is about, and a verdict right away. Synchronous, so the same rule runs in a
 * page; data it needs is loaded by the caller and passed in. Bivariant, so that each rule annotates its own arguments.
 */
type Rule = { rule(user: AuthUser, ...args: unknown[]): Verdict }['rule']

/** The rules of the app, grouped by nesting. */
export interface Rules { [name: string]: Rule | Rules }

/**
 * Types a rules file in `shared/capsa/abilities.ts` or `shared/capsa/abilities/*.ts`. Every file merges into one
 * set of rules, named by their path: `post: { edit }` is `'post.edit'`.
 *
 * @example
 * export default defineAbilities({
 *   post: { edit: (user, post: { authorId: string }) => user.id === post.authorId || 'NOT_THE_AUTHOR' },
 * })
 */
export function defineAbilities<const R extends Rules>(rules: R): R {
  return rules
}

/**
 * Opens a rule to guests: `user` is null for them. Any other rule turns a guest away before it runs.
 *
 * @example
 * view: guest((user, post: { published: boolean }) => post.published || deny('NOT_FOUND', { status: 404 }))
 */
export function guest<A extends unknown[], V extends Verdict>(rule: (user: AuthUser | null, ...args: A) => V) {
  const open = (user: AuthUser | null, ...args: A) => rule(user, ...args)

  // A new function, so the same rule stays closed where it is used without guest(). Its length is the rule's, which <Can> reads.
  return Object.defineProperties(open, { guest: { value: true }, length: { value: rule.length } }) as typeof open & { readonly guest: true }
}

/** The rules of the app, from its rules files. */
type Abilities = Generated<'abilities', Record<never, never>>

/**
 * Every rule's name, a group's ones as `'group.name'`.
 *
 * @example
 * Paths<{ post: { edit: Rule } }>  // 'post.edit'
 */
type Paths<R, P extends string = ''> = {
  [K in keyof R & string]: R[K] extends (...args: never[]) => unknown ? `${P}${K}` : Paths<R[K], `${P}${K}.`>
}[keyof R & string]

/** The rule at a name. */
type At<R, N extends string> = N extends `${infer H}.${infer T}` ? H extends keyof R ? At<R[H], T> : never : N extends keyof R ? R[N] : never

/** The name of a rule, from the app's rules files. */
export type AbilityName = Paths<Abilities>

/** The rule a name stands for. */
export type AbilityOf<N extends string> = At<Abilities, N>

/** What a rule takes after the user. */
export type AbilityArgs<N extends string> = AbilityOf<N> extends (user: never, ...args: infer A) => unknown ? A : never

/** A check written in place of a rule's name, synchronous like every rule. */
export type InlineRule = (user: AuthUser) => Verdict

/** What `can`, `cannot`, `authorize` and `requireSession` check: a rule's name, or a rule written in place. */
export type AbilityCheck = AbilityName | InlineRule

/**
 * What follows a check: the arguments of the named rule, nothing after a rule written in place. Any arguments
 * past a name that is not a rule, so that the error points at the name.
 *
 * @example
 * AbilityCheckArgs<'org.transfer'>  // [from: string, to: string]
 */
export type AbilityCheckArgs<C> = [C] extends [AbilityName] ? AbilityArgs<C> : [C] extends [InlineRule] ? [] : unknown[]

/** A rule's answer as a refusal: its code and the details for its message. */
type Refusal<V> = V extends false ? { code: undefined, details: undefined }
  : V extends Denial<infer C, infer D> ? { code: C, details: D }
    : V extends string ? { code: V, details: undefined }
      : never

/**
 * Every way a rule turns the visitor away, as `<Can>` hands it to `#denied`: what the rule returns, plus the guest
 * capsa turns away from a rule that is not for guests.
 *
 * @example
 * AbilityRefusal<'projects.create'>  // { code: 'LIMIT_REACHED', details: { limit: 5 } } | { code: 'SIGNED_OUT', details: undefined }
 */
export type AbilityRefusal<N extends string> = (AbilityOf<N> extends (...args: never[]) => infer V ? Refusal<Exclude<V, true>> : never)
  | { code: 'SIGNED_OUT', details: undefined }

/** Arguments that may still be on their way: undefined until they arrive. */
type Loading<A> = A extends unknown[] ? { [K in keyof A]: A[K] | undefined } : never

/**
 * Whether the visitor may do something: undefined until the session is read, or while an argument is undefined.
 *
 * @example
 * can('post.edit', post)  // true, false, or undefined while unknown
 */
export type Can = <const C extends AbilityCheck>(check: C, ...args: Loading<AbilityCheckArgs<C>>) => boolean | undefined

/**
 * Turns the visitor away from a page when a rule does: shows the error page with the rule's status, and its refusal
 * in the error's `data`. Waits for the session when it is not read yet; an argument still undefined is a 404.
 *
 * @example
 * await authorize('org.manageProjects', member.value)
 */
export type Authorize = <const C extends AbilityCheck>(check: C, ...args: Loading<AbilityCheckArgs<C>>) => Promise<void>

/** The better-auth instance, typed from the server config. What capsa relies on when nothing is generated yet. */
export type AuthInstance = Generated<'auth', {
  handler: (request: Request) => Promise<Response>
  api: { getSession: (context: { headers: Headers, returnHeaders: true }) => Promise<{ headers: Headers, response: AuthSession | null }> }
}>

/** better-auth's Vue client, typed from the client config. What capsa relies on when nothing is generated yet. */
export type AuthClient = Generated<'client', {
  signOut: () => Promise<unknown>
  getSession: (options?: { fetchOptions?: { onResponse?: (context: { response: Response }) => void } }) => Promise<{ data: AuthSession | null, error: unknown }>
  $store: { atoms: { $sessionSignal?: { listen: (listener: () => void) => void } } }
}>

/** `with` of `<Can>` and `<Cannot>`: nothing for a rule that takes no argument, the value for one, the list for more. Undefined while it loads. */
type WithProp<C extends string> = AbilityArgs<C> extends [] ? { with?: undefined }
  : AbilityArgs<C> extends [infer A] ? { with: A | undefined }
    : { with: { [K in keyof AbilityArgs<C>]: AbilityArgs<C>[K] | undefined } | undefined }

/** The props of `<Can>` and `<Cannot>`: a rule's name, and what it is about. */
export type AbilityProps<C extends string> = { do: C } & WithProp<C>

/** The slots of `<Can>`: the content when the rule lets in, `#denied` with the refusal when not. */
interface CanSlots<C extends string> {
  default?: () => VNode[]
  denied?: (refusal: AbilityRefusal<C>) => VNode[]
}

/** The slot of `<Cannot>`: its content, with the refusal, when the rule turns away. */
interface CannotSlots<C extends string> {
  default?: (refusal: AbilityRefusal<C>) => VNode[]
}

// The shape vue-tsc gives a generic component written in a .vue file: it reads the props and the slots, which both
// follow the rule's name, from `__ctx`.
export type CanComponent = <const C extends AbilityName>(props: AbilityProps<C>) => VNode & { __ctx?: { props: AbilityProps<C>, slots: CanSlots<C> } }
export type CannotComponent = <const C extends AbilityName>(props: AbilityProps<C>) => VNode & { __ctx?: { props: AbilityProps<C>, slots: CannotSlots<C> } }

/**
 * A generated type, or what stands in for it before `nuxt prepare` has run.
 *
 * @example
 * Generated<'session', {}>  // better-auth's `$Infer.Session` once the types exist
 */
type Generated<K extends string, Fallback> = K extends keyof CapsaAuthTypes ? CapsaAuthTypes[K] : Fallback
