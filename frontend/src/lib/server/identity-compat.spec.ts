// RFC 0023 §4 and §9: an account the manager creates (scrypt hash, signed
// cookie) must sign in and resolve through better-auth itself. These are the
// exact functions better-auth uses in production; the memory adapter keeps the
// test offline and database-free.
import { describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature, verifyPassword } from 'better-auth/crypto';

const GOLDEN_SECRET = 'test-secret-0123456789abcdef';
const AUTH_SECRET = 'test-secret-0123456789abcdef-32';
const TOKEN = 'TOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMAIL = 'elena@example.com';
const PASSWORD = 'correct horse battery staple';
const GOLDEN_HASH =
	'00112233445566778899aabbccddeeff:' +
	'f5b22309b28fe412c82a4b2cab57498b8f8a42c849af16cb908974048f61c139' +
	'33421858db3a8f111430bdc493c7cef90f61f904061c77206e3820a2e8b11bc2';
const GOLDEN_COOKIE =
	'better-auth.session_token=TOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa.' +
	'Xq2d1kPZRjP0gBzmdZjnv64vU89%2F1WahS6ao%2FekCtfU%3D';

const now = new Date();
const db = {
	user: [
		{
			id: 'u1',
			name: 'Elena',
			email: EMAIL,
			emailVerified: false,
			image: null,
			createdAt: now,
			updatedAt: now
		}
	],
	account: [
		{
			id: 'a1',
			accountId: 'u1',
			providerId: 'credential',
			userId: 'u1',
			password: GOLDEN_HASH,
			createdAt: now,
			updatedAt: now
		}
	],
	session: [
		{
			id: 's1',
			token: TOKEN,
			userId: 'u1',
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			ipAddress: '',
			userAgent: '',
			createdAt: now,
			updatedAt: now
		}
	],
	verification: []
};

const auth = betterAuth({
	baseURL: 'http://localhost:5174',
	secret: AUTH_SECRET,
	database: memoryAdapter(db),
	emailAndPassword: { enabled: true },
	telemetry: { enabled: false }
});

describe('manager identity surface compatibility with better-auth', () => {
	it('verifies the manager golden scrypt hash', async () => {
		expect(await verifyPassword({ hash: GOLDEN_HASH, password: PASSWORD })).toBe(true);
		expect(await verifyPassword({ hash: GOLDEN_HASH, password: 'wrong' })).toBe(false);
	});

	it('builds the manager golden signed cookie byte for byte', async () => {
		const signature = await makeSignature(TOKEN, GOLDEN_SECRET);
		const cookie = `better-auth.session_token=${encodeURIComponent(`${TOKEN}.${signature}`)}`;
		expect(cookie).toBe(GOLDEN_COOKIE);
	});

	it('signs in with the manager-created credential row', async () => {
		const result = await auth.api.signInEmail({
			body: { email: EMAIL, password: PASSWORD }
		});
		expect(result.token).toBeTruthy();
		expect(result.user.email).toBe(EMAIL);
		await expect(
			auth.api.signInEmail({ body: { email: EMAIL, password: 'wrong password' } })
		).rejects.toBeDefined();
	});

	it('resolves the manager-sealed session cookie', async () => {
		const signature = await makeSignature(TOKEN, AUTH_SECRET);
		const cookie = `better-auth.session_token=${encodeURIComponent(`${TOKEN}.${signature}`)}`;
		const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
		expect(session?.user.email).toBe(EMAIL);
	});
});
