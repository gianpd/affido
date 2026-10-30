// The container agent: one container's model, registry, workspace, and conversation.
// It runs on the HarnessLifecycle port: `AgentOptions.harness` injects one, and the
// default is a DurableHarness built from the same options.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, SubmissionDraft } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { citationExtension } from "./citation-tools.ts";
import { placeCurrentRun, type CitationRunState } from "./citation-run.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";
import { DurableHarness, type HarnessLifecycle } from "./harness.ts";
import { HttpError, textOf, workspacePath } from "./http.ts";
import { readWebTaintTx, webToolsExtension, websearchUrl } from "./web-tools.ts";
import { buildSkillHint, renderSkillsSection } from "./skills.ts";
import { describeArtifacts, snapshotArtifacts } from "./artifacts.ts";
import { TraceReader, type TraceEntryDetail, type TraceQuery, type TraceReport, type TraceSource } from "./trace.ts";
import type { CitationsTraceReport } from "./citation-report.ts";
import type { AgentOptions, AgentApi, CitationMode, CitationView, Log, PromptResult, ProviderConfig, RunCitations, WebMode } from "./types.ts";
import { configureProvider } from "./model.ts";
import { IngestPipeline } from "./ingest.ts";

/** The registry every `ContainerAgent` runs on: the coding tools, the citation
 * tools, and the container prompt section. Exported so an injected, real
 * lifecycle (the integration test) installs exactly the same surface. */
/** The server-built container section: identity, tools, uploads location, and
 * the closed toolbox facts (RFC 0009 D3). Exported because the facts the model
 * is told about its runtime are behavior: without the toolbox paragraph the
 * model reaches for pdftotext or Python, neither of which exists here. */
export const containerSection = (name: string, workspace: string): string =>
	`You run inside container ${name}. Your workspace is ${workspace}: it is the working directory of every command you run, and it survives pause and restart.\n` +
	"Your core tools are read, write, edit, and bash. Use bash to list and search the workspace, and read to open a file.\n" +
	"The runtime is Node with a closed toolbox. Two libraries are preinstalled and every Node script you run can require() them from any working directory through NODE_PATH: " +
	'docx (Word document generation) and unpdf (PDF text extraction). To read a PDF, run a Node script that loads its bytes and calls unpdf\'s getDocumentProxy and extractText; ' +
	"that extracts the embedded text only, so a scanned image PDF yields none. There is no pdftotext, no Python, no LibreOffice, and no npm/npx/corepack: " +
	"nothing can be installed, so never attempt or suggest installing anything.\n" +
	`Documents the user uploads are stored under ${workspace}/corpus: documents uploaded one by one at corpus/raw/<docId>.<ext> (opaque id, original extension; the title and original filename are not written there) and directory uploads at corpus/uploads/<collection>/<path> (original names and paths). Both are searchable through corpus_grep and corpus_read — a PDF through its extracted text. When a request may refer to an uploaded document, search the corpus first; open the files directly with bash and read only when you need more than the indexed text.`;

export const createAgentRegistry = (options: {
	readonly name: string;
	readonly workspace: string;
	readonly store: WorkspaceCitationStore;
	readonly onWebTaint?: () => void;
}) => {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(citationExtension({ store: options.store, workspace: options.workspace }));
	// RFC 0016 §5: web_search and web_read over the isolated search node; the
	// extension also owns the conversation-scoped taint gate (§6).
	registry.install(webToolsExtension({ onTaint: options.onWebTaint }));
	registry.install(
		defineExtension({
			name: "container",
			sections: [
				section("container", () => containerSection(options.name, options.workspace), { tag: false }),
				// RFC 0009 R3: what is installed, where its SKILL.md is, and where
				// deliverables must land. Omitted entirely when nothing is installed.
					section("skills", () => renderSkillsSection(options.workspace), { tag: false }),
			],
		}),
	);
	return registry;
};

export class ContainerAgent implements AgentApi {
	#name: string;
	#workspace: string;
	#sessionDb: string;
	#model: AgentOptions["model"];
	#context: Context;
	#log: Log;
	#apiEnv: NodeExecutionEnv;
	#harness: HarnessLifecycle;
	#citationsDefault: CitationMode;
	#store: WorkspaceCitationStore;
	#models: MutableModels;
	#credentials: CredentialStore;
	/** sha256(key)[:12] of the delivered key, or null; the only key-derived
	 * value /status reports (RFC 0012 §5.4 step 3). Never the key itself. */
	#keyFingerprint: string | null = null;
	/** RFC 0013 §6.2: where the current selection's key lives — "sidecar"
	 * (this process holds only a placeholder), "direct" (delivered or
	 * secret-file key in memory), or null (faux / keyless). Reported by
	 * /status instead of a fingerprint the agent can no longer compute. */
	#keyVia: "sidecar" | "direct" | null = null;
	/** RFC 0016 §6: whether this conversation ever read web content. Derived
	 * from the durable `web.taint` document, which is never cleared, so the
	 * cache is monotonic: a `true` is permanent, a `false` only means "not
	 * observed yet" and forces a read on the next check. */
	#webTouched = false;
	/** RFC 0016 §7: the node's control token, delivered by the manager at
	 * resolve time. In-memory only; it is what makes a run registration
	 * unforgeable by a bash child of the sandbox. */
	#webControl: string | null = null;

	constructor({ name, workspace, sessionDb, idleMs, models, credentials, model, thinkingLevel, citationsDefault, context, log, harness }: AgentOptions) {
		this.#name = name;
		this.#workspace = workspace;
		this.#sessionDb = sessionDb;
		this.#model = model;
		this.#context = context;
		this.#log = log;
		this.#citationsDefault = citationsDefault ?? "off";
		this.#models = models;
		this.#credentials = credentials;
		// A separate environment for the file API; same local file system id as the tools.
		this.#apiEnv = new NodeExecutionEnv({ cwd: workspace });
		// One citation store per agent: the corpus index is lazy and shared (RFC 0006 §5.2).
		// Its first build runs the registry migration pass (RFC 0014 §6) once.
		const pipeline = new IngestPipeline(workspace);
		this.#store = new WorkspaceCitationStore(this.#apiEnv, context, () => pipeline.bootstrap((message) => this.#log(message)));

		const registry = createAgentRegistry({
			name,
			workspace,
			store: this.#store,
			onWebTaint: () => {
				this.#webTouched = true;
			},
		});

		// The lifecycle is a port: the caller may inject one (tests substitute a fake);
		// the default is the durable implementation assembled from the same options.
		this.#harness =
			harness ??
			new DurableHarness({
				openOptions: {
					models,
					registry,
					// The Harness builds one environment per tool call, always rooted in the workspace.
					env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
				},
				rootOptions: {
					agent: { model, cwd: workspace, thinkingLevel: thinkingLevel ?? "off" },
				},
				context,
				sessionDb,
				idleMs,
				log,
			});
	}

	get name(): string {
		return this.#name;
	}

	get paused(): boolean {
		return this.#harness.paused;
	}

	status() {
		return {
			agent: this.#name,
			paused: this.#harness.paused,
			model: this.#model,
			keyFingerprint: this.#keyFingerprint,
			keyVia: this.#keyVia,
			// RFC 0016 §7: whether the manager delivered the web control token.
			// A boolean, never the token.
			webControl: this.#webControl !== null,
			workspace: this.#workspace,
			sessionDb: this.#sessionDb,
			conversationId: this.#harness.conversationId,
			entries: this.#harness.entries,
			inFlight: this.#harness.inFlight,
		};
	}

	async seedWorkspace(): Promise<void> {
		await mkdir(this.#workspace, { recursive: true });
		if ((await readdir(this.#workspace)).length > 0) return;
		await writeFile(join(this.#workspace, "README.md"), `# Workspace of ${this.#name}\n`);
		await writeFile(join(this.#workspace, "notes.txt"), `This workspace belongs to ${this.#name}.\n`);
		await writeFile(join(this.#workspace, "data.txt"), "1\n2\n3\n");
		this.#log("seeded workspace");
	}

	async prompt(
		prompt: string,
		requestId: string | undefined,
		citations: CitationMode | undefined,
		web: WebMode = "off",
	): Promise<PromptResult> {
		// §5.9: the mode is a property of the question. The request field wins;
		// `CITATIONS_DEFAULT=required` covers requests that omit it. Explicit "off" beats the default.
		const strict = citations === "required" || (citations === undefined && this.#citationsDefault === "required");
		// RFC 0016 §7: web is opt-in per submission, never a standing capability.
		const webAllowed = web === "allowed";
		const runId = requestId ?? `run-${crypto.randomUUID()}`;
		// RFC 0009 D4: a leading `/name` becomes a server-built hint inside the
		// stored content — durable, visible in the trace, never model-invented.
		const hint = await buildSkillHint({ workspace: this.#workspace, prompt });
		const content = hint === null ? prompt : hint.content;
		return this.#harness.activate(async (conversation) => {
			// The run pointer is placed at admission: the tools and hooks resolve the
				// run through it, never from a model-supplied id. The application input
			// entry below carries the same runId and keys the idempotent replay.
			// The artifact baseline of §5.7 travels with it, so a replay re-derives
			// the same artifact list instead of diffing against a fresh snapshot.
			const baseline = Object.fromEntries(await snapshotArtifacts({ workspace: this.#workspace }));
			// Register the run with the search node before the model can act. The
			// node only accepts the registration with the manager-delivered
			// control token, and returns the per-run token the tools must send.
			const webToken = webAllowed ? await this.#registerWebRun(runId) : null;
			const artifactBaseline = await placeCurrentRun(
				conversation,
				runId,
				strict,
				prompt,
				baseline,
				{ web: webAllowed, webToken },
				this.#context,
			);
			const draft: SubmissionDraft = strict
				? { type: "input", content, requestId: runId, entry: { kind: "citations.strict", data: { requestId: runId } } }
				: requestId === undefined
					? { type: "input", content }
					: { type: "input", content, requestId };
			const settled = await (await conversation.submit(draft, this.#context)).wait(this.#context);
			let answer: string | null = null;
			if (settled.status === "done" && settled.type === "input") {
				const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), this.#context);
				answer = textOf(entry?.model?.[0]);
			}
			// The run's artifacts, diffed from the admission baseline (R7).
			const artifacts = await describeArtifacts({ workspace: this.#workspace, baseline: artifactBaseline });
			// Read the run's exit through the read-only trace path: a nested
			// `trace()` reuses the open conversation and never writes.
			const state = await this.#harness.trace((source) => source.runState(conversation.id, runId, this.#context));
			const envelope = await this.#envelope(state, strict, runId, answer, settled.status, settled.status === "unanswered" ? settled.reason : null);
			await this.#harness.refreshStats();
			return {
				agent: this.#name,
				status: settled.status,
				reason: settled.status === "unanswered" ? settled.reason : null,
				// The stored detail says WHY a model_error happened; the reason alone says nothing.
				reasonDetail:
					settled.status === "unanswered"
						? typeof settled.detail === "string"
							? settled.detail
							: settled.detail === undefined
								? null
								: JSON.stringify(settled.detail)
						: null,
				answer: envelope.answer,
				submissionId: settled.id,
				requestId: requestId ?? null,
				conversationId: conversation.id,
				entries: this.#harness.entries,
				evidence: envelope.evidence,
				evidenceReason: envelope.evidenceReason,
				citations: envelope.citations,
				citationsMode: strict ? "required" : "free",
				webMode: webAllowed ? "allowed" : "off",
				runId,
				artifacts,
			};
		});
	}

	/** Register one run with the node, using the manager-delivered control
	 * token. Returns the per-run token, or null when web is unavailable; the
	 * prompt still runs, and the web tools answer a named error. */
	async #registerWebRun(runId: string): Promise<string | null> {
		const base = websearchUrl();
		if (this.#webControl === null || base === "") {
			this.#log("web run not registered: no control token (manager delivery or WEBSEARCH_URL missing)");
			return null;
		}
		try {
			const response = await fetch(`${base}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-control-token": this.#webControl, "x-run-id": runId },
				body: JSON.stringify({ web: true }),
				redirect: "error",
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) {
				this.#log(`web run registration refused: ${response.status}`);
				return null;
			}
			const body = (await response.json()) as { runToken?: unknown };
			if (typeof body.runToken !== "string" || body.runToken === "") {
				this.#log("web run registration returned no token");
				return null;
			}
			return body.runToken;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.#log(`web run registration failed: ${reason}`);
			return null;
		}
	}

	/** The server-built evidence fields of the reply (§5.5): the model never writes them. */
	async #envelope(
		state: CitationRunState | undefined,
		strict: boolean,
		runId: string,
		textAnswer: string | null,
		status: string,
		unansweredReason: string | null,
	): Promise<{ answer: string | null; evidence: "cited" | "plain" | "none"; evidenceReason: string | null; citations: readonly CitationView[] }> {
		if (state === undefined) {
			// `placeCurrentRun` creates the doc before submit; if it is somehow absent, a
			// strict run never got its exit and a free run simply answered free-form.
			return strict
				? { answer: textAnswer, evidence: "none", evidenceReason: "run state missing", citations: [] }
				: { answer: textAnswer, evidence: "plain", evidenceReason: null, citations: [] };
		}
		if (state.published !== null) {
			return {
				answer: state.published.markdown,
				evidence: "cited",
				evidenceReason: null,
				citations: await this.#citationViews(state.published.citationIds, state),
			};
		}
		if (state.plain !== null) {
			return { answer: state.plain, evidence: "plain", evidenceReason: null, citations: [] };
		}
		if (!strict) {
			// A free run keeps today's exit: the free-form answer, with no evidence claim.
			return { answer: textAnswer, evidence: "plain", evidenceReason: null, citations: [] };
		}
		const used = Object.keys(state.annotations);
		const evidenceReason =
			status !== "done"
				? (unansweredReason ?? "unanswered")
				: used.length > 0
					? "replied_without_citations"
					: "no_gate_exit";
		return { answer: textAnswer, evidence: "none", evidenceReason, citations: [] };
	}

	/** Map citation ids to the wire view, in publish order; title/filename come from the corpus metadata. */
	async #citationViews(ids: readonly string[], state: CitationRunState): Promise<readonly CitationView[]> {
		const documents = new Map((await this.#store.documents()).map((document) => [document.docId, document]));
		return ids
			.map((id) => state.annotations[id])
			.filter((annotation): annotation is NonNullable<typeof annotation> => annotation !== undefined)
			.map((annotation) => {
				const document = documents.get(annotation.docId);
			return {
					citationId: annotation.citationId,
					docId: annotation.docId,
					title: document?.title ?? annotation.docId,
					filename: document?.filename ?? annotation.docId,
					version: annotation.docVersion,
					start: annotation.start,
					end: annotation.end,
					line: annotation.line,
					quote: annotation.quote,
					textSha256: annotation.textSha256,
					status: "attribution_verified",
				};
			});
	}

	/** One run's citations, each re-verified against the text on disk now (R11). */
	async citations(runId: string): Promise<RunCitations> {
		return this.#harness.trace(async (source) => {
			const conversationId = this.#harness.conversationId;
			if (conversationId === null) throw new HttpError(404, { error: "not_found", message: "no open conversation" });
			const state = await source.runState(conversationId, runId, this.#context);
			if (state === undefined) throw new HttpError(404, { error: "not_found", message: `no citation run ${runId}` });
			const documents = new Map((await this.#store.documents()).map((document) => [document.docId, document]));
			const citations = await Promise.all(
				Object.values(state.annotations).map(async (annotation) => {
					const verified = await this.#store.verify(annotation);
					const document = documents.get(annotation.docId);
					return {
						citationId: annotation.citationId,
						docId: annotation.docId,
						title: document?.title ?? annotation.docId,
						filename: document?.filename ?? annotation.docId,
						version: annotation.docVersion,
						start: annotation.start,
						end: annotation.end,
						line: annotation.line,
						quote: annotation.quote,
						textSha256: annotation.textSha256,
						status: verified.status,
					};
				}),
			);
			return { agent: this.#name, runId, strict: state.strict, published: state.published !== null, citations };
		});
	}

	noteCorpusChange(): void {
		this.#store.invalidate();
	}

	/** RFC 0016 §6: has this conversation read web content? The durable taint
	 * document is the source of truth; the cache only avoids opening storage on
	 * every ingest/upload/skills call. A fresh process reads it once, which is
	 * why those routes now activate the agent when the cache is cold. */
	async webTainted(): Promise<boolean> {
		if (this.#webTouched) return true;
		const touched = await this.#harness.activate(async (conversation) => {
			const taint = await conversation.commit((tx) => readWebTaintTx(tx, conversation.id), this.#context);
			return taint.touched;
		});
		this.#webTouched = touched;
		return touched;
	}

	async listDir(path: string) {
		return this.#harness.activate(async () => {
			const result = await this.#apiEnv.listDir(workspacePath(this.#workspace, path), this.#context);
			if (!result.ok) throw new HttpError(404, { error: result.error.code, message: result.error.message });
			const entries = result.value
				.map((info) => ({ name: info.name, kind: info.kind, size: info.size }))
				.sort((a, b) => a.name.localeCompare(b.name));
			return { agent: this.#name, path, entries };
		});
	}

	async readFile(path: string) {
		return this.#harness.activate(async () => {
			const result = await this.#apiEnv.readTextFile(workspacePath(this.#workspace, path), this.#context);
			if (!result.ok) throw new HttpError(404, { error: result.error.code, message: result.error.message });
			return { agent: this.#name, path, content: result.value };
		});
	}

	async session() {
		return this.#harness.activate(async (conversation) => {
			await this.#harness.refreshStats();
			return {
				agent: this.#name,
				conversationId: conversation.id,
				entries: this.#harness.entries,
				paused: false,
			};
		});
	}

	/** Start a separate conversation and make it the active one; the previous stays fully readable. */
	async newSession() {
		this.#webTouched = false;
		const { conversationId, entries } = await this.#harness.newSession();
		return { agent: this.#name, conversationId, entries };
	}

	/** Make an existing conversation the active one (RFC 0008): resuming a
	 * previous session. The conversation keeps its entries and its chat rows;
	 * nothing is copied, reset, or deleted. */
	async switchSession(conversationId: number) {
		this.#webTouched = false;
		const { conversationId: activeId, entries } = await this.#harness.switchSession(conversationId as ConversationId);
		return { agent: this.#name, conversationId: activeId, entries };
	}

	/** RFC 0012 §5.4 / RFC 0013 §6.2: apply a delivered provider config. The
	 * credential and provider upserts land on the shared collection first; the
	 * harness then pins the active conversation to the new ModelRef on its
	 * serialization chain (§7.1). In sidecar mode the only "credential" that
	 * reaches this process is the placeholder — the key itself lives in the
	 * sidecar container (R1). */
	async configureWeb(controlToken: string) {
		if (typeof controlToken !== "string" || controlToken.length < 32 || controlToken.length > 128) {
			throw new HttpError(400, {
				error: "invalid_control_token",
				message: "controlToken must be 32-128 characters",
			});
		}
		this.#webControl = controlToken;
		// Never echo the token: only the fact that the delivery landed.
		return { agent: this.#name, webControl: true };
	}

	async configureModel({ provider, modelId, apiKey, baseUrl, viaSidecar }: ProviderConfig) {
		const applied = await configureProvider(this.#models, this.#credentials, {
			id: provider,
			modelId,
			baseUrl,
			apiKey,
			viaSidecar,
		});
		this.#model = applied.model;
		this.#keyFingerprint = applied.fingerprint;
		this.#keyVia = applied.keyVia;
		await this.#harness.configureModel(applied.model);
		return { agent: this.#name, model: this.#model, keyFingerprint: this.#keyFingerprint, keyVia: this.#keyVia };
	}

	/** Start a new context: older entries stay in storage, the model stops seeing them. */
	async reset() {
		return this.#harness.activate(async (conversation) => {
			await conversation.reset(undefined, this.#context);
			await this.#harness.refreshStats();
			return {
				agent: this.#name,
				conversationId: conversation.id,
				entries: this.#harness.entries,
			};
		});
	}

	async inspect(query: TraceQuery): Promise<TraceReport | CitationsTraceReport> {
		const paused = this.#harness.paused;
		return this.#harness.trace((source) => this.#traceReader(source, paused).report(query));
	}

	/** One entry as stored: the messages the model saw, tool results and thinking included. */
	async inspectEntry(id: EntryId): Promise<TraceEntryDetail> {
		const paused = this.#harness.paused;
		return this.#harness.trace((source) => this.#traceReader(source, paused).entry(id));
	}

	/** `paused` is the state at request arrival: `trace()` itself activates the sandbox. */
	#traceReader(source: TraceSource, paused: boolean): TraceReader {
		const conversationId = this.#harness.conversationId;
		if (conversationId === null) throw new Error("trace read without an open conversation");
		return new TraceReader({
			source,
			context: this.#context,
			agent: this.#name,
			paused,
			defaultConversationId: conversationId,
		});
	}

	async pause() {
		if (this.#harness.inFlight > 0) throw new HttpError(409, { error: "agent is busy" });
		await this.#harness.close();
		return { agent: this.#name, paused: true };
	}

	async close(): Promise<void> {
		await this.#harness.close();
	}
}
