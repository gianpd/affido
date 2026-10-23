import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { auth } from '#lib/server/auth';
import { safeNext } from '#lib/server/auth-helpers';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, safeNext(url.searchParams.get('next')));
	return {
		next: safeNext(url.searchParams.get('next')),
		// `?reset=done`: the password changed and every session was revoked.
		reset: url.searchParams.get('reset') === 'done'
	};
};

const credentials = async (request: Request) => {
	const form = await request.formData();
	return {
		email: String(form.get('email') ?? '').trim(),
		password: String(form.get('password') ?? ''),
		name: String(form.get('name') ?? '').trim(),
		next: safeNext(String(form.get('next') ?? ''))
	};
};

export const actions: Actions = {
	signIn: async ({ request }) => {
		const { email, password, next } = await credentials(request);
		if (!email || !password)
			return fail(400, { intent: 'signIn', message: 'Email and password are required.' });
		try {
			await auth.api.signInEmail({ body: { email, password } });
		} catch (error) {
			return fail(400, {
				intent: 'signIn',
				message: error instanceof APIError ? error.message : 'Could not sign in.'
			});
		}
		redirect(303, next);
	},

	signUp: async ({ request }) => {
		const { email, password, name, next } = await credentials(request);
		if (!email || !password || !name)
			return fail(400, { intent: 'signUp', message: 'Name, email and password are required.' });
		if (password.length < 8)
			return fail(400, {
				intent: 'signUp',
				message: 'Use at least 8 characters for the password.'
			});
		try {
			await auth.api.signUpEmail({ body: { email, password, name } });
		} catch (error) {
			return fail(400, {
				intent: 'signUp',
				message: error instanceof APIError ? error.message : 'Could not create the account.'
			});
		}
		redirect(303, next);
	}
};
