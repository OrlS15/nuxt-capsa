import type { AuthUser, InlineRule, Rules } from './index'

/** A rule as capsa calls it. `guest` is set on the rules wrapped in guest(). */
type Rule = ((user: AuthUser | null, ...args: unknown[]) => unknown) & { guest?: true }

/** What to check: a rule's name, or a rule written in place, which only ever runs for a signed-in user. */
export type Check = string | InlineRule

/** Why a rule turned the visitor away: the code and details the rule gave, and the HTTP status to answer with. */
export interface Refusal {
  status: number
  code?: string
  details?: unknown
}

/** The refusal of a guest, from a rule that is not for guests or from a handler that needs a session. */
const SIGNED_OUT: Refusal = { status: 401, code: 'SIGNED_OUT' }

/**
 * Merges the rules files into one set of rules. A group may span files, so `{ post: { edit } }` and
 * `{ post: { view } }` become `{ post: { edit, view } }`.
 */
export function mergeAbilities(files: Rules[]): Rules {
  const merged: Rules = {}

  for (const file of files) addRules(merged, file, '')

  return merged
}

/** Adds a file's rules to the merged ones, group by group. A name defined twice stops the app. */
function addRules(merged: Rules, rules: Rules, group: string) {
  for (const [name, rule] of Object.entries(rules)) {
    const path = group + name

    if (name.includes('.'))
      throw new Error(`[capsa] ability "${path}": a name cannot hold a dot, which separates groups.`)

    const existing = merged[name]
    const bothGroups = typeof existing === 'object' && typeof rule === 'object'

    if (existing && !bothGroups)
      throw new Error(`[capsa] ability "${path}" is defined in more than one place.`)

    if (typeof rule === 'function') merged[name] = rule
    else addRules((merged[name] ??= {}) as Rules, rule, `${path}.`)
  }
}

/**
 * Asks a rule about a user: null when it lets them in, else the refusal. Without a rule it only asks for a signed-in
 * user. A rule that throws throws here too.
 *
 * @example
 * judge(rules, user, 'post.edit', [post])  // null, or { status: 403, code: 'NOT_THE_AUTHOR' }
 */
export function judge(rules: Rules, user: AuthUser | null, check: Check | undefined, args: unknown[]): Refusal | null {
  if (check === undefined) return user ? null : SIGNED_OUT

  const rule = typeof check === 'string' ? ruleAt(rules, check) : check as Rule

  // A guest never reaches a rule that is not for guests.
  if (!user && !rule.guest) return SIGNED_OUT

  return toRefusal(rule(user, ...args))
}

/** Finds the rule a name stands for: `'post.edit'` is `rules.post.edit`. */
export function ruleAt(rules: Rules, name: string): Rule {
  let found: unknown = rules

  for (const key of name.split('.')) found = (found as Rules | undefined)?.[key]

  if (typeof found !== 'function') throw new Error(`[capsa] there is no ability named "${name}".`)

  return found as Rule
}

/**
 * Turns `<Can :with>` into the rule's arguments, by how many the rule takes besides the user: none, `[with]` for
 * one, and `with` itself, a list, for more.
 *
 * @example
 * argsOf(rules, 'post.edit', post)           // [post]
 * argsOf(rules, 'org.transfer', [from, to])  // [from, to]
 */
export function argsOf(rules: Rules, name: string, value: unknown): unknown[] {
  const count = ruleAt(rules, name).length - 1

  if (count === 0) return []
  if (count === 1) return [value]

  // A list still on its way counts as an unknown argument.
  return Array.isArray(value) ? value : [undefined]
}

/**
 * Turns a rule's answer into a refusal: none for `true`, the code for a string, deny()'s fields for a denial, and
 * a plain 403 for anything else, a promise from a rule that broke the synchronous contract included.
 */
function toRefusal(answer: unknown): Refusal | null {
  if (answer === true) return null
  if (typeof answer === 'string') return { status: 403, code: answer }
  if (isDenial(answer)) return { status: answer.status, code: answer.code, details: answer.details }

  return { status: 403 }
}

/** Whether a value was made by deny(), which marks it with a registered symbol the server and client share. */
function isDenial(value: unknown): value is Required<Refusal> {
  return typeof value === 'object' && value !== null && Symbol.for('capsa.denial') in value
}

/**
 * What a refusal shows the page and the caller: its code and details. The status travels as the HTTP status.
 *
 * @example
 * shown({ status: 429, code: 'LIMIT_REACHED', details: { limit: 3 } })  // { code: 'LIMIT_REACHED', details: { limit: 3 } }
 */
export function shown({ code, details }: Refusal) {
  return { code, details }
}
