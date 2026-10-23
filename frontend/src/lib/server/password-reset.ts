/**
 * Password-reset link delivery.
 *
 * This stack has no mail transport, so better-auth's `sendResetPassword` hook
 * hands the link here: always to the server log, and, when the caller asks for
 * it, to the page that requested the reset. Inline delivery tells the caller
 * whether an address has an account, so it is an explicit switch, not a
 * default.
 *
 * The link carries a one-hour token; this map only remembers it long enough for
 * the requesting page to render it once.
 */

export const RESET_LINK_TTL_MS = 5 * 60 * 1000;

type PendingLink = { readonly url: string; readonly expiresAt: number };

const pending = new Map<string, PendingLink>();

const key = (email: string) => email.trim().toLowerCase();

const sweep = (now: number) => {
	for (const [email, entry] of pending) if (entry.expiresAt <= now) pending.delete(email);
};

/** Deliver one reset link: log it, and keep it for the page when `inline` is set. */
export const deliverResetLink = (
	email: string,
	url: string,
	options: { inline: boolean; now?: number }
): void => {
	const now = options.now ?? Date.now();
	console.info(`[auth] password reset link for ${key(email)}: ${url}`);
	if (!options.inline) return;
	sweep(now);
	pending.set(key(email), { url, expiresAt: now + RESET_LINK_TTL_MS });
};

/** The link delivered for `email` inside the TTL, if this process still holds it. */
export const pendingResetLink = (email: string, now = Date.now()): string | undefined => {
	const entry = pending.get(key(email));
	if (entry === undefined) return undefined;
	if (entry.expiresAt <= now) {
		pending.delete(key(email));
		return undefined;
	}
	return entry.url;
};
