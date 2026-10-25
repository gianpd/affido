import { fail, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth-helpers';
import {
	createDocument,
	deleteDocument,
	getDocument,
	listCorpora,
	listDocuments,
	recordIngestEvent
} from '#lib/server/documents';
import {
	deleteSandboxDocument,
	ingestSandbox,
	readSandboxDerivedText,
	readSandboxDocument,
	sandboxErrorMessage,
	SandboxError
} from '#lib/server/sandbox';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, UPLOAD_TOO_LARGE } from '#lib/server/upload-limit';
import type { Actions, PageServerLoad } from './$types';

type DocumentPreview =
	{ text: string } | { unavailable: 'sandbox' | 'binary' | 'reingest' | 'notext' };

/** Text documents render in the dialog; a PDF renders its extracted text;
 * anything else says so instead of guessing. */
const isTextLike = (mimeType: string): boolean =>
	mimeType.startsWith('text/') || /(json|xml|yaml|csv|javascript|x-sh)/.test(mimeType);
const isPdf = (mimeType: string, filename: string): boolean =>
	mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');

export const load: PageServerLoad = async (event) => {
	const { locals, url } = event;
	const user = requireUser(locals, url);
	const [documents, corpora] = await Promise.all([listDocuments(user.id), listCorpora(user.id)]);
	const selectedId = url.searchParams.get('doc');
	const selected = selectedId ? await getDocument(user.id, selectedId) : null;

	let preview: DocumentPreview | null = null;
	if (selected) {
		if (!selected.filename) {
			preview = { unavailable: 'reingest' };
		} else if (isTextLike(selected.mimeType)) {
			try {
				const file = await readSandboxDocument(event, {
					docId: selected.id,
					filename: selected.filename
				});
				preview = { text: file.content };
			} catch {
				preview = { unavailable: 'sandbox' };
			}
		} else if (isPdf(selected.mimeType, selected.filename)) {
			// The sandbox derives the indexable text of a PDF at upload time; the
			// preview shows that, never the binary bytes.
			try {
				const file = await readSandboxDerivedText(event, selected.id);
				preview = { text: file.content };
			} catch (error) {
				preview =
					error instanceof SandboxError && error.status !== 404
						? { unavailable: 'sandbox' }
						: { unavailable: 'notext' };
			}
		} else {
			preview = { unavailable: 'binary' };
		}
	}

	return {
		documents,
		corpora,
		selected: selected
			? {
					id: selected.id,
					title: selected.title,
					filename: selected.filename,
					mimeType: selected.mimeType,
					size: selected.size,
					sourceSha256: selected.sourceSha256,
					ingestStatus: selected.ingestStatus,
					updatedAt: selected.updatedAt,
					preview
				}
			: null,
		maxUploadLabel: MAX_UPLOAD_LABEL,
		newDialog: url.searchParams.get('new') === '1'
	};
};

type Upload =
	{ bytes: Uint8Array<ArrayBuffer>; filename: string; mimeType: string } | { error: string };

const readUpload = async (form: FormData): Promise<Upload> => {
	const file = form.get('file');
	if (file instanceof File && file.size > 0) {
		if (file.size > MAX_UPLOAD_BYTES) return { error: UPLOAD_TOO_LARGE };
		return {
			bytes: new Uint8Array(await file.arrayBuffer()),
			filename: file.name || 'upload.bin',
			mimeType: file.type || 'application/octet-stream'
		};
	}
	const pasted = String(form.get('content') ?? '');
	if (pasted.trim() === '') return { error: 'Paste text or choose a file.' };
	const bytes = new TextEncoder().encode(pasted);
	if (bytes.length > MAX_UPLOAD_BYTES) return { error: UPLOAD_TOO_LARGE };
	return {
		bytes,
		filename: 'pasted.txt',
		mimeType: 'text/plain'
	};
};

export const actions: Actions = {
	create: async (event) => {
		const user = requireUser(event.locals);
		const form = await event.request.formData();
		const requestedTitle = String(form.get('title') ?? '').trim();
		const corpusId = String(form.get('corpusId') ?? '').trim();
		if (!requestedTitle) return fail(400, { message: 'Give the document a title.' });

		const upload = await readUpload(form);
		if ('error' in upload) return fail(400, { message: upload.error });

		// The id exists before the sandbox write: it names the workspace path and the
		// ingest request, so a retry lands on the same file and the same event.
		const docId = crypto.randomUUID();
		const startedAt = Date.now();
		let staged: { bytes: number; sourceSha256: string };
		try {
			staged = await ingestSandbox(event, { docId, ...upload });
		} catch (error) {
			return fail(503, { message: sandboxErrorMessage(error) });
		}

		const title = requestedTitle.slice(0, 200);
		try {
			await createDocument(user.id, {
				id: docId,
				title,
				filename: upload.filename,
				mimeType: upload.mimeType,
				bytes: staged.bytes,
				sourceSha256: staged.sourceSha256,
				corpusId: corpusId === '' || corpusId === 'none' ? null : corpusId
			});
		} catch (error) {
			// The row is the record of the upload; if it cannot be written, the staged
			// bytes are orphans and must not stay behind.
			await deleteSandboxDocument(event, { docId, filename: upload.filename }).catch(
				() => undefined
			);
			throw error;
		}

		await recordIngestEvent(user.id, {
			id: crypto.randomUUID(),
			documentId: docId,
			requestId: docId,
			sourceSha256: staged.sourceSha256,
			bytes: staged.bytes,
			status: 'raw_only',
			durationMs: Date.now() - startedAt
		});

		redirect(303, `/dashboard/documents?doc=${docId}`);
	},

	delete: async (event) => {
		const user = requireUser(event.locals);
		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		if (!id) return fail(400, { message: 'Missing document id.' });

		const row = await getDocument(user.id, id);
		if (!row) return fail(404, { message: 'Document not found.' });

		const startedAt = Date.now();
		if (row.filename) {
			try {
				await deleteSandboxDocument(event, { docId: row.id, filename: row.filename });
			} catch (error) {
				// The metadata row is the source of truth for "exists": a sandbox that is
				// gone must not block the delete, but the event records that it did.
				await recordIngestEvent(user.id, {
					id: crypto.randomUUID(),
					documentId: row.id,
					requestId: `${row.id}:delete:${startedAt}`,
					sourceSha256: row.sourceSha256 ?? '',
					bytes: 0,
					status: 'delete_failed',
					errorCode: sandboxErrorMessage(error),
					durationMs: Date.now() - startedAt
				});
			}
		}

		await deleteDocument(user.id, id);
		redirect(303, '/dashboard/documents');
	}
};
