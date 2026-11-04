import { json } from '@sveltejs/kit';
import { citationsReportSandbox, sandboxErrorMessage } from '#lib/server/sandbox';
import type { RequestHandler } from './$types';

/** One conversation's citation report, per-pair judge verdicts included.
 * Activates the sandbox, like `/inspect`: the detail page calls it only when
 * the judge tab is opened, so browsing stored snapshots never wakes the agent. */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) return Response.json({ error: 'sign in first' }, { status: 401 });

	const raw = event.url.searchParams.get('conversation') ?? '';
	const conversationId = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(conversationId) || conversationId < 1) {
		return Response.json({ error: 'conversation must be a positive integer' }, { status: 400 });
	}

	try {
		return json(await citationsReportSandbox(event, { conversationId }));
	} catch (error) {
		return Response.json({ error: sandboxErrorMessage(error) }, { status: 503 });
	}
};
