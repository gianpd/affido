// Tests of the corpus path rules: one doc id, one relative path, one hash.
// Staging and admission are RFC 0014's IngestPipeline (ingest.test.ts); what
// stays here are the identities the control plane and the tools trust, tested
// without a server, a parser, or a model.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import {
	derivedTextRelativePath,
	isPdfFilename,
	isTextFilename,
	rawRelativePath,
	safeDocId,
	sha256,
	uploadsDocIdOf,
} from "./corpus.ts";
import { HttpError } from "./http.ts";
import { IngestPipeline } from "./ingest.ts";
import { DerivedTextTool, IngestRawTool } from "./tools.ts";
import type { AgentApi } from "./types.ts";

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

test("filename classification stays extension-driven", () => {
	assert.equal(isPdfFilename("CU2024.PDF"), true);
	assert.equal(isPdfFilename("notes.md"), false);
	assert.equal(isTextFilename("notes.md"), true);
	assert.equal(isTextFilename("tabella.CSV"), true);
	assert.equal(isTextFilename("contability.ods"), false);
});

test("rawRelativePath keeps a bounded extension and falls back to .bin", () => {
	assert.equal(rawRelativePath("doc1", "Bando.PDF"), "corpus/raw/doc1.pdf");
	assert.equal(rawRelativePath("doc1", "notes.md"), "corpus/raw/doc1.md");
	assert.equal(rawRelativePath("doc1", "no-extension"), "corpus/raw/doc1.bin");
	assert.equal(rawRelativePath("doc1", "archive.tar.gz"), "corpus/raw/doc1.gz");
	assert.equal(rawRelativePath("doc1", "weird.p df"), "corpus/raw/doc1.bin");
	assert.equal(derivedTextRelativePath("doc1"), "corpus/text/doc1.txt");
});

// The control plane records what this tool returns: an ingest response
// without bytes/sourceSha256 wrote NOT NULL violations upstream (the missing
// `await` spread a Promise, which has no properties). The pipeline's own tests
// cannot reach the handle() seam, so this one does.
test("IngestRawTool answers with the staged hash, byte count, and admission", async () => {
	const root = await workspace();
	const tool = new IngestRawTool(new IngestPipeline(root));
	const bytes = new TextEncoder().encode("il contratto si rinnova a marzo");
	const req = Readable.from([bytes]) as unknown as IncomingMessage;
	let noted = 0;
	const agent = { noteCorpusChange: () => { noted += 1; } } as unknown as AgentApi;
	const url = new URL("http://sandbox/ingest?docId=doc7&filename=contratto.txt");

	const out = (await tool.handle({ req, url, agent })) as Record<string, unknown>;

	assert.equal(out.docId, "doc7");
	assert.equal(out.path, "corpus/raw/doc7.txt");
	assert.equal(out.bytes, bytes.length);
	assert.equal(out.sourceSha256, sha256(bytes));
	assert.equal(out.searchable, true);
	assert.equal(out.indexing, "text");
	assert.equal(noted, 1);
});

// The preview of a PDF reads its derived text: the tool must resolve the
// corpus path itself (the web app never builds one) and reject path-shaped ids
// before they reach the agent.
test("DerivedTextTool serves the derived text of one docId", async () => {
	const tool = new DerivedTextTool();
	const reads: string[] = [];
	const agent = {
		readFile: async (path: string) => {
			reads.push(path);
			return { agent: "a", path, content: "cauzione provvisoria" };
		},
	} as unknown as AgentApi;
	const req = Readable.from([]) as unknown as IncomingMessage;

	const out = (await tool.handle({ req, url: new URL("http://sandbox/text?docId=doc7"), agent })) as Record<string, unknown>;

	assert.deepEqual(reads, ["corpus/text/doc7.txt"]);
	assert.equal(out.content, "cauzione provvisoria");
	assert.equal(out.path, "corpus/text/doc7.txt");
	await assert.rejects(
		tool.handle({ req, url: new URL("http://sandbox/text?docId=../raw/doc1"), agent }),
		HttpError,
	);
});
