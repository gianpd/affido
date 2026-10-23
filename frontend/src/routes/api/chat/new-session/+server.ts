import { newSessionSandbox, sandboxErrorMessage } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/** Start a separate agent conversation (RFC 0008) and switch the sandbox to it.
 *
 * The previous conversation keeps its entries, its chat rows and its usage;
 * nothing is deleted. The page reload then shows the new, empty conversation. */
export const POST: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

	try {
		return Response.json(await newSessionSandbox(event));
	} catch (error) {
		return Response.json({ error: sandboxErrorMessage(error) }, { status: 503 });
	}
};
