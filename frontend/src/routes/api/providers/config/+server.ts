import {
	ProviderError,
	putProviderConfig,
	deleteProviderConfig,
	type ProviderConfigInput
} from '#lib/server/providers';
import type { RequestHandler } from './$types';

/**
 * The settings UI's write path (RFC 0012 §12.3): POST stores a key and sets
 * the selection, DELETE clears (and optionally revokes). The API key travels
 * in the request body only: it is never logged, never returned, and the
 * manager answers with the masked view (fingerprints only).
 */
const bad = (error: unknown): Response => {
	if (error instanceof ProviderError) {
		return Response.json(
			{ error: error.code, message: error.message },
			{ status: error.status >= 400 && error.status < 600 ? error.status : 502 }
		);
	}
	return Response.json({ error: 'provider_write_failed' }, { status: 502 });
};

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });
	const body = (await event.request.json().catch(() => ({}))) as Partial<ProviderConfigInput>;
	if (typeof body.provider !== 'string' || typeof body.modelId !== 'string') {
		return Response.json({ error: 'provider and modelId are required' }, { status: 400 });
	}
	const input: ProviderConfigInput = {
		provider: body.provider,
		modelId: body.modelId,
		...(typeof body.apiKey === 'string' && body.apiKey !== '' ? { apiKey: body.apiKey } : {}),
		...(typeof body.baseUrl === 'string' && body.baseUrl !== '' ? { baseUrl: body.baseUrl } : {}),
		...(body.validate === true ? { validate: true } : {})
	};
	try {
		return Response.json(await putProviderConfig(event, input));
	} catch (error) {
		return bad(error);
	}
};

export const DELETE: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });
	const provider = event.url.searchParams.get('provider') ?? undefined;
	const all = event.url.searchParams.get('all') === '1';
	try {
		return Response.json(await deleteProviderConfig(event, { provider, all }));
	} catch (error) {
		return bad(error);
	}
};
