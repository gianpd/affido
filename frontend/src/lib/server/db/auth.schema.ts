// Better Auth core tables.
//
// Do not run `pnpm auth:schema` without re-applying this file's two deliberate
// deviations: camelCase physical column names (the sandbox manager reads
// "session"."userId" and "expiresAt") and no session/account -> user foreign
// keys (the e2e verifier seeds session rows without a user row).
import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('emailVerified').default(false).notNull(),
	image: text('image'),
	createdAt: timestamp('createdAt').defaultNow().notNull(),
	updatedAt: timestamp('updatedAt')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export const session = pgTable(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: timestamp('expiresAt').notNull(),
		token: text('token').notNull().unique(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
		updatedAt: timestamp('updatedAt')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		ipAddress: text('ipAddress'),
		userAgent: text('userAgent'),
		// No foreign key: the sandbox verifier seeds session rows without a user
		// row, and the manager only reads userId/token/expiresAt.
		userId: text('userId').notNull()
	},
	(table) => [index('session_userId_idx').on(table.userId)]
);

export const account = pgTable(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('accountId').notNull(),
		providerId: text('providerId').notNull(),
		userId: text('userId').notNull(),
		accessToken: text('accessToken'),
		refreshToken: text('refreshToken'),
		idToken: text('idToken'),
		accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
		refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
		scope: text('scope'),
		password: text('password'),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
		updatedAt: timestamp('updatedAt')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [index('account_userId_idx').on(table.userId)]
);

export const verification = pgTable(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: timestamp('expiresAt').notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
		updatedAt: timestamp('updatedAt')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [index('verification_identifier_idx').on(table.identifier)]
);

export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
	accounts: many(account)
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, { fields: [session.userId], references: [user.id] })
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, { fields: [account.userId], references: [user.id] })
}));
