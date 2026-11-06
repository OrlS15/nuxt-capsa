import { defineAbilities, deny, guest } from 'nuxt-capsa/auth'

/** The fields of a note the rules read. */
interface NoteAccess {
  authorId: string
  published: boolean
}

export default defineAbilities({
  notes: {
    // Anyone reads a published note; a draft exists only for its author.
    view: guest((user, note: NoteAccess) => note.published || user?.id === note.authorId || deny('NOT_FOUND', { status: 404 })),
    edit: (user, note: NoteAccess) => user.id === note.authorId || 'NOT_THE_AUTHOR',
    // Free users keep three notes, Pro users as many as they like.
    create: (user, count: number) => user.plan === 'pro' || count < 3 || deny('LIMIT_REACHED', { status: 429, details: { limit: 3 } }),
  },
})
