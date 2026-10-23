import { redirect } from '@sveltejs/kit';

/** Only allow same-origin relative paths in `?next=` to avoid an open redirect. */
export function safeNext(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dashboard';
	return value;
}

export function requireUser(locals: App.Locals, currentUrl?: URL): NonNullable<App.Locals['user']> {
	if (!locals.user) {
		const next = currentUrl
			? `?next=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}`
			: '';
		redirect(303, `/login${next}`);
	}
	return locals.user;
}
