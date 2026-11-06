---
title: Nuxt Capsa
description: 'Capsa plugs the libraries you install into your Nuxt app: you set them up in nuxt.config.ts and call them from your code.'
navigation: false
seo:
  title: Nuxt Capsa
  description: 'Capsa plugs the libraries you install into your Nuxt app: you set them up in nuxt.config.ts and call them from your code.'
---

::u-page-hero
---
orientation: horizontal
---
  :::code-group{default-value="2"}
  ```ts twoslash [nuxt.config.ts]
  export default defineNuxtConfig({
    modules: ['nuxt-capsa'],
    capsa: {
      db: {
        default: {
          provider: 'drizzle',
          dialect: 'postgresql',
          driver: 'pglite',
        },
      },
    },
  })
  ```

  ```ts twoslash [server/capsa/db/default/schema.ts]
  import { pgTable } from 'drizzle-orm/pg-core'

  export const users = pgTable('users', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
    email: t.text().notNull().unique(),
    createdAt: t.timestamp().defaultNow().notNull(),
  }))
  ```

  ```ts twoslash [server/api/users.ts]
  import { defineEventHandler } from 'nuxt/server'

  export default defineEventHandler(async () => {
    const users = await useCapsaDb().query.users.findMany()
    //    ^?
    return users
  })
  ```
  :::

#title
The missing wiring for [Nuxt]{.text-primary}

#description
Capsa plugs the libraries you install into your Nuxt app: you set them up in `nuxt.config.ts` and call them from your code.

#links
  :::u-button{to="/getting-started/introduction" size="xl" trailing-icon="i-lucide-arrow-right"}
  Get started
  :::
::

::u-page-section
---
orientation: horizontal
reverse: true
ui:
  wrapper: max-lg:order-none
---
  ```ts twoslash [server/api/events.get.ts]
  import { defineEventHandler } from 'nuxt/server'

  export default defineEventHandler(async () => {
    const db = useCapsaDb('analytics')
    const events = await db.query.events.findMany()
    //    ^?
    return events
  })
  ```

#title
One call per database

#description
Every key under `capsa.db` is a database, and `useCapsaDb()` takes its name.

#links
  :::u-button{to="/database/multiple-databases" color="neutral" variant="outline" trailing-icon="i-lucide-arrow-right"}
  Multiple databases
  :::
::

::u-page-section
  ```ts twoslash [server/api/events.get.ts]
  // @errors: 2345
  const db = useCapsaDb('analytic')
  ```

#title
Your editor catches a wrong name

#description
A database name that isn't in `capsa.db`:

#links
  :::u-button{to="/database/multiple-databases#pick-a-database" color="neutral" variant="outline" trailing-icon="i-lucide-arrow-right"}
  Pick a database
  :::
::

::u-page-section
---
orientation: horizontal
---
  ```ts twoslash [server/api/posts.get.ts]
  import { defineEventHandler } from 'nuxt/server'

  export default defineEventHandler(async () => {
    const posts = await useCapsaDb().query.posts.findMany({
    //    ^?
      columns: { title: true },
      with: { author: { columns: { name: true } } },
    })
    return posts
  })
  ```

#title
Related rows in one query

#description
A `relations.ts` next to the schema gives `db.query` its `with`.

#links
  :::u-button{to="/database/drizzle/relations" color="neutral" variant="outline" trailing-icon="i-lucide-arrow-right"}
  Relations
  :::
::

::u-page-section
---
orientation: horizontal
reverse: true
ui:
  wrapper: max-lg:order-none
---
  ```ts twoslash {8} [nuxt.config.ts]
  export default defineNuxtConfig({
    capsa: {
      db: {
        default: {
          provider: 'drizzle',
          dialect: 'postgresql',
          driver: 'pglite',
          migrations: 'onStart',
        },
      },
    },
  })
  ```

#title
Migrations ship inside the server

#description
drizzle-kit writes them, and the server applies them as it starts or when your code asks.

#links
  :::u-button{to="/database/drizzle/migrations" color="neutral" variant="outline" trailing-icon="i-lucide-arrow-right"}
  Migrations
  :::
::

::u-page-section
---
orientation: horizontal
---
  :::code-group{default-value="1"}
  ```ts twoslash [layers/shop/server/capsa/db/default/schema.ts]
  import { pgTable } from 'drizzle-orm/pg-core'

  export const products = pgTable('products', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
    price: t.integer().notNull(),
  }))
  ```

  ```ts twoslash [server/api/products.get.ts]
  import { defineEventHandler } from 'nuxt/server'

  export default defineEventHandler(async () => {
    const products = await useCapsaDb().query.products.findMany()
    //    ^?
    return products
  })
  ```
  :::

#title
Layers add tables

#description
A layer's schema files join the project's database.

#links
  :::u-button{to="/database/drizzle/layers" color="neutral" variant="outline" trailing-icon="i-lucide-arrow-right"}
  Layers
  :::
::

::u-page-section
#title
Each database picks its driver

#description
Every driver reads `NUXT_CAPSA_DB_<NAME>_CONNECTION`, and embedded ones fall back to a store under `.data/`.

#features
  :::u-page-card{to="/database/drizzle/drivers#postgresql" icon="i-simple-icons-postgresql"}
  #title
  PostgreSQL

  #description
  Such as `node-postgres`, `postgres-js`, Neon and PGlite.
  :::

  :::u-page-card{to="/database/drizzle/drivers#mysql" icon="i-simple-icons-mysql"}
  #title
  MySQL

  #description
  Such as `mysql2` and PlanetScale.
  :::

  :::u-page-card{to="/database/drizzle/drivers#sqlite" icon="i-simple-icons-sqlite"}
  #title
  SQLite

  #description
  Such as libSQL, `better-sqlite3`, `node-sqlite` and Cloudflare D1.
  :::

  :::u-page-card{to="/database/drizzle/drivers#cockroachdb-sql-server-and-singlestore" icon="i-simple-icons-cockroachlabs"}
  #title
  CockroachDB

  #description
  With the `cockroach` driver.
  :::

  :::u-page-card{to="/database/drizzle/drivers#cockroachdb-sql-server-and-singlestore" icon="i-simple-icons-microsoftsqlserver"}
  #title
  SQL Server

  #description
  With the `node-mssql` driver.
  :::

  :::u-page-card{to="/database/drizzle/drivers#cockroachdb-sql-server-and-singlestore" icon="i-simple-icons-singlestore"}
  #title
  SingleStore

  #description
  With the `singlestore` driver.
  :::
::

::u-page-c-t-a
---
variant: subtle
---
#title
Add your first database

#description
Install the module and query your first table.

#links
  :::u-button{to="/getting-started/installation" size="lg" trailing-icon="i-lucide-arrow-right"}
  Installation
  :::
::
