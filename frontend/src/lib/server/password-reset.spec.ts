import { describe, expect, it, vi } from 'vitest';
import { deliverResetLink, pendingResetLink, RESET_LINK_TTL_MS } from '#lib/server/password-reset';

const url = 'http://localhost:5173/api/auth/reset-password/abc?callbackURL=%2Flogin%2Freset';

describe('password reset link delivery', () => {
	it('keeps the link only when inline delivery is on', () => {
		const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);

		deliverResetLink('off@example.com', url, { inline: false });
		expect(pendingResetLink('off@example.com')).toBeUndefined();

		deliverResetLink('on@example.com', url, { inline: true });
		expect(pendingResetLink('on@example.com')).toBe(url);

		expect(log).toHaveBeenCalledTimes(2);
		log.mockRestore();
	});

	it('matches the email case-insensitively and trims it', () => {
		deliverResetLink('  Mixed@Example.com ', url, { inline: true });
		expect(pendingResetLink('mixed@example.com')).toBe(url);
	});

	it('forgets a link after the TTL', () => {
		deliverResetLink('old@example.com', url, { inline: true, now: 1_000 });
		expect(pendingResetLink('old@example.com', 1_000 + RESET_LINK_TTL_MS - 1)).toBe(url);
		expect(pendingResetLink('old@example.com', 1_000 + RESET_LINK_TTL_MS)).toBeUndefined();
	});

	it('returns nothing for an address that never asked', () => {
		expect(pendingResetLink('never@example.com')).toBeUndefined();
	});
});
