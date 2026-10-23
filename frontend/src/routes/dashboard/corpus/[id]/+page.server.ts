import { error, fail, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth-helpers';
import {
	addDocumentToCorpus,
	deleteCorpus,
	getCorpus,
	listCorpusDocuments,
	listDocumentsOutsideCorpus,
	removeDocumentFromCorpus
} from '#lib/server/documents';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = requireUser(locals, url);
	const corpus = await getCorpus(user.id, params.id);
	if (!corpus) error(404, 'Corpus not found');
	const [documents, available] = await Promise.all([
		listCorpusDocuments(user.id, corpus.id),
		listDocumentsOutsideCorpus(user.id, corpus.id)
	]);
	return { corpus, documents, available };
};

export const actions: Actions = {
	add: async ({ request, locals, params }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const documentId = String(form.get('documentId') ?? '');
		if (!documentId) return fail(400, { message: 'Choose a document.' });
		const added = await addDocumentToCorpus(user.id, params.id, documentId);
		if (!added) return fail(404, { message: 'Document or corpus not found.' });
		return { added: true };
	},

	remove: async ({ request, locals, params }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const documentId = String(form.get('documentId') ?? '');
		if (!documentId) return fail(400, { message: 'Missing document id.' });
		const removed = await removeDocumentFromCorpus(user.id, params.id, documentId);
		if (!removed) return fail(404, { message: 'Corpus not found.' });
		return { removed: true };
	},

	delete: async ({ locals, params }) => {
		const user = requireUser(locals);
		await deleteCorpus(user.id, params.id);
		redirect(303, '/dashboard/corpus');
	}
};
