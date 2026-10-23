import { fail, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth-helpers';
import { createCorpus, deleteCorpus, listCorpora } from '#lib/server/documents';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals, url);
	return {
		corpora: await listCorpora(user.id),
		newDialog: url.searchParams.get('new') === '1'
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		if (!name) return fail(400, { message: 'Give the corpus a name.' });
		const id = await createCorpus(user.id, { name: name.slice(0, 120), description });
		redirect(303, `/dashboard/corpus/${id}`);
	},

	delete: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!id) return fail(400, { message: 'Missing corpus id.' });
		await deleteCorpus(user.id, id);
		redirect(303, '/dashboard/corpus');
	}
};
