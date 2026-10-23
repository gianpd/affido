// Tools: one HTTP operation each — a method, a path, and a handler.

import type { EntryId } from "@earendil-works/pi-durable";
import { HttpError, RawResponse, readBody, readRawBody } from "./http.ts";
import {
	indexedAsText,
	MAX_UPLOAD_BYTES,
	rawRelativePath,
	removeDerivedText,
	removeRaw,
	safeDocId,
	stageDerivedText,
	stageRaw,
	uploadsDocIdOf,
	writeMeta,
} from "./corpus.ts";
import { createUploadDir, listUploadTree, removeUploadPath, stageUploadFile, UPLOADS_DIR } from "./uploads.ts";
import {
	installSkillFile,
	listInstalledSkills,
	parseSkillManifest,
	removeSkill,
	verifySkill,
} from "./skills.ts";
import { listArtifactTree, readArtifact, removeArtifactPath } from "./artifacts.ts";
import type { CitationMode } from "./types.ts";
import { InvalidTraceQueryError, parseTraceQuery, UnknownConversationError, UnknownEntryError } from "./trace.ts";
import type { TraceQuery } from "./trace.ts";
import type { ToolRequest } from "./types.ts";

export class HttpTool {
	readonly name: string;
	readonly method: string;
	readonly path: string;

	constructor(name: string, method: string, path: string) {
		this.name = name;
		this.method = method;
		this.path = path;
	}

	matches(method: string, pathname: string): boolean {
		return this.method === method && this.path === pathname;
	}

	/** Return the JSON body for a 200 response, or throw `HttpError` for another status. */
	handle(_request: ToolRequest): unknown | Promise<unknown> {
		throw new Error(`Tool ${this.name} does not implement handle()`);
	}
}

/** Liveness, used by the Docker healthcheck; never activates. */
export class HealthTool extends HttpTool {
	constructor() {
		super("health", "GET", "/health");
	}

	handle(_request: ToolRequest): unknown {
		return { status: "ok" };
	}
}

/** Cached status; never activates, so a probe cannot defeat the idle pause. */
export class StatusTool extends HttpTool {
	constructor() {
		super("status", "GET", "/status");
	}

	handle({ agent }: ToolRequest): unknown {
		return agent.status();
	}
}

/** Reopen the conversation and report its id and entry count. */
export class SessionTool extends HttpTool {
	constructor() {
		super("session", "GET", "/session");
	}

	handle({ agent }: ToolRequest): unknown {
		return agent.session();
	}
}

/** Read the durable trace of one conversation: entries, live work, usage. */
export class InspectTool extends HttpTool {
	constructor() {
		super("inspect", "GET", "/inspect");
	}

	async handle({ agent, url }: ToolRequest): Promise<unknown> {
		let query: TraceQuery;
		try {
			query = parseTraceQuery(url.searchParams);
		} catch (error) {
			if (error instanceof InvalidTraceQueryError) throw new HttpError(400, { error: "invalid_query", message: error.message });
			throw error;
		}
		try {
			return await agent.inspect(query);
		} catch (error) {
			if (error instanceof UnknownConversationError) throw new HttpError(404, { error: "not_found", message: error.message });
			throw error;
		}
	}
}

/** Read one stored entry verbatim: the messages the model saw, tool results included. */
export class EntryTool extends HttpTool {
	constructor() {
		super("entry", "GET", "/entry");
	}

	async handle({ agent, url }: ToolRequest): Promise<unknown> {
		const raw = url.searchParams.get("id") ?? "";
		const id = Number(raw);
		if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id))
			throw new HttpError(400, { error: "invalid_query", message: "id must be a positive integer" });
		try {
			return await agent.inspectEntry(id as EntryId);
		} catch (error) {
			if (error instanceof UnknownEntryError) throw new HttpError(404, { error: "not_found", message: error.message });
			throw error;
		}
	}
}

/** List a directory in the container workspace. */
export class ListFilesTool extends HttpTool {
	constructor() {
		super("files", "GET", "/files");
	}

	handle({ agent, url }: ToolRequest): unknown {
		return agent.listDir(url.searchParams.get("path") ?? ".");
	}
}

/** Read a text file in the container workspace. */
export class ReadFileTool extends HttpTool {
	constructor() {
		super("file", "GET", "/file");
	}

	async handle({ agent, url }: ToolRequest): Promise<unknown> {
		const path = url.searchParams.get("path");
		if (path === null) throw new HttpError(400, { error: "path is required" });
		return agent.readFile(path);
	}
}

/** Create (or confirm) a directory of the user-driven uploads tree (PRD 0003).
 * Like `/ingest`, this is plain filesystem work: it never activates the agent. */
export class CreateUploadDirTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("uploads_dir", "POST", "/uploads/dir");
		this.#workspace = workspace;
	}

	async handle({ req }: ToolRequest): Promise<unknown> {
		const body = await readBody(req);
		return createUploadDir({ workspace: this.#workspace, path: typeof body.path === "string" ? body.path : "" });
	}
}

/** Write one uploaded file at its complete client-chosen path under
 * `corpus/uploads/` (PRD 0003): `?path=md-to-docx/references/style-guide.md` in
 * the query, raw bytes as the body. A PDF also gets its text derived into
 * `corpus/text/` so the citation index sees it. Never activates the agent. */
export class UploadFileTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("uploads_file", "POST", "/uploads/file");
		this.#workspace = workspace;
	}

	async handle({ req, url, agent }: ToolRequest): Promise<unknown> {
		const path = url.searchParams.get("path") ?? "";
		const bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		if (bytes.length === 0) throw new HttpError(400, { error: "empty_body", message: "the upload is empty" });
		const staged = await stageUploadFile({ workspace: this.#workspace, path, bytes });
		const name = staged.path.slice(UPLOADS_DIR.length + 1);
		const derived = await stageDerivedText({
			workspace: this.#workspace,
			docId: uploadsDocIdOf(name),
			filename: name,
			bytes,
		});
		agent.noteCorpusChange();
		return { ...staged, searchable: indexedAsText(name, derived) };
	}
}

/** The recursive tree of the uploads root (no `path`) or of one subtree.
 * Plain filesystem read: never activates the agent. */
export class ListUploadsTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("uploads_list", "GET", "/uploads");
		this.#workspace = workspace;
	}

	handle({ url }: ToolRequest): unknown {
		return listUploadTree({ workspace: this.#workspace, path: url.searchParams.get("path") ?? "" });
	}
}

/** Remove a file or a whole subtree under `corpus/uploads/`. The derived text
 * of a deleted PDF stays behind (keyed by docId, inert without its file);
 * never activates the agent. */
export class DeleteUploadTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("uploads_delete", "DELETE", "/uploads");
		this.#workspace = workspace;
	}

	async handle({ url, agent }: ToolRequest): Promise<unknown> {
		const removed = removeUploadPath({ workspace: this.#workspace, path: url.searchParams.get("path") ?? "" });
		agent.noteCorpusChange();
		return removed;
	}
}

/** Write one marketplace bundle file under `skills/<name>/<path>` (RFC 0009
 * D2): `?skill=md-to-docx&path=SKILL.md` in the query, raw bytes as the body.
 * Idempotent by path; plain filesystem work, never activates the agent. */
export class SkillsFileTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("skills_file", "POST", "/skills/file");
		this.#workspace = workspace;
	}

	async handle({ req, url }: ToolRequest): Promise<unknown> {
		const bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		if (bytes.length === 0) throw new HttpError(400, { error: "empty_body", message: "the skill file is empty" });
		return installSkillFile({
			workspace: this.#workspace,
			skill: url.searchParams.get("skill") ?? "",
			path: url.searchParams.get("path") ?? "",
			bytes,
		});
	}
}

/** The installed skills of both roots (RFC 0009 D2): name, provenance,
 * description, version, and a fresh verify when a manifest is installed.
 * Never activates the agent. */
export class ListSkillsTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("skills_list", "GET", "/skills");
		this.#workspace = workspace;
	}

	handle(_request: ToolRequest): unknown {
		return listInstalledSkills({ workspace: this.#workspace });
	}
}

/** Re-verify the installed files of one skill against a manifest body (R10):
 * `?skill=` in the query, the shipped `marketplace.json` as the body. */
export class VerifySkillTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("skills_verify", "POST", "/skills/verify");
		this.#workspace = workspace;
	}

	async handle({ req, url }: ToolRequest): Promise<unknown> {
		const skill = url.searchParams.get("skill") ?? "";
		const manifest = parseSkillManifest(skill, await readBody(req));
		return verifySkill({ workspace: this.#workspace, skill, manifest });
	}
}

/** Remove one installed skill subtree; missing is not an error (R2). */
export class DeleteSkillTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("skills_delete", "DELETE", "/skills");
		this.#workspace = workspace;
	}

	handle({ url }: ToolRequest): unknown {
		return removeSkill({ workspace: this.#workspace, skill: url.searchParams.get("skill") ?? "" });
	}
}

/** The recursive tree of the artifacts root (RFC 0009 D5). Symlinks are
 * skipped; never activates the agent. */
export class ListArtifactsTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("artifacts_list", "GET", "/artifacts");
		this.#workspace = workspace;
	}

	handle({ url }: ToolRequest): unknown {
		return listArtifactTree({ workspace: this.#workspace, path: url.searchParams.get("path") ?? "" });
	}
}

/** Download one artifact (R6): confined under `artifacts/`, symlink-free,
 * capped, an attachment with a static content type — the agent's only
 * non-JSON response. Never activates the agent. */
export class ArtifactTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("artifact_download", "GET", "/artifact");
		this.#workspace = workspace;
	}

	async handle({ url }: ToolRequest): Promise<RawResponse> {
		const path = url.searchParams.get("path");
		if (path === null) throw new HttpError(400, { error: "invalid_query", message: "path is required" });
		const download = await readArtifact({ workspace: this.#workspace, path });
		return new RawResponse(
			200,
			{
				"content-type": download.contentType,
				"content-length": String(download.bytes),
				"content-disposition": download.disposition,
			},
			download.body,
		);
	}
}

/** Remove a file or a whole subtree under `artifacts/`; missing is not an error. */
export class DeleteArtifactsTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("artifacts_delete", "DELETE", "/artifacts");
		this.#workspace = workspace;
	}

	handle({ url }: ToolRequest): unknown {
		return removeArtifactPath({ workspace: this.#workspace, path: url.searchParams.get("path") ?? "" });
	}
}

/** Submit user input; activates the agent and runs any tools the model calls.
 * `citations: "required"` (RFC 0006 §5.9) turns the submission into a strict run:
 * the gate, the strict exits and the strict prompt apply to it alone. */
export class PromptTool extends HttpTool {
	constructor() {
		super("prompt", "POST", "/prompt");
	}

	async handle({ req, agent }: ToolRequest): Promise<unknown> {
		const body = await readBody(req);
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		if (prompt === "") throw new HttpError(400, { error: "prompt is required" });
		const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
		let citations: CitationMode | undefined;
		if (body.citations !== undefined) {
			if (body.citations !== "required" && body.citations !== "off") {
				throw new HttpError(400, { error: "invalid_citations", message: 'citations must be "required" or "off"' });
			}
			citations = body.citations;
		}
		return agent.prompt(prompt, requestId, citations);
	}
}

/** One run's citations, re-verified against the stored text (RFC 0006 R11).
 * Activates the agent: it reads the run state and the corpus. */
export class CitationsTool extends HttpTool {
	constructor() {
		super("citations", "GET", "/corpus/citations");
	}

	async handle({ agent, url }: ToolRequest): Promise<unknown> {
		const runId = url.searchParams.get("runId") ?? "";
		if (runId === "") throw new HttpError(400, { error: "invalid_query", message: "runId is required" });
		return agent.citations(runId);
	}
}

/** Start a separate conversation and make it the active one (RFC 0008).
 * The previous conversation keeps its entries and stays readable through
 * `/inspect?conversation=`; nothing is deleted. */
export class NewSessionTool extends HttpTool {
	constructor() {
		super("new-session", "POST", "/session/new");
	}

	handle({ agent }: ToolRequest): unknown {
		return agent.newSession();
	}
}

/** Make an existing conversation the active one (RFC 0008): the resume path of
 * `/session/new`. Activates the agent: it rewrites the durable
 * active-conversation pointer, exactly one commit; the conversation itself is
 * not modified, so its entries and chat rows stay as they were. */
export class SwitchSessionTool extends HttpTool {
	constructor() {
		super("switch-session", "POST", "/session/switch");
	}

	async handle({ agent, req }: ToolRequest): Promise<unknown> {
		const body = await readBody(req);
		const id = body.conversationId;
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
			throw new HttpError(400, { error: "invalid_conversation", message: "conversationId must be a positive integer" });
		try {
			return await agent.switchSession(id);
		} catch (error) {
			if (error instanceof UnknownConversationError) throw new HttpError(404, { error: "not_found", message: error.message });
			throw error;
		}
	}
}

/** Start a new context in the same conversation (a `pi.reset` entry). */
export class ResetTool extends HttpTool {
	constructor() {
		super("reset", "POST", "/reset");
	}

	handle({ agent }: ToolRequest): unknown {
		return agent.reset();
	}
}

/** Close the Harness now, for a deterministic pause. */
export class PauseTool extends HttpTool {
	constructor() {
		super("pause", "POST", "/pause");
	}

	handle({ agent }: ToolRequest): unknown {
		return agent.pause();
	}
}

/** Stage the raw bytes of an uploaded document in the workspace. A PDF also
 * gets its text derived into `corpus/text/` so the citation index sees it.
 *
 * No parse beyond that: the response reports what arrived (`sourceSha256`,
 * `path`, `searchable`) so the control plane can record the ingestion event.
 * The workspace owns the bytes; the web app never names a corpus path itself.
 * This tool does not touch the conversation, so an upload cannot defeat the
 * idle pause. `title` and `filename` land in the `corpus/meta/<docId>.json`
 * sidecar the citation store reads (RFC 0006 §5.2). */
export class IngestRawTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("ingest", "POST", "/ingest");
		this.#workspace = workspace;
	}

	async handle({ req, url, agent }: ToolRequest): Promise<unknown> {
		const docId = safeDocId(url.searchParams.get("docId") ?? "");
		const filename = url.searchParams.get("filename") ?? "";
		const title = url.searchParams.get("title") ?? "";
		const bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		if (bytes.length === 0) throw new HttpError(400, { error: "empty_body", message: "the upload is empty" });
		const staged = stageRaw({ workspace: this.#workspace, docId, filename, bytes });
		await writeMeta({ workspace: this.#workspace, docId, meta: { title: title === "" ? filename : title, filename } });
		const derived = await stageDerivedText({ workspace: this.#workspace, docId, filename, bytes });
		agent.noteCorpusChange();
		return { ...staged, searchable: indexedAsText(filename, derived) };
	}
}

/** Read the staged bytes of one document back, for the dashboard preview. */
export class RawFileTool extends HttpTool {
	constructor() {
		super("raw", "GET", "/raw");
	}

	async handle({ agent, url }: ToolRequest): Promise<unknown> {
		const docId = safeDocId(url.searchParams.get("docId") ?? "");
		const filename = url.searchParams.get("filename") ?? "";
		return agent.readFile(rawRelativePath(docId, filename));
	}
}

/** Delete the staged bytes of one document, its sidecar and its derived text. */
export class DeleteRawTool extends HttpTool {
	readonly #workspace: string;

	constructor(workspace: string) {
		super("delete_raw", "DELETE", "/ingest");
		this.#workspace = workspace;
	}

	async handle({ url, agent }: ToolRequest): Promise<unknown> {
		const docId = safeDocId(url.searchParams.get("docId") ?? "");
		const filename = url.searchParams.get("filename") ?? "";
		const removed = removeRaw({ workspace: this.#workspace, docId, filename });
		await removeDerivedText({ workspace: this.#workspace, docId });
		agent.noteCorpusChange();
		return removed;
	}
}
