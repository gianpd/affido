import {
	MANAGER_TOKEN,
	SANDBOX_GATEWAY_URL,
	SANDBOX_MANAGER_URL,
	SANDBOX_REQUEST_TIMEOUT_MS
} from '$app/env/private';
import type { RequestEvent } from '@sveltejs/kit';
import type { PromptResult, SandboxStatus, TraceEntryDetail, TraceReport } from '#lib/types';

/**
 * One place that knows how to talk to a user's sandbox.
 *
 * Two modes:
 * - trusted caller (`SANDBOX_MANAGER_URL` set): ask the manager to resolve the
 *   user, then dial the container endpoint directly. This is the Web Client
 *   path of RFC 0003 and does not depend on the better-auth cookie format.
 * - gateway (default): go through Caddy at `SANDBOX_GATEWAY_URL`, forwarding
 *   the browser's cookie so `forward_auth` can authenticate it.
 */
export class SandboxError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'SandboxError';
		this.status = status;
		this.code = code;
	}
}

type SandboxRequestInit = Omit<RequestInit, 'signal'> & { timeoutMs?: number };

const managerHeaders = (): HeadersInit => ({
	'content-type': 'application/json',
	...(MANAGER_TOKEN ? { 'x-manager-token': MANAGER_TOKEN } : {})
});

const resolveEndpoint = async (userId: string): Promise<string> => {
	const response = await fetch(`${SANDBOX_MANAGER_URL.replace(/\/$/, '')}/resolve`, {
		method: 'POST',
		headers: managerHeaders(),
		body: JSON.stringify({ user_id: userId }),
		signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS)
	});
	const body = (await response.json().catch(() => ({}))) as {
		endpoint?: string;
		error?: string;
	};
	if (!response.ok || !body.endpoint) {
		throw new SandboxError(
			response.status === 401 || response.status === 403 ? 502 : 503,
			'manager_unavailable',
			body.error ?? `sandbox manager answered ${response.status}`
		);
	}
	return body.endpoint;
};

const sandboxUrl = async (
	event: RequestEvent,
	path: string
): Promise<{ url: string; headers: Headers }> => {
	const userId = event.locals.user?.id;
	if (!userId) throw new SandboxError(401, 'unauthorized', 'sign in first');

	const headers = new Headers(
		event.request.headers.get('cookie')
			? { cookie: event.request.headers.get('cookie') as string }
			: {}
	);
	if (SANDBOX_MANAGER_URL) {
		const endpoint = await resolveEndpoint(userId);
		return { url: `http://${endpoint}${path}`, headers };
	}
	return {
		url: `${SANDBOX_GATEWAY_URL.replace(/\/$/, '')}/u/${encodeURIComponent(userId)}${path}`,
		headers
	};
};

async function sandboxFetch<T>(
	event: RequestEvent,
	path: string,
	init: SandboxRequestInit = {}
): Promise<T> {
	const { url, headers } = await sandboxUrl(event, path);
	for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
	if (init.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}

	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			headers,
			signal: AbortSignal.timeout(init.timeoutMs ?? SANDBOX_REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new SandboxError(503, 'sandbox_unreachable', `sandbox is unreachable: ${reason}`);
	}

	const text = await response.text();
	let payload: unknown;
	try {
		payload = text === '' ? null : JSON.parse(text);
	} catch {
		payload = { message: text };
	}

	if (!response.ok) {
		const body = (payload ?? {}) as { error?: string; message?: string };
		throw new SandboxError(
			response.status,
			body.error ?? 'sandbox_error',
			body.message ?? `sandbox answered ${response.status}`
		);
	}
	return payload as T;
}

export const promptSandbox = (
	event: RequestEvent,
	prompt: string,
	requestId: string | undefined,
	citations: 'required' | 'off' = 'off'
): Promise<PromptResult> =>
	sandboxFetch<PromptResult>(event, '/prompt', {
		method: 'POST',
		body: JSON.stringify({
			prompt,
			...(requestId === undefined ? {} : { requestId }),
			citations
		})
	});

export const inspectSandbox = (
	event: RequestEvent,
	options: { conversationId?: number; limit?: number } = {}
): Promise<TraceReport> => {
	const params = new URLSearchParams();
	if (options.conversationId !== undefined)
		params.set('conversation', String(options.conversationId));
	if (options.limit !== undefined) params.set('limit', String(options.limit));
	const query = params.size > 0 ? `?${params}` : '';
	return sandboxFetch<TraceReport>(event, `/inspect${query}`);
};

/** One strict-citations run, as `GET /inspect?report=citations` reports it (RFC 0006 §5.8). */
export type CitationRunReportView = {
	runId: string;
	strict: boolean;
	prompt: string;
	published: boolean;
	plain: boolean;
	used: string[];
	reported: string[];
	exact: boolean;
	unreportedUsed: string[];
	padded: string[];
	repliedWithoutCitations: boolean;
	annotateRejected: Record<string, number>;
	publishRejected: Record<string, number>;
	corpusCalls: number;
};

export type CitationsReport = {
	agent: string;
	conversationId: number;
	runs: CitationRunReportView[];
	gatedReplies: number;
	exactReplies: number;
	citationExactness: number | null;
};

/**
 * The trace-only citation measurement of the user's sandbox, or null when the
 * sandbox does not serve it: an older image ignores `report=citations` and
 * answers 200 with the plain trace report, which has no `runs`.
 */
export const citationsReportSandbox = async (
	event: RequestEvent
): Promise<CitationsReport | null> => {
	const payload = await sandboxFetch<CitationsReport | null>(event, '/inspect?report=citations');
	return payload !== null && Array.isArray(payload.runs) ? payload : null;
};

/**
 * One entry unprojected, for the trace page's expanded row. The report keeps a
 * 160-character summary per entry; this reads the stored messages instead. It
 * activates the sandbox, like `/inspect`.
 */
export const inspectEntrySandbox = (event: RequestEvent, id: number): Promise<TraceEntryDetail> =>
	sandboxFetch<TraceEntryDetail>(event, `/entry?id=${id}`);

export const statusSandbox = (event: RequestEvent): Promise<SandboxStatus> =>
	sandboxFetch<SandboxStatus>(event, '/status', { timeoutMs: 5000 });

/** Start a new context in the sandbox conversation; older entries stay on disk. */
export const resetSandbox = (
	event: RequestEvent
): Promise<{ agent: string; conversationId: number; entries: number }> =>
	sandboxFetch(event, '/reset', { method: 'POST' });

/** Start a separate sandbox conversation (RFC 0008); the previous one stays readable. */
export const newSessionSandbox = (
	event: RequestEvent
): Promise<{ agent: string; conversationId: number; entries: number }> =>
	sandboxFetch(event, '/session/new', { method: 'POST' });

/** Make an existing sandbox conversation the active one (RFC 0008): resuming a
 * previous session. Nothing is copied or deleted; the conversation's entries
 * and chat rows stay as they were. */
export const switchSessionSandbox = (
	event: RequestEvent,
	conversationId: number
): Promise<{ agent: string; conversationId: number; entries: number }> =>
	sandboxFetch(event, '/session/switch', {
		method: 'POST',
		body: JSON.stringify({ conversationId })
	});

type StagedRaw = {
	docId: string;
	path: string;
	bytes: number;
	sourceSha256: string;
};

/** One entry of the uploads tree (PRD 0003): a path relative to the uploads
 * root, its kind, and the file size (null for directories). */
export type UploadTreeEntry = {
	path: string;
	kind: 'dir' | 'file';
	bytes: number | null;
};

export type UploadTree = {
	path: string;
	truncated: boolean;
	entries: UploadTreeEntry[];
};

export type StagedUploadFile = {
	path: string;
	bytes: number;
	sha256: string;
	/** Whether corpus_grep can see the file now: text files directly, PDFs
	 * through their staging-time extracted text, other binaries never. */
	searchable?: boolean;
};

/** Create (or confirm) a directory in the user's uploads tree. */
export const createSandboxUploadDir = (
	event: RequestEvent,
	path: string
): Promise<{ path: string }> =>
	sandboxFetch(event, '/uploads/dir', { method: 'POST', body: JSON.stringify({ path }) });

/** Write one uploaded file at its complete client-chosen path under `corpus/uploads/`.
 * Like `ingestSandbox`, the bytes go straight to the sandbox workspace. */
export const uploadSandboxFile = (
	event: RequestEvent,
	input: { path: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> }
): Promise<StagedUploadFile> => {
	const params = new URLSearchParams({ path: input.path });
	return sandboxFetch<StagedUploadFile>(event, `/uploads/file?${params}`, {
		method: 'POST',
		headers: { 'content-type': input.mimeType || 'application/octet-stream' },
		body: new Blob([input.bytes])
	});
};

/** The recursive uploads tree of the root (empty path) or of one subtree. */
export const listSandboxUploads = (event: RequestEvent, path = ''): Promise<UploadTree> =>
	sandboxFetch<UploadTree>(event, `/uploads?${new URLSearchParams({ path })}`);

/** Remove a file or a whole subtree under `corpus/uploads/`. */
export const deleteSandboxUploads = (
	event: RequestEvent,
	path: string
): Promise<{ path: string }> =>
	sandboxFetch(event, `/uploads?${new URLSearchParams({ path })}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Skills (RFC 0009): install, list, verify, uninstall — the marketplace loop.
// ---------------------------------------------------------------------------

/** One installed skill, as `GET /skills` reports it: both provenances, the
 * fresh verify verdict when a manifest is installed. */
export type InstalledSkill = {
	name: string;
	provenance: 'marketplace' | 'uploads';
	root: string;
	entry: string;
	description: string | null;
	version: string | null;
	verified: 'ok' | 'mismatch' | null;
};

export type SkillVerifyReport = {
	skill: string;
	ok: boolean;
	files: { path: string; status: 'ok' | 'mismatch' | 'missing' }[];
};

/** Write one catalog file at `skills/<name>/<path>` in the user's sandbox. */
export const installSandboxSkill = (
	event: RequestEvent,
	input: { name: string; path: string; bytes: Uint8Array<ArrayBuffer> }
): Promise<StagedUploadFile> => {
	const params = new URLSearchParams({ skill: input.name, path: input.path });
	return sandboxFetch<StagedUploadFile>(event, `/skills/file?${params}`, {
		method: 'POST',
		headers: { 'content-type': 'application/octet-stream' },
		body: new Blob([input.bytes])
	});
};

/** The installed skills of both roots; a sandbox without the endpoint (older
 * image) answers 404, which callers treat as "no skills". */
export const listSandboxSkills = (event: RequestEvent): Promise<{ skills: InstalledSkill[] }> =>
	sandboxFetch(event, '/skills', { timeoutMs: 10_000 });

/** Re-verify an installed skill against a catalog manifest. */
export const verifySandboxSkill = (
	event: RequestEvent,
	name: string,
	manifest: unknown
): Promise<SkillVerifyReport> =>
	sandboxFetch<SkillVerifyReport>(event, `/skills/verify?${new URLSearchParams({ skill: name })}`, {
		method: 'POST',
		body: JSON.stringify(manifest)
	});

/** Remove one installed skill subtree. */
export const deleteSandboxSkill = (
	event: RequestEvent,
	name: string
): Promise<{ skill: string; path: string }> =>
	sandboxFetch(event, `/skills?${new URLSearchParams({ skill: name })}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Artifacts (RFC 0009): the tree, the delete, and the one non-JSON call —
// the download, which must reach the browser as a stream, not as parsed JSON.
// ---------------------------------------------------------------------------

/** The recursive artifacts tree of the root or one subtree. */
export const listSandboxArtifacts = (event: RequestEvent, path = ''): Promise<UploadTree> =>
	sandboxFetch<UploadTree>(event, `/artifacts?${new URLSearchParams({ path })}`);

/** Remove a file or a whole subtree under `artifacts/`. */
export const deleteSandboxArtifacts = (
	event: RequestEvent,
	path: string
): Promise<{ path: string }> =>
	sandboxFetch(event, `/artifacts?${new URLSearchParams({ path })}`, { method: 'DELETE' });

/** Download one artifact: the sandbox's raw response, body still a stream,
 * headers (`content-type`, `content-length`, `content-disposition`) intact.
 * Shares `sandboxUrl` and the error mapping with `sandboxFetch`. */
export const downloadSandboxArtifact = async (
	event: RequestEvent,
	path: string
): Promise<Response> => {
	const { url, headers } = await sandboxUrl(event, `/artifact?${new URLSearchParams({ path })}`);
	let response: Response;
	try {
		response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new SandboxError(503, 'sandbox_unreachable', `sandbox is unreachable: ${reason}`);
	}
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
		throw new SandboxError(
			response.status,
			body.error ?? 'sandbox_error',
			body.message ?? `sandbox answered ${response.status}`
		);
	}
	return response;
};

/** Stage an upload's raw bytes in the user's sandbox.
 *
 * The control plane never stores the bytes; it records only what this returns.
 * No parse happens here yet (PRD 0001 §6.2), so the caller must not claim a
 * `textSha256` it has not been given. */
export const ingestSandbox = (
	event: RequestEvent,
	input: { docId: string; filename: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> }
): Promise<StagedRaw> => {
	const params = new URLSearchParams({ docId: input.docId, filename: input.filename });
	return sandboxFetch<StagedRaw>(event, `/ingest?${params}`, {
		method: 'POST',
		headers: { 'content-type': input.mimeType || 'application/octet-stream' },
		body: new Blob([input.bytes])
	});
};

/** Read a document's staged bytes back from the sandbox, for the preview. */
export const readSandboxDocument = (
	event: RequestEvent,
	input: { docId: string; filename: string }
): Promise<{ path: string; content: string }> => {
	const params = new URLSearchParams({ docId: input.docId, filename: input.filename });
	return sandboxFetch<{ path: string; content: string }>(event, `/raw?${params}`);
};

/** Delete a document's staged bytes. A sandbox that is already gone is not an error. */
export const deleteSandboxDocument = (
	event: RequestEvent,
	input: { docId: string; filename: string }
): Promise<{ docId: string; path: string }> =>
	sandboxFetch<{ docId: string; path: string }>(event, `/ingest?${new URLSearchParams(input)}`, {
		method: 'DELETE'
	});

/** A user-facing message that never leaks a stack trace. */
export const sandboxErrorMessage = (error: unknown): string => {
	if (error instanceof SandboxError) {
		if (error.code === 'sandbox_unreachable' || error.code === 'manager_unavailable') {
			return 'The agent sandbox is not reachable. Start the control plane (docker compose up -d) and try again.';
		}
		return error.message;
	}
	return error instanceof Error ? error.message : 'Unexpected sandbox error';
};
