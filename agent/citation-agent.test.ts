// Integration test of RFC 0006 with the real durable lifecycle: a SQLite-backed
// DurableHarness, the same registry `ContainerAgent` builds, and the scripted
// faux model from model.ts driving grep -> read -> annotate -> answer_publish.
// Asserts the envelope field by field, the idempotent replay, the plain exit,
// the trace-only report, and re-verification across a harness restart.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { EntryId } from "@earendil-works/pi-durable";
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
