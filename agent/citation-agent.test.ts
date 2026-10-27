// Integration test of RFC 0006 with the real durable lifecycle: a SQLite-backed
// DurableHarness, the same registry `ContainerAgent` builds, and the scripted
// faux model from model.ts driving grep -> read -> annotate -> answer_publish.
// Asserts the envelope field by field, the idempotent replay, the plain exit,
// the trace-only report, and re-verification across a harness restart; the
// strict exits of §7 (answer_plain both ways, corpus budget, yield bounce)
// drive their own scripted models at the end of this file.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { EntryId } from "@earendil-works/pi-durable";
import type { AssistantMessage, JsonObject, Message } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { MAX_CORPUS_CALLS } from "./citation-tools.ts";
import { ContainerAgent, createAgentRegistry } from "./agent.ts";
import { DurableHarness } from "./harness.ts";
import { createModel } from "./model.ts";
import { IngestPipeline, readSidecar } from "./ingest.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";
import type { TraceReport } from "./trace.ts";
import type { CitationsTraceReport } from "./citation-report.ts";
import type { PromptResult, RunCitations } from "./types.ts";

const CONTRACT = [
	"# Contratto di manutenzione",
	"",
	"## Rinnovo",
	"Il contratto si rinnova tacitamente il 1° marzo 2027.",
	"La disdetta deve essere comunicata 90 giorni prima.",
].join("\n");

type Fixture = { agent: ContainerAgent; workspace: string; sessionDb: string };

const buildAgent = async (workspace: string, sessionDb: string, bundle: Awaited<ReturnType<typeof createModel>>): Promise<Fixture> => {
	const { models, credentials, model } = bundle;
	const context = BACKGROUND_CONTEXT;
	const apiEnv = new NodeExecutionEnv({ cwd: workspace });
	const store = new WorkspaceCitationStore(apiEnv, context);
	const harness = new DurableHarness({
		openOptions: {
			models,
			registry: createAgentRegistry({ name: "test", workspace, store }),
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
		},
		rootOptions: { agent: { model, cwd: workspace, thinkingLevel: "off" as const } },
		context,
		sessionDb,
		idleMs: 60_000,
		log: () => {},
	});
	const agent = new ContainerAgent({
		name: "test",
		workspace,
		sessionDb,
		idleMs: 60_000,
		models,
		credentials,
		model,
		context,
		log: () => {},
		harness,
	});
	return { agent, workspace, sessionDb };
};

test("a strict run publishes through the gate and reports its citations", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-agent-"));
	const sessionDb = join(workspace, "session.sqlite");
	const bundle = await createModel();
	const pipeline = new IngestPipeline(workspace);
	await pipeline.stage({
		bytes: new TextEncoder().encode(CONTRACT),
		target: { kind: "document", docId: "doc_42", filename: "contratto.md", title: "Contratto di manutenzione" },
	});

	const { agent } = await buildAgent(workspace, sessionDb, bundle);
	await agent.seedWorkspace();

	const result = (await agent.prompt("When does the maintenance contract renew?", "req-strict-1", "required")) as PromptResult;

	assert.equal(result.status, "done");
	assert.equal(result.evidence, "cited");
	assert.equal(result.citationsMode, "required");
	assert.equal(result.runId, "req-strict-1");
	assert.ok(result.answer?.startsWith("## Renewal"), result.answer ?? "no answer");
	// R5/R6: the tokens in the answer are exactly the reported ids.
	const token = result.citations[0]?.citationId ?? "";
	assert.notEqual(token, "");
	assert.ok(result.answer?.includes(`[${token}]`));
	assert.equal(result.citations.length, 1);
	assert.deepEqual(
		{
			docId: result.citations[0]?.docId,
			title: result.citations[0]?.title,
			filename: result.citations[0]?.filename,
			version: result.citations[0]?.version,
			line: result.citations[0]?.line,
			quote: result.citations[0]?.quote,
			status: result.citations[0]?.status,
		},
		{
			docId: "doc_42",
			title: "Contratto di manutenzione",
			filename: "contratto.md",
			version: 1,
			line: 4,
			quote: "Il contratto si rinnova tacitamente il 1° marzo 2027.",
			status: "attribution_verified",
		},
	);

	// Idempotent by requestId: the replay returns the same submission, never a second run.
	const replay = (await agent.prompt("When does the maintenance contract renew?", "req-strict-1", "required")) as PromptResult;
	assert.equal(replay.submissionId, result.submissionId);
	assert.equal(replay.evidence, "cited");
	assert.equal(replay.citations[0]?.citationId, token);

	// A free run on the same conversation keeps today's free-form exit.
	const free = (await agent.prompt("list the files", "req-free-1", "off")) as PromptResult;
	assert.equal(free.status, "done");
	assert.equal(free.evidence, "plain");
	assert.deepEqual(free.citations, []);
	assert.ok(free.answer !== null && free.answer.length > 0);

	// The report recomputes used/reported/exact from stored state alone (R10).
	const report = (await agent.inspect({ limit: 50, report: "citations" })) as CitationsTraceReport;
	const strictRun = report.runs.find((run) => run.runId === "req-strict-1");
	assert.notEqual(strictRun, undefined);
	assert.equal(strictRun?.published, true);
	assert.equal(strictRun?.exact, true);
	assert.deepEqual(strictRun?.unreportedUsed, []);
	assert.deepEqual(strictRun?.padded, []);
	assert.equal(report.citationExactness, 1);

	// R11: after close and reopen on the same storage, citations re-verify.
	await agent.close();
	const reopened = await buildAgent(workspace, sessionDb, bundle);
	const verified = (await reopened.agent.citations("req-strict-1")) as RunCitations;
	assert.equal(verified.published, true);
	assert.equal(verified.citations[0]?.status, "attribution_verified");
	assert.equal(verified.citations[0]?.line, 4);
	await reopened.agent.close();
});

// ── RFC 0014 §5.7: the strict tool gate and corpus integrity ─────────────────

/** The strict prompt that makes the scripted model try `bash` first (§7 d). */
const BASH_FIRST = "When does the maintenance contract renew? Check with bash first.";

test("a strict run refuses the workspace tools with a named block and proceeds through the corpus tools (R11)", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-gate-"));
	const sessionDb = join(workspace, "session.sqlite");
	const bundle = await createModel();
	const pipeline = new IngestPipeline(workspace);
	await pipeline.stage({
		bytes: new TextEncoder().encode(CONTRACT),
		target: { kind: "document", docId: "doc_42", filename: "contratto.md", title: "Contratto di manutenzione" },
	});
	const { agent } = await buildAgent(workspace, sessionDb, bundle);
	await agent.seedWorkspace();

	const result = (await agent.prompt(BASH_FIRST, "req-gate-1", "required")) as PromptResult;
	assert.equal(result.status, "done");
	assert.equal(result.evidence, "cited", "the blocked bash must redirect to the corpus tools");
	assert.equal(result.citations[0]?.docId, "doc_42");

	// The named block is in the trace: the bash call was refused before intent.
	const report = (await agent.inspect({ limit: 50 })) as TraceReport;
	const blocked = report.entries.items.find(
		(entry) => entry.role === "toolResult" && entry.toolName === "bash" && entry.isError === true,
	);
	assert.notEqual(blocked, undefined, "the refused bash call must appear as an error tool result");
	const detail = await agent.inspectEntry(blocked?.id as EntryId);
	const text = JSON.stringify(detail.messages);
	assert.match(text, /disabled in this strict-citations run/);
	assert.match(text, /corpus_grep/);
	await agent.close();
});

test("a free run keeps the full toolbox: a write outside corpus/ succeeds (R11)", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-gate-"));
	const sessionDb = join(workspace, "session.sqlite");
	const bundle = await createModel();
	const { agent } = await buildAgent(workspace, sessionDb, bundle);
	await agent.seedWorkspace();

	const result = (await agent.prompt("write a workspace note", "req-gate-2", "off")) as PromptResult;
	assert.equal(result.status, "done");
	const note = await readFile(join(workspace, "workspace/notes.md"), "utf8").catch(() => null);
	assert.equal(note, "note");
	await agent.close();
});

test("write into corpus/ is refused in every run, free included (R12)", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-gate-"));
	const sessionDb = join(workspace, "session.sqlite");
	const bundle = await createModel();
	const pipeline = new IngestPipeline(workspace);
	await pipeline.stage({
		bytes: new TextEncoder().encode(CONTRACT),
		target: { kind: "document", docId: "doc_42", filename: "contratto.md", title: "Contratto di manutenzione" },
	});
	const { agent } = await buildAgent(workspace, sessionDb, bundle);
	await agent.seedWorkspace();

	const result = (await agent.prompt("write into the corpus", "req-gate-3", "off")) as PromptResult;
	assert.equal(result.status, "done");
	// Nothing landed under corpus/ and the staged document is untouched.
	const planted = await readFile(join(workspace, "corpus/uploads/facts.md"), "utf8").catch(() => null);
	assert.equal(planted, null, "a corpus write must never land");
	assert.notEqual(await readSidecar(workspace, "doc_42"), null);

	// And in a strict run, the same write is refused by the strict gate itself.
	const strict = (await agent.prompt("write into the corpus", "req-gate-4", "required")) as PromptResult;
	assert.equal(strict.status, "done");
	await agent.close();
});

test("evidence tampered between runs stops being evidence: the next build drops it and the citation re-verifies not_found (R12)", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-gate-"));
	const sessionDb = join(workspace, "session.sqlite");
	const bundle = await createModel();
	const pipeline = new IngestPipeline(workspace);
	await pipeline.stage({
		bytes: new TextEncoder().encode(CONTRACT),
		target: { kind: "document", docId: "doc_42", filename: "contratto.md", title: "Contratto di manutenzione" },
	});
	const { agent } = await buildAgent(workspace, sessionDb, bundle);
	await agent.seedWorkspace();

	const result = (await agent.prompt("When does the maintenance contract renew?", "req-gate-5", "required")) as PromptResult;
	assert.equal(result.evidence, "cited");

	// Tamper with the staged bytes behind the pipeline's back (a free-run shell
	// could). The live agent's lazy index still holds the old text; the next
	// build — here a restart, in production any noteCorpusChange — is where the
	// registry's hash check drops the document (§5.7.2).
	await writeFile(join(workspace, "corpus/raw/doc_42.md"), `${CONTRACT}\nAnnullato.`);
	await agent.close();

	const reopened = await buildAgent(workspace, sessionDb, bundle);
	const verified = (await reopened.agent.citations("req-gate-5")) as RunCitations;
	assert.equal(verified.citations[0]?.status, "not_found", "a mutated document is no longer evidence");
	await reopened.agent.close();
});

// ── The strict exits of RFC 0006 §7 that no test covered: answer_plain both
// ways, the corpus-call budget, and the plain-text yield bounce. Each of the
// last three drives its own scripted faux model, so the shared transcript in
// model.ts stays untouched; the tools, gate and hooks are the shipped ones. ──

/** The newest toolResult of any tool, as the scripts see it. */
const lastToolResult = (messages: readonly Message[]): { name: string; text: string; isError: boolean } | undefined => {
	const last = messages.at(-1);
	if (last === undefined || last.role !== "toolResult" || !Array.isArray(last.content)) return undefined;
	return {
		name: last.toolName,
		text: last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
		isError: last.isError === true,
	};
};

/** The newest toolResult of `name`, wherever it sits in the transcript. */
const lastResultOf = (messages: readonly Message[], name: string): { text: string; isError: boolean } | undefined => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined || message.role !== "toolResult" || message.toolName !== name || !Array.isArray(message.content)) continue;
		return {
			text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
			isError: message.isError === true,
		};
	}
	return undefined;
};

/** The arguments of the newest assistant call of `name` (mirrors model.ts). */
const lastToolArgs = (messages: readonly Message[], name: string): Record<string, unknown> | undefined => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of [...message.content].reverse()) {
			if (part.type === "toolCall" && part.name === name) return part.arguments as Record<string, unknown>;
		}
	}
	return undefined;
};

let callSeq = 0;
const call = (name: string, args: JsonObject): AssistantMessage =>
	fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${callSeq++}` })], { stopReason: "toolUse" });

/** A faux bundle whose every model call runs `script`, plus the provider state
 * (callCount) so a test can assert how many times the model was asked. */
const scriptedBundle = (script: FauxResponseFactory) => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 1_000 }, () => script));
	models.setProvider(faux.provider);
	return { bundle: { models, credentials, model: { provider: "faux", modelId: "faux-1" } }, state: faux.state };
};

const stagedFixture = async (prefix: string, bundle: Awaited<ReturnType<typeof createModel>>) => {
	const workspace = await mkdtemp(join(tmpdir(), prefix));
	const sessionDb = join(workspace, "session.sqlite");
	await new IngestPipeline(workspace).stage({
		bytes: new TextEncoder().encode(CONTRACT),
		target: { kind: "document", docId: "doc_42", filename: "contratto.md", title: "Contratto di manutenzione" },
	});
	const { agent } = await buildAgent(workspace, sessionDb, bundle);
	await agent.seedWorkspace();
	return agent;
};

test("a strict run with no corpus evidence exits through answer_plain with an empty ledger", async () => {
	// No document staged: the fixture must not go through stagedFixture, which
	// always stages the CONTRACT.
	const workspace = await mkdtemp(join(tmpdir(), "citation-plain-"));
	const sessionDb = join(workspace, "session.sqlite");
	const { agent } = await buildAgent(workspace, sessionDb, await createModel());
	await agent.seedWorkspace();

	// The shared script's grep misses (not_found) and it takes the honest plain
	// exit instead of citing nothing.
	const result = (await agent.prompt("When does the maintenance contract renew?", "req-plain-1", "required")) as PromptResult;
	assert.equal(result.status, "done");
	assert.equal(result.evidence, "plain");
	assert.equal(result.evidenceReason, null);
	assert.deepEqual(result.citations, []);
	assert.equal(result.answer, "UNANSWERED: the corpus does not contain the renewal date.");

	const report = (await agent.inspect({ limit: 50, report: "citations" })) as CitationsTraceReport;
	const run = report.runs.find((candidate) => candidate.runId === "req-plain-1");
	assert.notEqual(run, undefined);
	assert.equal(run?.plain, true);
	assert.equal(run?.published, false);
	assert.equal(run?.corpusCalls, 1); // the one grep that missed
	await agent.close();
});

const PLAIN_DODGE = "The maintenance contract renews tacitly on 1 March 2027.";

/** grep -> read -> annotate, then the dodge answer_plain the exit rule refuses. */
const dodgeScript: FauxResponseFactory = (transcript) => {
	const tool = lastToolResult(transcript.messages);
	if (tool === undefined) return call("corpus_grep", { pattern: "rinnova" });
	if (tool.name === "corpus_grep" && !tool.isError) {
		const hit = (JSON.parse(tool.text) as { hits: { docId: string; text: string }[] }).hits[0];
		if (hit !== undefined) return call("corpus_read", { docId: hit.docId, needle: hit.text });
	}
	if (tool.name === "corpus_read" && !tool.isError) {
		const args = lastToolArgs(transcript.messages, "corpus_read");
		if (typeof args?.docId === "string" && typeof args?.needle === "string") {
			return call("corpus_annotate", { docId: args.docId, docVersion: 1, kind: "quote", citation: { text: args.needle } });
		}
	}
	if (tool.name === "corpus_annotate" && !tool.isError) {
		// Evidence exists; the model tries the plain exit anyway (R8's dodge).
		return call("answer_plain", { markdown: PLAIN_DODGE });
	}
	if (tool.name === "answer_plain" && tool.isError) {
		// Refused with citations_unused: the only way out is the gate itself.
		const annotate = lastResultOf(transcript.messages, "corpus_annotate");
		const citationId = annotate === undefined ? "" : (JSON.parse(annotate.text) as { citationId: string }).citationId;
		return call("answer_publish", {
			markdown: `## Renewal\n\n${PLAIN_DODGE} [${citationId}].\n`,
			citationIds: [citationId],
		});
	}
	return fauxAssistantMessage([fauxText("The script reached an unexpected state.")]);
};

test("answer_plain after a verified annotation is refused with citations_unused", async () => {
	const { bundle } = scriptedBundle(dodgeScript);
	const agent = await stagedFixture("citation-dodge-", bundle);

	const result = (await agent.prompt("When does the maintenance contract renew?", "req-dodge-1", "required")) as PromptResult;
	assert.equal(result.status, "done");
	assert.equal(result.evidence, "cited");
	const token = result.citations[0]?.citationId ?? "";
	assert.notEqual(token, "");
	assert.ok(result.answer?.includes(`[${token}]`));

	const report = (await agent.inspect({ limit: 50, report: "citations" })) as CitationsTraceReport;
	const run = report.runs.find((candidate) => candidate.runId === "req-dodge-1");
	assert.notEqual(run, undefined);
	assert.equal(run?.published, true);
	assert.equal(run?.publishRejected.citations_unused, 1);
	assert.equal(run?.used.length, 1);
	assert.equal(run?.exact, true);
	await agent.close();
});

/** Burns the corpus budget: one grep per turn until the 49th is refused. */
const budgetScript: FauxResponseFactory = (transcript) => {
	const tool = lastToolResult(transcript.messages);
	if (tool !== undefined && tool.isError && tool.text.includes("turn_budget_exhausted")) {
		return call("answer_plain", { markdown: "UNANSWERED: the corpus-call budget was spent before the renewal date was found." });
	}
	return call("corpus_grep", { pattern: "rinnova" });
};

test("the 49th corpus call is refused with turn_budget_exhausted and the run ends visibly", async () => {
	const { bundle } = scriptedBundle(budgetScript);
	const agent = await stagedFixture("citation-budget-", bundle);

	const result = (await agent.prompt("When does the maintenance contract renew?", "req-budget-1", "required")) as PromptResult;
	assert.equal(result.status, "done");
	assert.equal(result.evidence, "plain", "budget exhaustion is a visible exit, never a silent hang");
	assert.ok(result.answer?.startsWith("UNANSWERED: the corpus-call budget"));

	const report = (await agent.inspect({ limit: 200, report: "citations" })) as CitationsTraceReport;
	const run = report.runs.find((candidate) => candidate.runId === "req-budget-1");
	assert.notEqual(run, undefined);
	assert.equal(run?.corpusCalls, MAX_CORPUS_CALLS + 1); // 48 served, the 49th counted and refused

	// The refusal itself is in the trace: exactly one refused grep, 48 served.
	const trace = (await agent.inspect({ limit: 200 })) as TraceReport;
	const greps = trace.entries.items.filter((entry) => entry.role === "toolResult" && entry.toolName === "corpus_grep");
	assert.equal(greps.length, MAX_CORPUS_CALLS + 1);
	const refused = greps.filter((entry) => entry.isError === true);
	assert.equal(refused.length, 1);
	const detail = await agent.inspectEntry(refused[0]?.id as EntryId);
	const text = JSON.stringify(detail.messages);
	assert.match(text, /turn_budget_exhausted/);
	assert.match(text, /budget of 48/);
	await agent.close();
});

const PROSE = "The maintenance contract renews tacitly on 1 March 2027, answered from memory.";

/** Never calls a tool: every model call yields bare prose. */
const proseScript: FauxResponseFactory = () => fauxAssistantMessage([fauxText(PROSE)]);

test("a bare-text strict answer is bounced twice, then ends evidence none with no_gate_exit", async () => {
	const { bundle, state } = scriptedBundle(proseScript);
	const agent = await stagedFixture("citation-prose-", bundle);

	const result = (await agent.prompt(
		"When does the maintenance contract renew? Answer from memory.",
		"req-prose-1",
		"required",
	)) as PromptResult;
	assert.equal(result.status, "done");
	assert.equal(result.answer, PROSE);
	assert.equal(result.evidence, "none");
	assert.equal(result.evidenceReason, "no_gate_exit");
	assert.deepEqual(result.citations, []);
	assert.equal(state.callCount, 3, "one yield plus two bounces; the third yield is let through");

	const report = (await agent.inspect({ limit: 50, report: "citations" })) as CitationsTraceReport;
	const run = report.runs.find((candidate) => candidate.runId === "req-prose-1");
	assert.notEqual(run, undefined);
	assert.equal(run?.published, false);
	assert.equal(run?.plain, false);
	assert.equal(run?.corpusCalls, 0);
	await agent.close();
});
