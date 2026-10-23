import { readCatalogFile, readCatalogManifest } from '#lib/server/marketplace';
import { installSandboxSkill, SandboxError, verifySandboxSkill } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/**
 * The install loop (RFC 0009 D2/D7): for every manifest file, stream the
 * bundle bytes into the sandbox at `skills/<name>/<path>`, then verify the
 * installed tree against the manifest. Idempotent by path: a retry rewrites
 * the same files, and the verdict reports reality.
 */
export const POST: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });
	let name = '';
	try {
		const body = (await event.request.json().catch(() => ({}))) as { name?: unknown };
		if (typeof body.name !== 'string')
			return Response.json({ error: 'name is required' }, { status: 400 });
		name = body.name;
		const manifest = await readCatalogManifest(name);
		const installed: { path: string; bytes: number; sha256: string }[] = [];
		// Sequential on purpose: peak memory is one file, and a failure names the
		// path that broke. What already landed stays; retrying rewrites it.
		for (const file of manifest.files) {
			const bytes = await readCatalogFile(name, file.path);
			installed.push(await installSandboxSkill(event, { name, path: file.path, bytes }));
		}
		// The manifest itself is installed like any other file (RFC 0009 §5.3), so
		// `GET /skills` can report the version from the sandbox's own copy.
		installed.push(
			await installSandboxSkill(event, {
				name,
				path: 'marketplace.json',
				bytes: await readCatalogFile(name, 'marketplace.json')
			})
		);
		const verify = await verifySandboxSkill(event, name, manifest);
		return Response.json({ name, installed, verify });
	} catch (error) {
		if (error instanceof SandboxError) {
			return Response.json({ error: error.code, message: error.message }, { status: error.status });
		}
		return Response.json(
			{ error: 'install failed', message: `installing "${name}" failed` },
			{ status: 502 }
		);
	}
};
