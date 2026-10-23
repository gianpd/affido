import { fail } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { ORIGIN } from '$app/env/private';
import { auth } from '#lib/server/auth';
import { pendingResetLink } from '#lib/server/password-reset';
import type { Actions } from './$types';

export const actions: Actions = {
	request: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		if (!email) return fail(400, { email, message: 'Email is required.' });

		try {
			await auth.api.requestPasswordReset({
				body: { email, redirectTo: `${ORIGIN}/login/reset` }
			});
		} catch (error) {
			return fail(400, {
				email,
				message: error instanceof APIError ? error.message : 'Could not start the reset.'
			});
		}

		// The same answer for every address: the form must not reveal who exists.
		// `link` is filled only when inline delivery is on.
		return { email, sent: true, link: pendingResetLink(email) ?? null };
	}
};
