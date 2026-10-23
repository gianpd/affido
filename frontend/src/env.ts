import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: { description: 'The database connection string.' },
	ORIGIN: {
		description: 'The app origin (base URL), e.g. `http://localhost:5173`.'
	},
	BETTER_AUTH_SECRET: {
		description:
			'Secret used to sign tokens. For production use 32 characters generated with high entropy. See [Better Auth installation](https://www.better-auth.com/docs/installation).'
	},
	SANDBOX_GATEWAY_URL: {
		description:
			'Caddy gateway that fronts the per-user sandboxes at `/u/<user_id>/*`. Used when `SANDBOX_MANAGER_URL` is unset.',
		schema: (value) => value || 'http://localhost:18080'
	},
	SANDBOX_MANAGER_URL: {
		description:
			'Trusted-caller endpoint of the sandbox manager. When set, the web app resolves the user sandbox directly instead of going through Caddy.',
		schema: (value) => value ?? ''
	},
	MANAGER_TOKEN: {
		description: 'Shared secret sent as `X-Manager-Token` to the sandbox manager.',
		schema: (value) => value ?? ''
	},
	SANDBOX_REQUEST_TIMEOUT_MS: {
		description: 'Upper bound for one request to a sandbox (a prompt can run tools).',
		schema: (value) => Number(value ?? 180_000)
	},
	RESET_PASSWORD_LINK_INLINE: {
		description:
			'Show the password-reset link on the forgot-password page instead of only logging it. There is no mail transport on this stack, so this is how a local user recovers an account; it also reveals which addresses have an account, so keep it off in a deployment.',
		schema: (value) => value === 'true'
	}
});
