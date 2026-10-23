import { readCatalogManifest } from '#lib/server/marketplace';
import { SandboxError, verifySandboxSkill } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/** Re-verify an installed skill against the shipped manifest (R10): the
 * "does my sandbox hold what the catalog says?" button. */
export const POST: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });
	let name = '';
	try {
		const body = (await event.request.json().catch(() => ({}))) as { name?: unknown };
		if (typeof body.name !== 'string')
			return Response.json({ error: 'name is required' }, { status: 400 });
		name = body.name;
		const manifest = await readCatalogManifest(name);
		return Response.json(await verifySandboxSkill(event, name, manifest));
	} catch (error) {
		if (error instanceof SandboxError) {
			return Response.json({ error: error.code, message: error.message }, { status: error.status });
		}
		return Response.json(
			{ error: 'verify failed', message: `verifying "${name}" failed` },
			{ status: 502 }
		);
	}
};
