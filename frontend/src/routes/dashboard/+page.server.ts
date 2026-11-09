import { requireUser } from '#lib/server/auth-helpers';
import { documentStats, listDocuments } from '#lib/server/documents';
import { storageSandbox } from '#lib/server/sandbox';
import { listTraceSessions, traceTotals } from '#lib/server/trace-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event.locals, event.url);
	const [documents, sessions, totals, stats, storage] = await Promise.all([
		listDocuments(user.id),
		listTraceSessions(user.id),
		traceTotals(user.id),
		documentStats(user.id),
		// RFC 0022: the pie chart stays usable when the sandbox is stopped.
		storageSandbox(event).catch(() => null)
	]);

	return {
		documents: documents.slice(0, 5),
		sessions: sessions.slice(0, 5),
		storage,
		stats: {
			...stats,
			sessions: sessions.length,
			tokens: totals.tokens,
			cost: totals.cost
		}
	};
};
