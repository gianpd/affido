import { documentStats } from '#lib/server/documents';
import { requireUser } from '#lib/server/auth-helpers';
import { countTraceSessions } from '#lib/server/trace-store';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals, url);
	const [documents, traces] = await Promise.all([
		documentStats(user.id),
		countTraceSessions(user.id)
	]);

	return {
		user: {
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image ?? null
		},
		counts: {
			documents: documents.documents,
			corpora: documents.corpora,
			traces
		}
	};
};
