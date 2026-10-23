import { ORIGIN, BETTER_AUTH_SECRET, RESET_PASSWORD_LINK_INLINE } from '$app/env/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '#lib/server/db/index.ts';
import { deliverResetLink } from '#lib/server/password-reset.ts';

export const auth = betterAuth({
	baseURL: ORIGIN,
	secret: BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg' }),
	emailAndPassword: {
		enabled: true,
		// One hour: on this stack the link reaches a human by hand, not by mail.
		resetPasswordTokenExpiresIn: 60 * 60,
		// A reset is a recovery: whoever resets signs in again everywhere.
		revokeSessionsOnPasswordReset: true,
		sendResetPassword: async ({ user, url }) => {
			deliverResetLink(user.email, url, { inline: RESET_PASSWORD_LINK_INLINE });
		}
	},
	plugins: [
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
