import { error, fail, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth-helpers';
import { sandboxErrorMessage } from '#lib/server/sandbox';
import {
	captureTrace,
	deleteTraceSession,
	getTraceSession,
	listConversationSnapshots
} from '#lib/server/trace-store';
import type { TraceReport } from '#lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = requireUser(locals, url);
	const session = await getTraceSession(user.id, params.id);
	if (!session) error(404, 'Trace session not found');

	const report = session.report as TraceReport;
	// Snapshot timeline of the same conversation: the page links to the captures
	// taken before and after this one so the trace history is navigable.
	const snapshots = await listConversationSnapshots(user.id, session.conversationId);
	const index = snapshots.findIndex((snapshot) => snapshot.id === session.id);

	return {
		session: {
			id: session.id,
			conversationId: session.conversationId,
			agent: session.agent,
			paused: session.paused,
			entries: session.entries,
			tokens: session.tokens,
			cost: session.cost,
			capturedAt: session.capturedAt,
			createdAt: session.createdAt
		},
		report,
		snapshotIndex: index,
		snapshotCount: snapshots.length,
		olderSnapshot: index > 0 ? snapshots[index - 1] : null,
		newerSnapshot: index >= 0 && index < snapshots.length - 1 ? snapshots[index + 1] : null
	};
};

export const actions: Actions = {
	refresh: async (event) => {
		const user = requireUser(event.locals);
		const session = await getTraceSession(user.id, event.params.id);
		if (!session) return fail(404, { message: 'Trace session not found.' });
		let conversationId: number;
		try {
			const report = await captureTrace(event, { conversationId: session.conversationId });
			conversationId = report.conversationId;
		} catch (error) {
			return fail(503, { message: sandboxErrorMessage(error) });
		}
		// Captures are append-only now: refresh lands on the new snapshot.
		const snapshots = await listConversationSnapshots(user.id, conversationId);
		const newest = snapshots.at(-1);
		if (newest) redirect(303, `/dashboard/traces/${newest.id}`);
		return { refreshed: true };
	},

	delete: async ({ locals, params }) => {
		const user = requireUser(locals);
		await deleteTraceSession(user.id, params.id);
		redirect(303, '/dashboard/traces');
	}
};
