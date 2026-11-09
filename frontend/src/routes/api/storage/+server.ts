import { json } from '@sveltejs/kit';
import { sandboxErrorMessage, storageSandbox } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/** RFC 0022: refresh the storage pie chart without a page reload. The agent
 * route is a filesystem read; the gateway's resolve may still start a stopped
 * container, which is why the dashboard never polls this endpoint. */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });
	try {
		return json(await storageSandbox(event));
	} catch (error) {
		return Response.json({ error: sandboxErrorMessage(error) }, { status: 503 });
	}
};
