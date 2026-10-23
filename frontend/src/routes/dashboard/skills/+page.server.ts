import { fail, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth-helpers';
import { listCatalog } from '#lib/server/marketplace';
import { deleteSandboxSkill, listSandboxSkills, type InstalledSkill } from '#lib/server/sandbox';
import type { Actions, PageServerLoad } from './$types';

/** The catalog page (RFC 0009 D7): the repo bundle plus the user's installed
 * state. Visiting can cold-provision the sandbox, exactly like the uploads
 * page; an unreachable or older sandbox degrades to "nothing installed yet". */
export const load: PageServerLoad = async (event) => {
	const { locals, url } = event;
	requireUser(locals, url);
	let installed: InstalledSkill[];
	try {
		installed = (await listSandboxSkills(event)).skills;
	} catch {
		installed = []; // older image (404) or offline: the catalog still renders
	}
	return {
		catalog: await listCatalog(),
		installed
	};
};

export const actions: Actions = {
	/** Uninstall: one action, one subtree removal (R2). */
	uninstall: async (event) => {
		requireUser(event.locals);
		const form = await event.request.formData();
		const name = String(form.get('name') ?? '');
		if (name === '') return fail(400, { message: 'Missing skill name.' });
		try {
			await deleteSandboxSkill(event, name);
		} catch {
			// A sandbox without the endpoint or already gone is not an error here.
		}
		redirect(303, '/dashboard/skills');
	}
};
