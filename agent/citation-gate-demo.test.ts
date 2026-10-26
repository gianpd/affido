// The citation-gate demo transcript (agent/citation-gate-demo.ts) driven through
// the real durable lifecycle: a tampered quote dies at corpus_annotate, the
// publish attempt that follows dies at answer_publish, the run ends unpublished;
// the second question copies the stored line and publishes through the gate.
//
// This is the fixture behind the launch recording: it proves the rejection comes
// from the gate, not from the script — the script only proposes text.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ContainerAgent, createAgentRegistry } from "./agent.ts";
import { DurableHarness } from "./harness.ts";
import { createModel } from "./model.ts";
import { writeMeta } from "./corpus.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";
import type { CitationsTraceReport } from "./citation-report.ts";
import type { PromptResult } from "./types.ts";

/** Fictional on purpose: the demo document carries no real contract data. */
const AGREEMENT = [
	"# Vendor Services Agreement",
	"",
	'Between Northwind Logistics Ltd ("Customer") and Harborline Systems Ltd ("Vendor").',
	"",
	"## 7. Fees and payment",
	"",
	"7.1 The Vendor invoices the Customer monthly in arrears.",
	"7.2 Fees are payable quarterly in advance.",
	"7.3 Late payment accrues interest at 1% per month.",
	"7.4 The service fee excludes VAT and reasonable travel costs.",
].join("\n");

const CLAUSE_7_2 = "7.2 Fees are payable quarterly in advance.";

const build = async () => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-demo-"));
	const sessionDb = join(workspace, "session.sqlite");
	const bundle = await createModel();
	await mkdir(join(workspace, "corpus/raw"), { recursive: true });
	await mkdir(join(workspace, "corpus/meta"), { recursive: true });
	await writeFile(join(workspace, "corpus/raw/doc_vendor.md"), AGREEMENT);
	await writeMeta({
		workspace,
		docId: "doc_vendor",
		meta: { title: "Vendor Services Agreement", filename: "vendor-services-agreement.md" },
	});

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
	await agent.seedWorkspace();
	return { agent };
};

test("the demo transcript: a tampered quote is rejected, the exact quote is published", async () => {
	const { agent } = await build();

	const rejected = (await agent.prompt(
		"What does clause 7.2 of the vendor agreement say?",
		"demo-tampered-1",
		"required",
	)) as PromptResult;

	assert.equal(rejected.status, "done");
	// Nothing was published as evidence: no citation, no id, and the product says so.
	assert.equal(rejected.evidence, "plain");
	assert.deepEqual(rejected.citations, []);
	// The gate rejected the quote itself, and the publish that tried to use it.
	assert.equal(rejected.answer, "Clause 7.2 says fees are payable annually in advance.");

	const report = (await agent.inspect({ limit: 50, report: "citations" })) as CitationsTraceReport;
	const tampered = report.runs.find((run) => run.runId === "demo-tampered-1");
	assert.equal(tampered?.published, false);
	assert.equal(tampered?.annotateRejected.quote_mismatch, 1);
	assert.equal(tampered?.publishRejected.unknown_citation, 1);

	// The same model, asked to copy the line instead of recalling it, publishes.
	const published = (await agent.prompt(
		"Quote clause 7.2 of the vendor agreement exactly.",
		"demo-exact-1",
		"required",
	)) as PromptResult;

	assert.equal(published.status, "done");
	assert.equal(published.evidence, "cited");
	assert.equal(published.citations.length, 1);
	assert.equal(published.citations[0]?.docId, "doc_vendor");
	assert.equal(published.citations[0]?.title, "Vendor Services Agreement");
	assert.equal(published.citations[0]?.version, 1);
	assert.equal(published.citations[0]?.line, 8);
	assert.equal(published.citations[0]?.quote, CLAUSE_7_2);
	assert.equal(published.citations[0]?.status, "attribution_verified");
	assert.ok(published.answer?.includes(`[${published.citations[0]?.citationId}]`), published.answer ?? "");
	assert.ok(published.answer?.includes("quarterly in advance"), published.answer ?? "");
	assert.ok(!published.answer?.includes("annually"));
	await agent.close();
});
