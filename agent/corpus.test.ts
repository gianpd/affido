// Tests of the corpus staging rule: one doc id, one relative path, one hash.
// These are the only things the control plane trusts about an upload, so they
// are tested without a server, a parser, or a model.

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	derivedTextRelativePath,
	indexedAsText,
	isPdfFilename,
	isTextFilename,
	rawRelativePath,
	removeDerivedText,
	removeRaw,
	safeDocId,
	sha256,
	stageDerivedText,
	stageRaw,
	uploadsDocIdOf,
} from "./corpus.ts";
import { HttpError } from "./http.ts";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "corpus-"));

test("safeDocId accepts generated ids and rejects anything path-like", () => {
	assert.equal(safeDocId("7f3c1b2e-0a4d-4c5f-9a11-2b3c4d5e6f70"), "7f3c1b2e-0a4d-4c5f-9a11-2b3c4d5e6f70");
	assert.equal(safeDocId("doc_1-A"), "doc_1-A");
	for (const bad of ["", "../etc/passwd", "a/b", "a\\b", "doc.1", "x".repeat(65)]) {
		assert.throws(() => safeDocId(bad), HttpError, `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("uploadsDocIdOf is a legal safeDocId, deterministic, and path-shaped", () => {
	for (const path of [
		"persona-finanza/0971_CU2024_1-31032026_125017-1-1.pdf",
		"Relazione finale (2).docx",
		"deep/nested/tree/notes.md",
		"weird \u00e0\u00e8\u00ec name.bin",
	]) {
		const docId = uploadsDocIdOf(path);
		assert.equal(docId, safeDocId(docId), `${docId} must survive safeDocId`);
		assert.equal(docId.length <= 64, true);
		assert.equal(docId, uploadsDocIdOf(path));
	}
	// Different paths never collide on the readable part: the hash disambiguates.
	assert.notEqual(uploadsDocIdOf("a/report.pdf"), uploadsDocIdOf("b/report.pdf"));
});

test("text and pdf classification drives what the index can see", () => {
	assert.equal(isPdfFilename("CU2024.PDF"), true);
	assert.equal(isPdfFilename("notes.md"), false);
	assert.equal(isTextFilename("notes.md"), true);
	assert.equal(isTextFilename("tabella.CSV"), true);
	assert.equal(isTextFilename("contability.ods"), false);
	assert.equal(indexedAsText("notes.md", false), true);
	assert.equal(indexedAsText("doc.pdf", true), true);
	assert.equal(indexedAsText("doc.pdf", false), false); // scanned or failed extraction
	assert.equal(indexedAsText("contability.ods", false), false);
});

test("rawRelativePath keeps a bounded extension and falls back to .bin", () => {
	assert.equal(rawRelativePath("doc1", "Bando.PDF"), "corpus/raw/doc1.pdf");
	assert.equal(rawRelativePath("doc1", "notes.md"), "corpus/raw/doc1.md");
	assert.equal(rawRelativePath("doc1", "no-extension"), "corpus/raw/doc1.bin");
	assert.equal(rawRelativePath("doc1", "archive.tar.gz"), "corpus/raw/doc1.gz");
	assert.equal(rawRelativePath("doc1", "weird.p df"), "corpus/raw/doc1.bin");
});

test("stageRaw writes the exact bytes and reports their hash", async () => {
	const root = await workspace();
	const bytes = new TextEncoder().encode("cauzione provvisoria 2%");
	const staged = await stageRaw({ workspace: root, docId: "doc1", filename: "gara.txt", bytes });

	assert.equal(staged.path, "corpus/raw/doc1.txt");
	assert.equal(staged.bytes, bytes.length);
	assert.equal(staged.sourceSha256, sha256(bytes));
	assert.deepEqual(new Uint8Array(await readFile(join(root, staged.path))), bytes);
	// The same bytes always hash the same: the citation id formula depends on it.
	assert.equal(sha256(bytes), sha256(new TextEncoder().encode("cauzione provvisoria 2%")));
});

test("stageRaw rewrites the same doc id in place and removeRaw drops the file", async () => {
	const root = await workspace();
	await stageRaw({ workspace: root, docId: "doc1", filename: "a.txt", bytes: new TextEncoder().encode("first") });
	await stageRaw({ workspace: root, docId: "doc1", filename: "a.txt", bytes: new TextEncoder().encode("second") });
	assert.equal(await readFile(join(root, "corpus/raw/doc1.txt"), "utf8"), "second");

	await removeRaw({ workspace: root, docId: "doc1", filename: "a.txt" });
	await assert.rejects(stat(join(root, "corpus/raw/doc1.txt")));
	// Deleting twice is not an error: the row is the source of truth for "exists".
	await removeRaw({ workspace: root, docId: "doc1", filename: "a.txt" });
});

/** Smallest PDF.js-compatible one-page PDF, the same shape unpdf.test.ts uses. */
const MINIMAL_PDF = (): Uint8Array =>
	new TextEncoder().encode(
		"%PDF-1.4\n" +
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R" +
			"/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
			"4 0 obj<</Length 59>>stream\nBT /F1 24 Tf 72 720 Td (Reddito 2024) Tj ET\nendstream endobj\n" +
			"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
			"trailer<</Root 1 0 R>>",
	);

test("stageDerivedText extracts a PDF into corpus/text and reports success", async () => {
	const root = await workspace();
	const bytes = MINIMAL_PDF();
	const written = await stageDerivedText({ workspace: root, docId: "doc9", filename: "CU.pdf", bytes });
	assert.equal(written, true);
	assert.equal(await readFile(join(root, derivedTextRelativePath("doc9")), "utf8"), "Reddito 2024");

	// A non-PDF never writes derived text; a broken PDF stays staged but unindexed.
	assert.equal(await stageDerivedText({ workspace: root, docId: "docA", filename: "notes.md", bytes }), false);
	assert.equal(
		await stageDerivedText({ workspace: root, docId: "docB", filename: "broken.pdf", bytes: new TextEncoder().encode("not a pdf") }),
		false,
	);
	await assert.rejects(stat(join(root, derivedTextRelativePath("docB"))));

	await removeDerivedText({ workspace: root, docId: "doc9" });
	await assert.rejects(stat(join(root, derivedTextRelativePath("doc9"))));
	await removeDerivedText({ workspace: root, docId: "doc9" }); // twice: not an error
});
