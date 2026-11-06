import { index, pgTable } from 'drizzle-orm/pg-core'

// better-auth finds each table by its export name: user, session, account, verification. The table names are
// prefixed, so they never meet the playground's own `users`.
export const user = pgTable('auth_users', t => ({
  id: t.text().primaryKey(),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
  emailVerified: t.boolean().default(false).notNull(),
  image: t.text(),
  plan: t.text({ enum: ['free', 'pro'] }).default('free'),
  createdAt: t.timestamp().defaultNow().notNull(),
  updatedAt: t.timestamp().defaultNow().$onUpdate(() => new Date()).notNull(),
}))

export const session = pgTable('auth_sessions', t => ({
  id: t.text().primaryKey(),
  expiresAt: t.timestamp().notNull(),
  token: t.text().notNull().unique(),
  createdAt: t.timestamp().defaultNow().notNull(),
  updatedAt: t.timestamp().$onUpdate(() => new Date()).notNull(),
  ipAddress: t.text(),
  userAgent: t.text(),
  userId: t.text().notNull().references(() => user.id, { onDelete: 'cascade' }),
}), table => [index().on(table.userId)])

export const account = pgTable('auth_accounts', t => ({
  id: t.text().primaryKey(),
  accountId: t.text().notNull(),
  providerId: t.text().notNull(),
  userId: t.text().notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: t.text(),
  refreshToken: t.text(),
  idToken: t.text(),
  accessTokenExpiresAt: t.timestamp(),
  refreshTokenExpiresAt: t.timestamp(),
  scope: t.text(),
  password: t.text(),
  createdAt: t.timestamp().defaultNow().notNull(),
  updatedAt: t.timestamp().$onUpdate(() => new Date()).notNull(),
}), table => [index().on(table.userId)])

export const verification = pgTable('auth_verifications', t => ({
  id: t.text().primaryKey(),
  identifier: t.text().notNull(),
  value: t.text().notNull(),
  expiresAt: t.timestamp().notNull(),
  createdAt: t.timestamp().defaultNow().notNull(),
  updatedAt: t.timestamp().defaultNow().$onUpdate(() => new Date()).notNull(),
}), table => [index().on(table.identifier)])
