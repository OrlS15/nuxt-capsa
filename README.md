# nuxt-capsa

**The missing wiring for Nuxt.** Database, auth and file storage, ready for production, with almost no config.

> [!WARNING]
> **Not published yet.** Capsa is an experiment: it isn't on npm, it runs on Nuxt 5 nightly, and every API below may still change. Don't use it in production.

Capsa doesn't replace the libraries you know. You install [Drizzle](https://orm.drizzle.team), [better-auth](https://better-auth.com) and [files-sdk](https://files-sdk.dev) yourself. You turn a feature on in `nuxt.config.ts` and write your files in the folders Capsa expects. Capsa generates the code that wires them into Nuxt:

- typed auto-imports for server and app code
- connections and secrets from environment variables
- migrations shipped inside the server bundle
- route protection, with permission rules shared by server and app
- signed links for local files

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-capsa'],
  capsa: {
    db: { default: { provider: 'drizzle', dialect: 'postgresql', driver: 'pglite', migrations: 'onStart' } },
    auth: { routes: { '/dashboard/**': 'user', '/login': 'guest' } },
    drive: { default: { adapter: 'fs' } },
  },
})
```

That's the whole config. Everything else is a file in a known place:

```bash
server/capsa/
├── db/default/
│   ├── schema/users.ts      # Drizzle tables
│   ├── relations.ts         # optional
│   ├── config.ts            # optional: drizzle() and drizzle-kit options
│   └── migrations/          # written by drizzle-kit
├── auth/config.ts           # better-auth options
└── drive/default/config.ts  # optional: adapter options, files-sdk plugins
shared/capsa/abilities.ts    # permission rules, for server and app
```

---

## Database

One key per database. Tables go in its folder, and you query it with `useCapsaDb()`.

```ts
// server/capsa/db/default/schema/users.ts
import { pgTable } from 'drizzle-orm/pg-core'

export const users = pgTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
}))
```

```ts
// server/api/users.get.ts
import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(() => useCapsaDb().query.users.findMany())
//                                      ^? auto-imported, typed from your schema
```

**Relations**: one file next to the schema, and `with` works in queries.

```ts
// server/capsa/db/default/relations.ts
import { defineRelationsPart } from 'drizzle-orm'
import * as schema from '#capsa/db/default/schema'

export default defineRelationsPart(schema, r => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
}))
```

**Migrations**: drizzle-kit writes them with the config Capsa generates. With `migrations: 'onStart'` the server applies them as it boots, and requests wait until they're done. A database lock means several instances starting together apply them only once.

```bash
npx drizzle-kit generate --config .nuxt/capsa/db/default/drizzle.config.ts
```

**Connections**: from the environment, never from `nuxt.config.ts`. Local drivers such as `pglite` and `node-sqlite` work with no variable at all, keeping their data in `.data/capsa/db/`.

```bash
NUXT_CAPSA_DB_DEFAULT_CONNECTION=postgres://app:secret@db.internal:5432/app
NUXT_CAPSA_DB_DEFAULT_REPLICAS='["postgres://replica-1.internal:5432/app"]'   # reads go to db.$replica
```

**More databases**: add a key. Each one has its own folder, dialect, driver, connection and migrations.

```ts
db: {
  default: { provider: 'drizzle', dialect: 'postgresql', driver: 'node-postgres' },
  analytics: { provider: 'drizzle', dialect: 'sqlite', driver: 'libsql' },
}
```

```ts
import { events } from '#capsa/db/analytics/schema'

const rows = await useCapsaDb('analytics').select().from(events)
useCapsaDb('analytic') // type error: '"default" | "analytics"'
```

**Layers**: a Nuxt layer adds tables by putting schema files in the same folder path, and the project queries them like its own.

Supported: every Drizzle dialect (PostgreSQL, MySQL, SQLite, CockroachDB, MSSQL, SingleStore) and 32 drivers, from `node-postgres` to `d1`, `neon-http` and `libsql`.

---

## Auth

better-auth, already mounted on `/api/auth`, with its secret derived from `NUXT_APP_SECRET`.

```ts
// server/capsa/auth/config.ts
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { defineServerAuthConfig } from 'nuxt-capsa/auth'
import { useCapsaDb } from '#capsa/db'

export default defineServerAuthConfig(() => ({
  database: drizzleAdapter(useCapsaDb(), { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  user: { additionalFields: { plan: { type: ['free', 'pro'], required: false, defaultValue: 'free' } } },
}))
```

**Pages**: protect them from `nuxt.config.ts`, with no middleware to write.

```ts
auth: {
  routes: { '/dashboard/**': 'user', '/login': 'guest' },  // signed in only, signed out only
  redirects: { user: '/login', guest: '/dashboard' },
}
```

**Rules**: write them once, in `shared/`. Server and app both use them, typed by name and arguments.

```ts
// shared/capsa/abilities.ts
import { defineAbilities, deny, guest } from 'nuxt-capsa/auth'

export default defineAbilities({
  schedule: user => user.plan === 'pro' || 'PRO_REQUIRED',
  posts: {
    view: guest((user, post: Post) => post.published || user?.id === post.authorId || deny('NOT_FOUND', { status: 404 })),
    edit: (user, post: Post) => user.id === post.authorId || 'NOT_THE_AUTHOR',
  },
})
```

**On the server**: one call gives you the session or refuses the request with a 401, a 403 or the rule's own status.

```ts
// server/api/posts/[id].put.ts
import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { requireSession } from '#capsa/auth'

export default defineEventHandler(async (event) => {
  const post = await findPost(getRouterParam(event, 'id'))
  const { user } = await requireSession(event, 'posts.edit', post)
  //                                           ^? autocompletes rule names, checks `post`'s type
  // …
})
```

**In the app**: the session, better-auth's client, and the same rules.

```vue
<script setup lang="ts">
const { user, loggedIn, client, signOut, can } = useCapsaSession()
</script>

<template>
  <Can do="posts.edit" :with="post">
    <button>Edit</button>
    <template #denied="{ code }">You can't edit this: {{ code }}</template>
  </Can>
</template>
```

The session is read only on pages that use it, once per request during SSR, and is refreshed after sign-in and sign-out.

---

## Drive

File storage on any [files-sdk](https://files-sdk.dev) adapter: a local folder in development and S3, R2 or Vercel Blob in production, without changing code.

```ts
drive: {
  default: { adapter: 'fs' },
  avatars: { adapter: 's3-fetch' },
}
```

```bash
# one variable per adapter option: NUXT_CAPSA_DRIVE_<DISK>_<OPTION>
NUXT_CAPSA_DRIVE_AVATARS_BUCKET=avatars
NUXT_CAPSA_DRIVE_AVATARS_ENDPOINT=https://s3.eu-central-1.amazonaws.com
NUXT_CAPSA_DRIVE_AVATARS_ACCESS_KEY_ID=…
NUXT_CAPSA_DRIVE_AVATARS_SECRET_ACCESS_KEY=…
```

**Upload and links**: `useCapsaDrive()` is files-sdk's own `Files`, typed by the disk's adapter.

```ts
// server/api/avatars/[id].put.ts
import { defineEventHandler, getRouterParam } from 'nuxt/server'

export default defineEventHandler(async (event) => {
  const file = (await event.req.formData()).get('file') as File
  return useCapsaDrive('avatars').upload(`users/${getRouterParam(event, 'id')}.png`, file)
})
```

```ts
useCapsaDrive().url('invoices/42.pdf', { expiresIn: 600 })                    // signed download link
useCapsaDrive().signedUploadUrl('a.png', { expiresIn: 60, contentType: 'image/png' })  // browser uploads directly
```

**Serving files**: `serve` turns a route into the file's permanent address. It either redirects to a fresh signed link, or streams the file through your server with support for range requests, so video players can seek.

```ts
// server/api/videos/[id].get.ts
import { defineEventHandler, getRouterParam } from 'nuxt/server'

export default defineEventHandler(event =>
  useCapsaDrive().serve(event, `videos/${getRouterParam(event, 'id')}.mp4`, { mode: 'proxy' }))
```

**Local disks work like a bucket**: files-sdk's `fs` adapter can't make links, so Capsa signs them itself and answers them on its own route. `url()`, `signedUploadUrl()` and `serve()` behave the same in development and on S3.

**Plugins**: files-sdk plugins go in the disk's `config.ts`, and the methods they add are typed on the disk.

```ts
// server/capsa/drive/default/config.ts
import { usage } from 'files-sdk/usage'
import { defineDriveConfig } from 'nuxt-capsa/drive'

export default defineDriveConfig('default', { plugins: [usage()] })
// useCapsaDrive().usage() is now typed
```

---

## Environment variables

| Variable | What |
|---|---|
| `NUXT_CAPSA_DB_<NAME>_CONNECTION` | a database's connection (optional for local drivers) |
| `NUXT_CAPSA_DB_<NAME>_REPLICAS` | JSON array of read replicas |
| `NUXT_CAPSA_DRIVE_<DISK>_<OPTION>` | one option of a disk's adapter |
| `NUXT_APP_SECRET` | signs the auth cookies and the links of `fs` disks (32+ characters) |

## Your libraries, your versions

Capsa never bundles Drizzle, better-auth or files-sdk. The code it generates imports the copies installed in your project. Each library is an optional peer dependency with a tested version range, and Capsa warns on every build when an installed version falls outside that range.

## Try it

```bash
git clone <this repo> && cd nuxt-capsa
pnpm install
pnpm dev     # the playground: a database, auth with rules, a login page
pnpm test    # ~230 tests in ~8 s, with no database server or browser
```

## Roadmap

- [x] Database (Drizzle)
- [x] Auth (better-auth)
- [x] Drive (files-sdk)
- [ ] Mailer
- [ ] Queue
- [ ] Runtime config with schema validation

## License

MIT
