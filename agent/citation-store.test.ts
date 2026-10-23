// Unit tests of the citation mechanism (RFC 0006 §7): the gate table-driven,
// annotate semantics, grep/readWindow bounds, pattern guards, and the pure
// helpers. No pi-durable, no HTTP — the store is exercised through its port
// over a fake loader.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	citationIdOf,
	citationTokens,
	codePointsBefore,
	evaluatePublish,
	lineOf,
	lineTableOf,
	unsafePattern,
	VerifyError,
	type Annotation,
} from "./citation-store.ts";
import { writeMeta } from "./corpus.ts";
import { stageDerivedText, uploadsDocIdOf } from "./corpus.ts";
import { stageUploadFile } from "./uploads.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";

const GOLD = [
	"# Contratto di manutenzione",
	"",
	"## Rinnovo",
	"Il contratto si rinnova tacitamente il 1° marzo 2027.",
	"La disdetta deve essere comunicata 90 giorni prima.",
	"",
	"## Prezzi",
	"Il canone annuo è di 12.000 EUR e si aggiorna ogni anno.",
].join("\n");

const ASTRAL = "Titolo: 🚚 trasporti\nRinnovo: il contratto 📋 si rinnova il 1 marzo.\n";

const annotation = (overrides: Partial<Annotation> = {}): Annotation => ({
	citationId: "cit_0000000000",
	runId: "run-1",
	docId: "doc_42",
	docVersion: 1,
	start: 0,
	end: 10,
	line: 1,
	quote: "Il contratto si rinnova tacitamente il 1° marzo 2027.",
	textSha256: "a".repeat(64),
	status: "verified",
	at: 0,
	...overrides,
});

const runDir = async (documents: Record<string, { text: string; title?: string }>): Promise<string> => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-store-"));
	await mkdir(join(workspace, "corpus/raw"), { recursive: true });
	await mkdir(join(workspace, "corpus/meta"), { recursive: true });
	for (const [docId, doc] of Object.entries(documents)) {
		await writeFile(join(workspace, `corpus/raw/${docId}.md`), doc.text);
		await writeMeta({ workspace, docId, meta: { title: doc.title ?? docId, filename: `${docId}.md` } });
	}
	return workspace;
};

const storeOver = async (documents: Record<string, { text: string; title?: string }>) => {
	const workspace = await runDir(documents);
	return new WorkspaceCitationStore(new NodeExecutionEnv({ cwd: workspace }), BACKGROUND_CONTEXT);
};

test("the index sees the uploads tree: text directly, PDFs through derived text, binaries never", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "citation-uploads-"));
	await stageUploadFile({
		workspace,
		path: "persona-finanza/notes.md",
		bytes: new TextEncoder().encode("Il tetto massimo di spesa \u00e8 15.000 EUR."),
	});
	const pdf = new TextEncoder().encode(
		"%PDF-1.4\n" +
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R" +
			"/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
			"4 0 obj<</Length 59>>stream\nBT /F1 24 Tf 72 720 Td (Reddito 2024) Tj ET\nendstream endobj\n" +
			"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
			"trailer<</Root 1 0 R>>",
	);
	const staged = await stageUploadFile({ workspace, path: "persona-finanza/CU.pdf", bytes: pdf });
	assert.equal(
		await stageDerivedText({
			workspace,
			docId: uploadsDocIdOf("persona-finanza/CU.pdf"),
			filename: "persona-finanza/CU.pdf",
			bytes: pdf,
		}),
		true,
	);
	await stageUploadFile({ workspace, path: "persona-finanza/contability.ods", bytes: new TextEncoder().encode("binary-ish") });
	await stageUploadFile({ workspace, path: "persona-finanza/scanned.pdf", bytes: new TextEncoder().encode("no text layer") });
	// Staging paths are corpus paths now: the bucket is one namespace.
	assert.equal(staged.path, "corpus/uploads/persona-finanza/CU.pdf");

	const store = new WorkspaceCitationStore(new NodeExecutionEnv({ cwd: workspace }), BACKGROUND_CONTEXT);
	const documents = await store.documents();
	const ids = new Set(documents.map((document) => document.docId));
	const notes = documents.find((document) => document.docId === uploadsDocIdOf("persona-finanza/notes.md"));
	assert.ok(notes, "the uploads .md must be indexed");
	assert.equal(notes.title, "persona-finanza/notes.md");
	assert.equal(notes.filename, "notes.md");
	assert.ok(ids.has(uploadsDocIdOf("persona-finanza/CU.pdf")), "the PDF must be indexed through its derived text");
	assert.equal(ids.has(uploadsDocIdOf("persona-finanza/contability.ods")), false);
	assert.equal(ids.has(uploadsDocIdOf("persona-finanza/scanned.pdf")), false);

	// Both indexed uploads are greppable: the corpus answer path of RFC 0006.
	const md = await store.grepLines({ pattern: "15\.000" });
	assert.equal(md.hits[0]?.docId, uploadsDocIdOf("persona-finanza/notes.md"));
	const pdfHits = await store.grepLines({ pattern: "Reddito" });
	assert.equal(pdfHits.hits[0]?.docId, uploadsDocIdOf("persona-finanza/CU.pdf"));
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test("citationTokens reads single and grouped tokens, unique in order", () => {
	const markdown = "A [cit_aaaaaaaa00] and [cit_bbbbbbbb00; cit_cccccccc00], again [cit_aaaaaaaa00].";
	assert.deepEqual(citationTokens(markdown), ["cit_aaaaaaaa00", "cit_bbbbbbbb00", "cit_cccccccc00"]);
});

test("lineTable and lineOf agree on 1-based lines", () => {
	const table = lineTableOf(GOLD);
	assert.equal(table.utf16.length, 8);
	assert.equal(lineOf(table, 0), 1);
	assert.equal(lineOf(table, table.utf16[2] ?? 0), 3);
	assert.equal(lineOf(table, (table.utf16[3] ?? 1) + 2), 4);
});

test("codePointsBefore counts astral characters as one code point", () => {
	assert.equal(codePointsBefore(ASTRAL, ASTRAL.indexOf("Rinnovo")), 20);
	assert.equal([...ASTRAL.slice(0, ASTRAL.indexOf("Rinnovo"))].length, 20);
});

// ── the gate (§5.4), table-driven ────────────────────────────────────────────

test("gate accepts a fully-cited reply with grouped tokens", () => {
	const id = "cit_aaaaaaaa00";
	const check = evaluatePublish({
		markdown: `## Rinnovo\n\nIl contratto si rinnova il 1° marzo 2027 [${id}; cit_ffffffffff].`,
		declared: [id, "cit_ffffffffff"],
		annotations: [
			annotation({ citationId: id }),
			annotation({ citationId: "cit_ffffffffff", quote: "other", start: 10, end: 15, line: 5 }),
		],
		runId: "run-1",
	});
	assert.deepEqual(check, { ok: true });
});

test("gate rejects an uncited line, headings and blanks exempt", () => {
	const check = evaluatePublish({
		markdown: "## Heading\n\nCited line [cit_aaaaaaaa00].\nThis line has no token.",
		declared: ["cit_aaaaaaaa00"],
		annotations: [annotation({ citationId: "cit_aaaaaaaa00" })],
		runId: "run-1",
	});
	assert.equal(check.ok, false);
	assert.equal(check.reason, "uncited_line");
	assert.equal(check.detail, "This line has no token.");
});

test("gate rejects every id mismatch by name", () => {
	const cases: readonly [string, ReturnType<typeof evaluatePublish>, { markdown: string; declared: string[]; annotations: readonly Annotation[] }][] = [
		["undeclared_token", { ok: false, reason: "undeclared_token", detail: "cit_bbbbbbbb00" }, {
			markdown: "Line [cit_aaaaaaaa00; cit_bbbbbbbb00].",
			declared: ["cit_aaaaaaaa00"],
			annotations: [annotation({ citationId: "cit_aaaaaaaa00" })],
		}],
		["unused_citation", { ok: false, reason: "unused_citation", detail: "cit_bbbbbbbb00" }, {
			markdown: "Line [cit_aaaaaaaa00].",
			declared: ["cit_aaaaaaaa00", "cit_bbbbbbbb00"],
			annotations: [annotation({ citationId: "cit_aaaaaaaa00" }), annotation({ citationId: "cit_bbbbbbbb00", quote: "x", start: 1, end: 2, line: 2 })],
		}],
		["unknown_citation", { ok: false, reason: "unknown_citation", detail: "cit_bbbbbbbb00" }, {
			markdown: "Line [cit_aaaaaaaa00].",
			declared: ["cit_aaaaaaaa00", "cit_bbbbbbbb00"],
			annotations: [annotation({ citationId: "cit_aaaaaaaa00" })],
		}],
		["unverified_citation", { ok: false, reason: "unverified_citation", detail: "cit_aaaaaaaa00" }, {
			markdown: "Line [cit_aaaaaaaa00].",
			declared: ["cit_aaaaaaaa00"],
			annotations: [annotation({ citationId: "cit_aaaaaaaa00", status: "pending" as Annotation["status"] })],
		}],
		["foreign_citation", { ok: false, reason: "foreign_citation", detail: "cit_aaaaaaaa00" }, {
			markdown: "Line [cit_aaaaaaaa00].",
			declared: ["cit_aaaaaaaa00"],
			annotations: [annotation({ citationId: "cit_aaaaaaaa00", runId: "run-other" })],
		}],
	];
	for (const [name, expected, input] of cases) {
		const check = evaluatePublish({ ...input, runId: "run-1" });
		assert.deepEqual(check, expected, name);
	}
});

// ── annotate (R1-R3) ─────────────────────────────────────────────────────────

test("annotate locates an exact quote, mints a stable run-scoped id", async () => {
	const store = await storeOver({ doc_42: { text: GOLD, title: "Contratto di manutenzione" } });
	const quote = "Il contratto si rinnova tacitamente il 1° marzo 2027.";
	const first = await store.annotate({ runId: "run-1", docId: "doc_42", docVersion: 1, kind: "quote", quote });
	const second = await store.annotate({ runId: "run-1", docId: "doc_42", docVersion: 1, kind: "quote", quote });
	assert.equal(first.citationId, `cit_${citationIdOf("run-1", "doc_42", 1, quote).slice(4)}`);
	assert.equal(first.citationId, second.citationId); // content-addressed, stable
	assert.equal(first.line, 4);
	assert.equal(first.status, "verified");
	const documents = await store.documents();
	assert.equal(documents[0]?.title, "Contratto di manutenzione");
	const reread = GOLD.slice(0, GOLD.indexOf(quote));
	assert.equal(first.start, [...reread].length); // code points, not utf16 units
});

test("annotate rejects drift, missing docs, bad versions, long quotes", async () => {
	const store = await storeOver({ doc_42: { text: GOLD } });
	const quote = "Il contratto si rinnova tacitamente il 1° marzo 2027.";
	await assert.rejects(
		store.annotate({ runId: "r", docId: "doc_42", docVersion: 1, kind: "quote", quote: `${quote} ` }),
		(error: unknown) => error instanceof VerifyError && error.reason === "quote_mismatch",
	);
	await assert.rejects(
		store.annotate({ runId: "r", docId: "doc_42", docVersion: 1, kind: "quote", quote: "Il contratto   si rinnova" }),
		(error: unknown) => error instanceof VerifyError && error.reason === "quote_mismatch",
	);
	await assert.rejects(
		store.annotate({ runId: "r", docId: "doc_99", docVersion: 1, kind: "quote", quote }),
		(error: unknown) => error instanceof VerifyError && error.reason === "not_found",
	);
	await assert.rejects(
		store.annotate({ runId: "r", docId: "doc_42", docVersion: 2, kind: "quote", quote }),
		(error: unknown) => error instanceof VerifyError && error.reason === "version_unavailable",
	);
	await assert.rejects(
		store.annotate({ runId: "r", docId: "doc_42", docVersion: 1, kind: "quote", quote: "x".repeat(1001) }),
		(error: unknown) => error instanceof VerifyError && error.reason === "quote_too_long",
	);
});

test("annotate round-trips astral-plane characters in code points", async () => {
	const store = await storeOver({ doc_astral: { text: ASTRAL } });
	const quote = "il contratto 📋 si rinnova il 1 marzo.";
	const result = await store.annotate({ runId: "r", docId: "doc_astral", docVersion: 1, kind: "quote", quote });
	assert.equal(result.line, 2);
	assert.equal(result.end - result.start, [...quote].length);
});

test("verify reports attribution_verified and named failures (R11)", async () => {
	const store = await storeOver({ doc_42: { text: GOLD } });
	const quote = "Il contratto si rinnova tacitamente il 1° marzo 2027.";
	const annotationRecord = await store.annotate({ runId: "r", docId: "doc_42", docVersion: 1, kind: "quote", quote });
	assert.deepEqual(await store.verify(annotationRecord), { status: "attribution_verified" });
	const moved = { ...annotationRecord, docId: "doc_missing" };
	assert.deepEqual(await store.verify(moved), { status: "not_found" });
});

// ── grep and readWindow (R9) ─────────────────────────────────────────────────

test("grepLines reports 1-based lines, line text, and match spans", async () => {
	const store = await storeOver({ doc_42: { text: GOLD } });
	const { hits } = await store.grepLines({ pattern: "rinnova" });
	assert.equal(hits.length, 1);
	assert.equal(hits[0]?.line, 4);
	assert.equal(hits[0]?.docId, "doc_42");
	assert.equal(hits[0]?.text, quote4());
	assert.equal(hits[0]?.start, 16); // code points before the match inside the line: "Il contratto si "
});

const quote4 = (): string => "Il contratto si rinnova tacitamente il 1° marzo 2027.";

test("grepLines respects the limit and reports truncation", async () => {
	const text = Array.from({ length: 60 }, (_, index) => `canone ${index}`).join("\n");
	const store = await storeOver({ doc_many: { text } });
	const result = await store.grepLines({ pattern: "canone", limit: 10 });
	assert.equal(result.hits.length, 10);
	assert.equal(result.truncated, true);
});

test("grepLines refuses unsafe patterns and reports misses", async () => {
	const store = await storeOver({ doc_42: { text: GOLD } });
	await assert.rejects(
		store.grepLines({ pattern: "(a|b)+" }),
		(error: unknown) => error instanceof VerifyError && error.reason === "unsafe_pattern",
	);
	await assert.rejects(
		store.grepLines({ pattern: "(a+)+" }),
		(error: unknown) => error instanceof VerifyError && error.reason === "unsafe_pattern",
	);
	assert.equal(unsafePattern("[a-z]+"), false); // a plain quantified class is fine
	await assert.rejects(
		store.grepLines({ pattern: "nonexistent-needle" }),
		(error: unknown) => error instanceof VerifyError && error.reason === "not_found",
	);
});

test("readWindow needs an anchor and returns spans, lines, truncation", async () => {
	const store = await storeOver({ doc_42: { text: GOLD } });
	await assert.rejects(
		store.readWindow({ docId: "doc_42" }),
		(error: unknown) => error instanceof VerifyError && error.reason === "anchor_required",
	);
	const window = await store.readWindow({ docId: "doc_42", needle: "rinnova", radius: 10, maxChars: 40 });
	assert.equal(window.docVersion, 1);
	assert.ok(window.text.includes("rinnova"));
	assert.ok(window.start > 0);
	assert.equal(window.lines.length >= 1, true);
	const line4 = window.lines.find((line) => line.line === 4);
	assert.notEqual(line4, undefined);
	// A needle that is not in the document is refused by name.
	await assert.rejects(
		store.readWindow({ docId: "doc_42", needle: "not in the document" }),
		(error: unknown) => error instanceof VerifyError && error.reason === "not_found",
	);
});

test("readWindow truncates at maxChars and offers nextStart", async () => {
	const text = `${"x".repeat(500)} NEEDLE ${"y".repeat(500)}`;
	const store = await storeOver({ doc_long: { text } });
	const window = await store.readWindow({ docId: "doc_long", needle: "NEEDLE", radius: 400, maxChars: 100 });
	assert.equal(window.truncated, true);
	assert.notEqual(window.nextStart, null);
	assert.ok(window.nextStart !== null && window.nextStart > window.start);
	assert.ok([...window.text].length <= 100);
});

test("readWindow serves a line range", async () => {
	const store = await storeOver({ doc_42: { text: GOLD } });
	const window = await store.readWindow({ docId: "doc_42", lineRange: [4, 5], radius: 0 });
	assert.ok(window.text.startsWith("Il contratto"));
	assert.ok(window.text.includes("90 giorni"));
});
