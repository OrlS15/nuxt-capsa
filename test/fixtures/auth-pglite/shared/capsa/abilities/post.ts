import { defineAbilities, deny, guest } from 'nuxt-capsa/auth'

/** The fields of a post the rules read. */
interface PostAccess {
  authorId: string
  published: boolean
}

export default defineAbilities({
  post: {
    view: guest((user, post: PostAccess) => post.published || user?.id === post.authorId || deny('NOT_FOUND', { status: 404 })),
    edit: (user, post: PostAccess) => user.id === post.authorId || 'NOT_THE_AUTHOR',
  },
  projects: {
    create: (_, count: number) => count < 3 || deny('LIMIT_REACHED', { status: 429, details: { limit: 3 } }),
  },
})
