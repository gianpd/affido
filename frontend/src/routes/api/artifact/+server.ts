import { downloadSandboxArtifact, SandboxError, sandboxErrorMessage } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/**
 * The artifact download proxy (RFC 0009 D7): session-gated like `/api/chat`,
 * forwards a bounded path to the user's sandbox, streams the body through
 * without buffering, and passes the sandbox's download headers along. Works in
 * both sandbox access modes because it goes through `sandboxUrl`.
 */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });
	const path = event.url.searchParams.get('path') ?? '';
	// Defense in depth: non-empty, bounded, relative. The sandbox re-validates
	// with the same rule its own tree validator enforces.
	if (path === '' || path.length > 240 || path.includes('..') || path.startsWith('/')) {
		return Response.json({ error: 'invalid path' }, { status: 400 });
	}
	try {
		const download = await downloadSandboxArtifact(event, path);
		const headers = new Headers();
		for (const name of ['content-type', 'content-length', 'content-disposition']) {
			const value = download.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		return new Response(download.body, { status: download.status, headers });
	} catch (error) {
		if (error instanceof SandboxError) {
			return Response.json(
				{ error: error.code, message: sandboxErrorMessage(error) },
				{ status: error.status }
			);
		}
		return Response.json({ error: 'download failed' }, { status: 500 });
	}
};
