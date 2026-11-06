import { describe, expect, it } from 'vitest'
import { deny, guest } from '../../src/runtime/auth'
import type { AuthUser, Rules } from '../../src/runtime/auth'
import { argsOf, judge, mergeAbilities } from '../../src/runtime/auth/rules'

const ada = { id: 'ada', plan: 'free' } as AuthUser
const post = { authorId: 'ada', published: false }

const rules = mergeAbilities([
  { schedule: (user: AuthUser) => user.plan === 'pro' || 'PRO_REQUIRED' },
  {
    post: {
      view: guest((user, p: typeof post) => p.published || user?.id === p.authorId || deny('NOT_FOUND', { status: 404 })),
      edit: (user: AuthUser, p: typeof post) => user.id === p.authorId,
    },
  },
  { post: { remove: () => false }, projects: { create: (_: AuthUser, count: number) => count < 3 || deny('LIMIT_REACHED', { status: 429, details: { limit: 3 } }) } },
  { org: { transfer: (_: AuthUser, from: string, to: string) => from !== to }, broken: () => { throw new Error('db down') } },
] as Rules[])

describe('rules', () => {
  it('merges every file into one set, groups included, and stops on a name defined twice or holding a dot', () => {
    expect(Object.keys(rules.post!)).toEqual(['view', 'edit', 'remove'])
    expect(() => mergeAbilities([{ post: { edit: () => true } }, { post: { edit: () => true } }])).toThrow('[capsa] ability "post.edit" is defined in more than one place.')
    expect(() => mergeAbilities([{ post: () => true }, { post: { edit: () => true } }])).toThrow('"post" is defined in more than one place')
    expect(() => mergeAbilities([{ 'post.edit': () => true }])).toThrow('a name cannot hold a dot')
  })

  it('lets in only on true, and turns away with false, a code, or deny() with its status and details', async () => {
    expect(await judge(rules, ada, 'post.edit', [post])).toBeNull()
    expect(await judge(rules, ada, 'post.remove', [])).toEqual({ code: undefined, status: 403, details: undefined })
    expect(await judge(rules, ada, 'schedule', [])).toEqual({ code: 'PRO_REQUIRED', status: 403, details: undefined })
    expect(await judge(rules, ada, 'projects.create', [5])).toEqual({ code: 'LIMIT_REACHED', status: 429, details: { limit: 3 } })
    expect(await judge(rules, ada, () => 'true', [])).toEqual({ code: 'true', status: 403, details: undefined })
  })

  it('turns a guest away before a rule that is not for guests runs, and runs a guest rule with no user', async () => {
    expect(await judge(rules, null, undefined, [])).toEqual({ code: 'SIGNED_OUT', status: 401, details: undefined })
    expect(await judge(rules, ada, undefined, [])).toBeNull()
    expect(await judge(rules, null, 'broken', [])).toEqual({ code: 'SIGNED_OUT', status: 401, details: undefined })
    expect(await judge(rules, null, () => true, [])).toEqual({ code: 'SIGNED_OUT', status: 401, details: undefined })
    expect(await judge(rules, null, 'post.view', [post])).toEqual({ code: 'NOT_FOUND', status: 404, details: undefined })
    expect(await judge(rules, null, 'post.view', [{ ...post, published: true }])).toBeNull()
  })

  it('never lets in when a rule throws, or when a name is not a rule', () => {
    expect(() => judge(rules, ada, 'broken', [])).toThrow('db down')
    expect(() => judge(rules, ada, 'post', [])).toThrow('[capsa] there is no ability named "post".')
  })

  it('answers right away, and turns away a rule that returns a promise anyway', () => {
    expect(judge(rules, ada, 'post.edit', [post])).toBeNull()
    expect(judge(rules, ada, 'schedule', [])).toEqual({ status: 403, code: 'PRO_REQUIRED' })
    // Past the types, from plain JavaScript: a promise is not `true`.
    expect(judge(rules, ada, (async () => true) as never, [])).toEqual({ status: 403 })
  })

  it('reads <Can :with> by the rule\'s arity: nothing, the value, or the list', () => {
    expect(argsOf(rules, 'schedule', undefined)).toEqual([])
    expect(argsOf(rules, 'post.edit', post)).toEqual([post])
    // guest() keeps the length of the rule it wraps.
    expect(argsOf(rules, 'post.view', post)).toEqual([post])
    expect(argsOf(rules, 'org.transfer', ['a', 'b'])).toEqual(['a', 'b'])
    expect(argsOf(rules, 'org.transfer', undefined)).toEqual([undefined])
  })

  it('opens a copy of the rule to guests, and leaves the rule itself closed', async () => {
    const own = (user: AuthUser | null) => !!user
    const open = mergeAbilities([{ open: guest(own), closed: own }] as Rules[])

    expect(await judge(open, null, 'open', [])).toEqual({ code: undefined, status: 403, details: undefined })
    expect(await judge(open, null, 'closed', [])).toEqual({ code: 'SIGNED_OUT', status: 401, details: undefined })
  })
})
