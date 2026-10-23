import { fail, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth-helpers';
import {
	SandboxError,
	createSandboxUploadDir,
	deleteSandboxArtifacts,
	deleteSandboxUploads,
	listSandboxArtifacts,
	listSandboxUploads,
	sandboxErrorMessage,
	uploadSandboxFile,
	type UploadTree
} from '#lib/server/sandbox';
import {
	MAX_DIR_FILES,
	MAX_DIR_TOTAL_BYTES,
	MAX_DIR_TOTAL_LABEL,
	MAX_UPLOAD_BYTES,
	MAX_UPLOAD_LABEL,
	UPLOAD_TOO_LARGE
} from '#lib/server/upload-limit';
import type { Actions, PageServerLoad } from './$types';

/** The tree lives in the sandbox workspace, not in Postgres (PRD 0003 §7): the
 * page reads it back through the sandbox, like the document preview does. The
 * artifacts panel (RFC 0009) reads the same shape from the artifacts root. */
export const load: PageServerLoad = async (event) => {
	const { locals, url } = event;
	requireUser(locals, url);
	let tree: UploadTree | null = null;
	let unavailable: string | null = null;
	try {
		tree = await listSandboxUploads(event, '');
	} catch (error) {
		unavailable = sandboxErrorMessage(error);
	}
	let artifacts: UploadTree | null = null;
	if (unavailable === null) {
		try {
			artifacts = await listSandboxArtifacts(event, '');
		} catch {
			artifacts = null; // older image: no artifacts endpoint yet
		}
	}
	const dialog = url.searchParams.get('new');
	return {
		tree,
		artifacts,
		unavailable,
		maxUploadLabel: MAX_UPLOAD_LABEL,
		maxDirFiles: MAX_DIR_FILES,
		maxDirTotalLabel: MAX_DIR_TOTAL_LABEL,
		maxDirBytes: MAX_DIR_TOTAL_BYTES,
		dialog: dialog === 'dir' || dialog === 'folder' ? dialog : null
	};
};

export const actions: Actions = {
	/** Create (or confirm) a directory: the setup phase of PRD 0003 §5. */
	create: async (event) => {
		requireUser(event.locals);
		const form = await event.request.formData();
		const path = String(form.get('path') ?? '')
			.trim()
			.replace(/^\/+|\/+$/g, '');
		if (path === '') return fail(400, { message: 'Give the directory a path, e.g. md-to-docx.' });
		try {
			await createSandboxUploadDir(event, path);
		} catch (error) {
			if (error instanceof SandboxError && error.status === 400) {
				return fail(400, { message: `"${path}" is not a valid directory path.` });
			}
			return fail(503, { message: sandboxErrorMessage(error) });
		}
		redirect(303, '/dashboard/uploads');
	},

	/** Stage every file of a directory upload at its complete client-chosen path.
	 * Files arrive as one form post; the browser's relative paths ride along as a
	 * `paths` array aligned by index, because a plain input submits basenames only. */
	upload: async (event) => {
		requireUser(event.locals);
		const form = await event.request.formData();
		const files = form
			.getAll('files')
			.filter((entry): entry is File => entry instanceof File && entry.size > 0);
		if (files.length === 0) return fail(400, { message: 'Choose a directory to upload.' });
		if (files.length > MAX_DIR_FILES) {
			return fail(400, { message: `A directory upload is limited to ${MAX_DIR_FILES} files.` });
		}

		let paths: string[] = [];
		try {
			const parsed: unknown = JSON.parse(String(form.get('paths') ?? '[]'));
			if (Array.isArray(parsed)) paths = parsed.map((value) => String(value));
		} catch {
			paths = [];
		}
		if (paths.length !== files.length) {
			return fail(400, {
				message: 'The file list and the path list do not match. Retry the upload.'
			});
		}

		let total = 0;
		for (const file of files) {
			if (file.size > MAX_UPLOAD_BYTES) {
				return fail(400, { message: `${file.name}: ${UPLOAD_TOO_LARGE}` });
			}
			total += file.size;
		}
		if (total > MAX_DIR_TOTAL_BYTES) {
			return fail(400, {
				message: `A directory upload is limited to ${MAX_DIR_TOTAL_LABEL} in total.`
			});
		}

		// Sequential on purpose: peak memory is one file, and a failure names the
		// path that broke. What already landed stays (PRD 0003 §7): retrying
		// rewrites the same paths.
		for (const [index, file] of files.entries()) {
			const path = paths[index] ?? file.name;
			try {
				await uploadSandboxFile(event, {
					path,
					mimeType: file.type || 'application/octet-stream',
					bytes: new Uint8Array(await file.arrayBuffer())
				});
			} catch (error) {
				if (error instanceof SandboxError && error.status === 413) {
					return fail(400, { message: `${path}: ${UPLOAD_TOO_LARGE}` });
				}
				return fail(503, { message: `${path}: ${sandboxErrorMessage(error)}` });
			}
		}
		redirect(303, '/dashboard/uploads');
	},

	delete: async (event) => {
		requireUser(event.locals);
		const form = await event.request.formData();
		const path = String(form.get('path') ?? '');
		if (path === '') return fail(400, { message: 'Missing path.' });
		try {
			await deleteSandboxUploads(event, path);
		} catch (error) {
			return fail(503, { message: sandboxErrorMessage(error) });
		}
		redirect(303, '/dashboard/uploads');
	},

	/** Remove a file or subtree under `artifacts/` (RFC 0009 D7). */
	deleteArtifact: async (event) => {
		requireUser(event.locals);
		const form = await event.request.formData();
		const path = String(form.get('path') ?? '');
		if (path === '') return fail(400, { message: 'Missing path.' });
		try {
			await deleteSandboxArtifacts(event, path);
		} catch (error) {
			return fail(503, { message: sandboxErrorMessage(error) });
		}
		redirect(303, '/dashboard/uploads');
	}
};
