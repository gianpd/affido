import { json } from '@sveltejs/kit';
import { inspectEntrySandbox, sandboxErrorMessage } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/** One stored entry, verbatim: the messages the model saw, tool results and thinking included. */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });

	const raw = event.url.searchParams.get('id') ?? '';
	const id = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id)) {
		return Response.json({ error: 'id must be a positive integer' }, { status: 400 });
	}

	try {
		return json(await inspectEntrySandbox(event, id));
	} catch (error) {
		return Response.json({ error: sandboxErrorMessage(error) }, { status: 503 });
	}
};
