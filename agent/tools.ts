// Tools: one HTTP operation each — a method, a path, and a handler.

import type { EntryId } from "@earendil-works/pi-durable";
import { HttpError, RawResponse, readBody, readRawBody, safeTreePath } from "./http.ts";
import { derivedTextRelativePath, MAX_UPLOAD_BYTES, rawRelativePath, safeDocId } from "./corpus.ts";
import { IngestPipeline, type IngestTarget } from "./ingest.ts";
import { createUploadDir, listUploadTree } from "./uploads.ts";
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
 * the query, raw bytes as the body. An HTTP adapter over `IngestPipeline`
 * (RFC 0014 R1): parse, stage, `noteCorpusChange`, return the pipeline's
 * `Staged` object verbatim. Never activates the agent. */
export class UploadFileTool extends HttpTool {
	readonly #pipeline: IngestPipeline;

	constructor(pipeline: IngestPipeline) {
		super("uploads_file", "POST", "/uploads/file");
		this.#pipeline = pipeline;
	}

	async handle({ req, url, agent }: ToolRequest): Promise<unknown> {
		const bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		if (bytes.length === 0) throw new HttpError(400, { error: "empty_body", message: "the upload is empty" });
		const staged = await this.#pipeline.stage({ bytes, target: { kind: "tree-path", path: url.searchParams.get("path") ?? "" } });
		agent.noteCorpusChange();
		return staged;
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

/** Remove a file or a whole subtree under `corpus/uploads/` — bytes, derived
 * text, and registry sidecar together (RFC 0014 R9). Never activates the agent. */
export class DeleteUploadTool extends HttpTool {
	readonly #pipeline: IngestPipeline;

	constructor(pipeline: IngestPipeline) {
		super("uploads_delete", "DELETE", "/uploads");
		this.#pipeline = pipeline;
	}

	async handle({ url, agent }: ToolRequest): Promise<unknown> {
		const relative = safeTreePath(url.searchParams.get("path") ?? "");
		await this.#pipeline.remove({ target: { kind: "tree-path", path: relative } });
		agent.noteCorpusChange();
		return { path: `corpus/uploads/${relative}` };
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

/** Apply a delivered provider config (RFC 0012 §5.4). The manager is the
 * only writer of desired state and calls this at resolve time; a user driving
 * their own sandbox's /config directly through /u/<id>/config (same
 * forward_auth wall) can only desync their own runtime until the next resolve
 * overwrites it. Activates the agent: the conversation reconfigure joins the
 * DurableHarness serialization chain, so an in-flight prompt finishes on the
 * old provider (§7.1) and a queued one runs on the new one. The key exists in
 * process memory only (R3). */
export class ConfigTool extends HttpTool {
	constructor() {
		super("config", "POST", "/config");
	}

	async handle({ req, agent }: ToolRequest): Promise<unknown> {
		const body = await readBody(req);
		const provider = body.provider;
		const modelId = body.modelId;
		if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider))
			throw new HttpError(400, { error: "invalid_provider", message: "provider must be 1-64 chars of [a-z0-9-]" });
		if (typeof modelId !== "string" || !(1 <= modelId.length && modelId.length <= 200))
			throw new HttpError(400, { error: "invalid_model", message: "modelId must be 1-200 characters" });
		if (provider === "faux" && modelId !== "faux-1")
			throw new HttpError(400, { error: "invalid_model", message: "the faux provider has exactly one model: faux-1" });
		let apiKey: string | undefined;
		if (body.apiKey !== undefined) {
			if (typeof body.apiKey !== "string" || !(1 <= body.apiKey.length && body.apiKey.length <= 4096))
				throw new HttpError(400, { error: "invalid_api_key", message: "apiKey must be 1-4096 characters" });
			apiKey = body.apiKey;
		}
		let baseUrl: string | undefined;
		if (body.baseUrl !== undefined) {
			if (typeof body.baseUrl !== "string" || !(1 <= body.baseUrl.length && body.baseUrl.length <= 2048))
				throw new HttpError(400, { error: "invalid_base_url", message: "baseUrl must be 1-2048 characters" });
			baseUrl = body.baseUrl;
		}
		try {
			return await agent.configureModel({ provider, modelId, apiKey, baseUrl });
		} catch (error) {
			// buildProvider throws plain Errors (unknown built-in, missing baseUrl);
			// map them to 400 so delivery failures stay actionable.
			if (error instanceof Error && !(error instanceof HttpError))
				throw new HttpError(400, { error: "invalid_provider", message: error.message });
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

/** Stage the raw bytes of an uploaded document in the workspace: an HTTP
 * adapter over `IngestPipeline` (RFC 0014 R1) that parses the query, stages,
 * calls `noteCorpusChange`, and returns the pipeline's `Staged` object
 * verbatim — `searchable`/`indexing` are the ingest-time admission, the same
 * decision the citation index reads from the registry forever after.
 *
 * This tool does not touch the conversation, so an upload cannot defeat the
 * idle pause. The workspace owns the bytes; the web app never names a corpus
 * path itself. */
export class IngestRawTool extends HttpTool {
	readonly #pipeline: IngestPipeline;

	constructor(pipeline: IngestPipeline) {
		super("ingest", "POST", "/ingest");
		this.#pipeline = pipeline;
	}

	async handle({ req, url, agent }: ToolRequest): Promise<unknown> {
		const docId = safeDocId(url.searchParams.get("docId") ?? "");
		const filename = url.searchParams.get("filename") ?? "";
		const title = url.searchParams.get("title") ?? "";
		const bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		if (bytes.length === 0) throw new HttpError(400, { error: "empty_body", message: "the upload is empty" });
		const target: IngestTarget = { kind: "document", docId, filename, title };
		const staged = await this.#pipeline.stage({ bytes, target });
		agent.noteCorpusChange();
		return staged;
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

/** Read the text derived from one staged PDF (`corpus/text/<docId>.txt`), for
 * the dashboard preview. Activates the agent, like `/raw`: it reads through
 * the same env. No derived text (not a PDF, or extraction produced none) is a
 * 404 the caller maps to its own message. */
export class DerivedTextTool extends HttpTool {
	constructor() {
		super("derived_text", "GET", "/text");
	}

	async handle({ agent, url }: ToolRequest): Promise<unknown> {
		const docId = safeDocId(url.searchParams.get("docId") ?? "");
		return agent.readFile(derivedTextRelativePath(docId));
	}
}

/** Delete the staged bytes of one document, its derived text, and its
 * registry sidecar — together (RFC 0014 R9). */
export class DeleteRawTool extends HttpTool {
	readonly #pipeline: IngestPipeline;

	constructor(pipeline: IngestPipeline) {
		super("delete_raw", "DELETE", "/ingest");
		this.#pipeline = pipeline;
	}

	async handle({ url, agent }: ToolRequest): Promise<unknown> {
		const docId = safeDocId(url.searchParams.get("docId") ?? "");
		const filename = url.searchParams.get("filename") ?? "";
		await this.#pipeline.remove({ target: { kind: "document", docId, filename } });
		agent.noteCorpusChange();
		return { docId, path: rawRelativePath(docId, filename) };
	}
}
