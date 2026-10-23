import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db';
import { chatMessage } from '#lib/server/db/schema';
import { resetSandbox, sandboxErrorMessage } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/** Start a new agent context and drop the renderable history for this user.
 *
 * The sandbox transcript keeps the old entries; only the visible chat resets. */
export const POST: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

	let result;
	try {
		result = await resetSandbox(event);
	} catch (error) {
		return Response.json({ error: sandboxErrorMessage(error) }, { status: 503 });
	}

	await db.delete(chatMessage).where(eq(chatMessage.userId, user.id));

	return Response.json(result);
};
