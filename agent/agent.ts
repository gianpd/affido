// The container agent: one container's model, registry, workspace, and conversation.
// It runs on the HarnessLifecycle port: `AgentOptions.harness` injects one, and the
// default is a DurableHarness built from the same options.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, SubmissionDraft } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { citationExtension } from "./citation-tools.ts";
import { placeCurrentRun, type CitationRunState } from "./citation-run.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";
import { DurableHarness, type HarnessLifecycle } from "./harness.ts";
import { HttpError, textOf, workspacePath } from "./http.ts";
import { buildSkillHint, renderSkillsSection } from "./skills.ts";
import { describeArtifacts, snapshotArtifacts } from "./artifacts.ts";
import { TraceReader, type TraceEntryDetail, type TraceQuery, type TraceReport, type TraceSource } from "./trace.ts";
import type { CitationsTraceReport } from "./citation-report.ts";
import type { AgentOptions, CitationMode, CitationView, Log, PromptResult, RunCitations } from "./types.ts";
import type { AgentApi } from "./types.ts";

/** The registry every `ContainerAgent` runs on: the coding tools, the citation
 * tools, and the container prompt section. Exported so an injected, real
 * lifecycle (the integration test) installs exactly the same surface. */
/** The server-built container section: identity, tools, uploads location, and
 * the closed toolbox facts (RFC 0009 D3). Exported because the facts the model
 * is told about its runtime are behavior: without the toolbox paragraph the
 * model reaches for pdftotext or Python, neither of which exists here. */
export const containerSection = (name: string, workspace: string): string =>
	`You run inside container ${name}. Your workspace is ${workspace}: it is the working directory of every command you run, and it survives pause and restart.\n` +
	"Your tools are read, write, edit, and bash. Use bash to list and search the workspace, and read to open a file.\n" +
	"The runtime is Node with a closed toolbox. Two libraries are preinstalled and every Node script you run can require() them from any working directory through NODE_PATH: " +
	'docx (Word document generation) and unpdf (PDF text extraction). To read a PDF, run a Node script that loads its bytes and calls unpdf\'s getDocumentProxy and extractText; ' +
	"that extracts the embedded text only, so a scanned image PDF yields none. There is no pdftotext, no Python, no LibreOffice, and no npm/npx/corepack: " +
	"nothing can be installed, so never attempt or suggest installing anything.\n" +
	`Documents the user uploads are stored under ${workspace}/corpus: documents uploaded one by one at corpus/raw/<docId>.<ext> (opaque id, original extension; the title and original filename are not written there) and directory uploads at corpus/uploads/<collection>/<path> (original names and paths). Both are searchable through corpus_grep and corpus_read — a PDF through its extracted text. When a request may refer to an uploaded document, search the corpus first; open the files directly with bash and read only when you need more than the indexed text.`;

export const createAgentRegistry = (options: {
	readonly name: string;
	readonly workspace: string;
	readonly store: WorkspaceCitationStore;
}) => {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(citationExtension({ store: options.store }));
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

	constructor({ name, workspace, sessionDb, idleMs, models, model, thinkingLevel, citationsDefault, context, log, harness }: AgentOptions) {
		this.#name = name;
		this.#workspace = workspace;
		this.#sessionDb = sessionDb;
		this.#model = model;
		this.#context = context;
		this.#log = log;
		this.#citationsDefault = citationsDefault ?? "off";
		// A separate environment for the file API; same local file system id as the tools.
		this.#apiEnv = new NodeExecutionEnv({ cwd: workspace });
		// One citation store per agent: the corpus index is lazy and shared (RFC 0006 §5.2).
		this.#store = new WorkspaceCitationStore(this.#apiEnv, context);

		const registry = createAgentRegistry({ name, workspace, store: this.#store });

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

	async prompt(prompt: string, requestId: string | undefined, citations: CitationMode | undefined): Promise<PromptResult> {
		// §5.9: the mode is a property of the question. The request field wins;
		// `CITATIONS_DEFAULT=required` covers requests that omit it. Explicit "off" beats the default.
		const strict = citations === "required" || (citations === undefined && this.#citationsDefault === "required");
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
			const artifactBaseline = await placeCurrentRun(conversation, runId, strict, prompt, baseline, this.#context);
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
				runId,
				artifacts,
			};
		});
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
		const { conversationId, entries } = await this.#harness.newSession();
		return { agent: this.#name, conversationId, entries };
	}

	/** Make an existing conversation the active one (RFC 0008): resuming a
	 * previous session. The conversation keeps its entries and its chat rows;
	 * nothing is copied, reset, or deleted. */
	async switchSession(conversationId: number) {
		const { conversationId: activeId, entries } = await this.#harness.switchSession(conversationId as ConversationId);
		return { agent: this.#name, conversationId: activeId, entries };
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
