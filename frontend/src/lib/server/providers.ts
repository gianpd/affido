import {
	MANAGER_TOKEN,
	SANDBOX_GATEWAY_URL,
	SANDBOX_MANAGER_URL,
	SANDBOX_REQUEST_TIMEOUT_MS
} from '$app/env/private';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * One place that talks to the sandbox manager's BYOK endpoints (RFC 0012 §5.3),
 * in the same two modes as sandbox.ts:
 *
 * - gateway (default): forward the browser's session cookie to Caddy's
 *   /providers/* route. The manager's browser-path rules apply, so writes carry
 *   an Origin matching the gateway origin (the CSRF wall of §7.14).
 * - trusted caller (`SANDBOX_MANAGER_URL` set): call the manager directly with
 *   `X-Manager-Token` and the authenticated user's id, mirroring POST /resolve.
 *
 * The API key exists only in the browser's POST body and this module's memory
 * on the way through; it is never logged, cached, or written anywhere, and the
 * manager answers with fingerprints only.
 */

export class ProviderError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ProviderError';
		this.status = status;
		this.code = code;
	}
}

export type ProviderCatalogModel = {
	id: string;
	name: string;
	reasoning: boolean;
};

export type ProviderCatalogEntry = {
	id: string;
	name: string;
	baseUrl: string;
	builtin: boolean;
	models: ProviderCatalogModel[];
};

export type ProviderCatalog = {
	version: number;
	providers: ProviderCatalogEntry[];
};

export type StoredProviderKey = {
	provider: string;
	fingerprint: string;
	verified: boolean;
	verifiedAt: string | null;
	baseUrl?: string;
};

export type ProviderConfigView = {
	selection: { provider: string; modelId: string } | null;
	keys: StoredProviderKey[];
	delivery?: string;
};

/** What `PUT /providers/config` accepts; `apiKey` and `baseUrl` are optional (§5.3). */
export type ProviderConfigInput = {
	provider: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	validate?: boolean;
};

const managerHeaders = (): HeadersInit => ({
	'content-type': 'application/json',
	...(MANAGER_TOKEN ? { 'x-manager-token': MANAGER_TOKEN } : {})
});

async function providersFetch<T>(
	event: RequestEvent,
	method: 'GET' | 'PUT' | 'DELETE',
	path: string,
	options: { body?: unknown } = {}
): Promise<T> {
	const userId = event.locals.user?.id;
	if (!userId) throw new ProviderError(401, 'unauthorized', 'sign in first');

	let url: string;
	let headers: HeadersInit;
	let body: string | undefined;
	if (SANDBOX_MANAGER_URL) {
		// Trusted-caller mode: the manager's own network, token + explicit user_id.
		const separator = path.includes('?') ? '&' : '?';
		url = `${SANDBOX_MANAGER_URL.replace(/\/$/, '')}${path}${separator}user_id=${encodeURIComponent(userId)}`;
		headers = managerHeaders();
		if (method === 'PUT') {
			body = JSON.stringify({ ...(options.body as Record<string, unknown>), user_id: userId });
		}
	} else {
		// Gateway mode: Caddy forward_auths the cookie to /whoami; the manager's
		// origin check compares against the origin Caddy served, i.e. the gateway.
		const origin = SANDBOX_GATEWAY_URL.replace(/\/$/, '');
		url = `${origin}${path}`;
		headers = {
			cookie: event.request.headers.get('cookie') ?? '',
			origin
		};
		if (method === 'PUT') {
			headers['content-type'] = 'application/json';
			body = JSON.stringify(options.body);
		}
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers,
			...(body === undefined ? {} : { body }),
			signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ProviderError(
			503,
			'manager_unreachable',
			`sandbox manager is unreachable: ${reason}`
		);
	}

	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const code = typeof payload.error === 'string' ? payload.error : 'provider_error';
		const message =
			typeof payload.message === 'string' ? payload.message : `manager answered ${response.status}`;
		throw new ProviderError(response.status, code, message);
	}
	return payload as T;
}

/** The curated catalog (§5.1): generated from pi-ai inside the agent image. */
export const providerCatalog = (event: RequestEvent): Promise<ProviderCatalog> =>
	providersFetch<ProviderCatalog>(event, 'GET', '/providers/catalog');

/** The masked view (§5.3): selection plus fingerprints, never key material. */
export const providerConfig = (event: RequestEvent): Promise<ProviderConfigView> =>
	providersFetch<ProviderConfigView>(event, 'GET', '/providers/config');

/** Store a key and/or set the selection; the manager returns the masked view. */
export const putProviderConfig = (
	event: RequestEvent,
	input: ProviderConfigInput
): Promise<ProviderConfigView> =>
	providersFetch<ProviderConfigView>(event, 'PUT', '/providers/config', { body: input });

/** Clear the selection; `provider` also revokes that key, `all` drops everything (§7.13). */
export const deleteProviderConfig = (
	event: RequestEvent,
	options: { provider?: string; all?: boolean } = {}
): Promise<ProviderConfigView> => {
	const params = new URLSearchParams();
	if (options.provider !== undefined) params.set('provider', options.provider);
	if (options.all === true) params.set('all', '1');
	const query = params.size > 0 ? `?${params}` : '';
	return providersFetch<ProviderConfigView>(event, 'DELETE', `/providers/config${query}`);
};

/** A user-facing message that never leaks internals. */
export const providerErrorMessage = (error: unknown): string => {
	if (error instanceof ProviderError) {
		if (error.code === 'manager_unreachable') {
			return 'The control plane is not reachable. Start the stack (docker compose up -d) and try again.';
		}
		return error.message;
	}
	return error instanceof Error ? error.message : 'Unexpected provider error';
};
