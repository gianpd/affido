// Tests of the corpus staging rule: one doc id, one relative path, one hash.
// These are the only things the control plane trusts about an upload, so they
// are tested without a server, a parser, or a model.

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rawRelativePath, removeRaw, safeDocId, sha256, stageRaw } from "./corpus.ts";
import { HttpError } from "./http.ts";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "corpus-"));

test("safeDocId accepts generated ids and rejects anything path-like", () => {
	assert.equal(safeDocId("7f3c1b2e-0a4d-4c5f-9a11-2b3c4d5e6f70"), "7f3c1b2e-0a4d-4c5f-9a11-2b3c4d5e6f70");
	assert.equal(safeDocId("doc_1-A"), "doc_1-A");
	for (const bad of ["", "../etc/passwd", "a/b", "a\\b", "doc.1", "x".repeat(65)]) {
		assert.throws(() => safeDocId(bad), HttpError, `expected ${JSON.stringify(bad)} to be rejected`);
	}
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
