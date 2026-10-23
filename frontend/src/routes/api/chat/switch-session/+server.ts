import { conversationMessages } from '#lib/server/chat-store';
import { sandboxErrorMessage, switchSessionSandbox } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/** Resume a previous session (RFC 0008): the sandbox repoints its durable
 * active-conversation pointer, and the reply carries that conversation's chat
 * rows so the view can replace its history deterministically, without waiting
 * for the page to reload. */
export const POST: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

	let conversationId: number;
	try {
		const body = (await event.request.json()) as { conversationId?: unknown };
		if (
			typeof body.conversationId !== 'number' ||
			!Number.isSafeInteger(body.conversationId) ||
			body.conversationId < 1
		) {
			return Response.json({ error: 'conversationId must be a positive integer' }, { status: 400 });
		}
		conversationId = body.conversationId;
	} catch {
		return Response.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	try {
		const switched = await switchSessionSandbox(event, conversationId);
		// The sandbox's answer names the conversation that is now active; load
		// that one's rows, not the requested id, so a future rewrite of the
		// pointer semantics cannot desync the chat view.
		const messages = await conversationMessages(user.id, switched.conversationId);
		return Response.json({ ...switched, messages });
	} catch (error) {
		return Response.json({ error: sandboxErrorMessage(error) }, { status: 503 });
	}
};
