import { requireUser } from '#lib/server/auth-helpers';
import { documentStats, listDocuments } from '#lib/server/documents';
import { listTraceSessions, traceTotals } from '#lib/server/trace-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals, url);
	const [documents, sessions, totals, stats] = await Promise.all([
		listDocuments(user.id),
		listTraceSessions(user.id),
		traceTotals(user.id),
		documentStats(user.id)
	]);

	return {
		documents: documents.slice(0, 5),
		sessions: sessions.slice(0, 5),
		stats: {
			...stats,
			sessions: sessions.length,
			tokens: totals.tokens,
			cost: totals.cost
		}
	};
};
