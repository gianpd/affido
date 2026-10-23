import { fail } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth-helpers';
import { citationsReportSandbox, sandboxErrorMessage } from '#lib/server/sandbox';
import {
	captureTrace,
	countTraceConversations,
	deleteTraceSession,
	listTraceSessions,
	traceTotals
} from '#lib/server/trace-store';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event.locals, event.url);
	const [sessions, totals, conversations, citations] = await Promise.all([
		listTraceSessions(user.id),
		traceTotals(user.id),
		countTraceConversations(user.id),
		// The citation measurement needs the sandbox; the page stays usable when it is down.
		citationsReportSandbox(event).catch(() => null)
	]);
	return { sessions, totals, conversations, citations };
};

export const actions: Actions = {
	capture: async (event) => {
		try {
			await captureTrace(event);
		} catch (error) {
			return fail(503, { message: sandboxErrorMessage(error) });
		}
		return { captured: true };
	},

	delete: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!id) return fail(400, { message: 'Missing session id.' });
		await deleteTraceSession(user.id, id);
		return { deleted: true };
	}
};
