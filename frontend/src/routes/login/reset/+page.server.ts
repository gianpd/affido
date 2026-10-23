import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { auth } from '#lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/** `error=INVALID_TOKEN` is what better-auth's callback appends for a spent link. */
export const load: PageServerLoad = ({ url }) => ({
	token: url.searchParams.get('token') ?? '',
	expired: url.searchParams.get('error') === 'INVALID_TOKEN'
});

const friendly = (error: unknown): string => {
	if (!(error instanceof APIError)) return 'Could not reset the password.';
	const code = (error.body as { code?: string } | undefined)?.code;
	if (code === 'INVALID_TOKEN') return 'This reset link is invalid or already used.';
	if (code === 'USER_NOT_FOUND') return 'That account no longer exists.';
	if (code === 'PASSWORD_TOO_SHORT') return 'Use at least 8 characters for the password.';
	return error.message;
};

export const actions: Actions = {
	reset: async ({ request }) => {
		const form = await request.formData();
		const token = String(form.get('token') ?? '');
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');

		if (!token)
			return fail(400, { token, message: 'This link carries no token. Request a new one.' });
		if (password.length < 8)
			return fail(400, { token, message: 'Use at least 8 characters for the password.' });
		if (password !== confirm)
			return fail(400, { token, message: 'The two passwords do not match.' });

		try {
			await auth.api.resetPassword({ body: { newPassword: password, token } });
		} catch (error) {
			return fail(400, { token, message: friendly(error) });
		}

		// Sessions were revoked with the password change: sign in again.
		redirect(303, '/login?reset=done');
	}
};
