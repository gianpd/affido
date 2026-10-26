// Unit tests of the one ingestion pipeline (RFC 0014 §7): the admission matrix
// decided at ingest, one Staged semantics for both targets, deletion that
// leaves nothing behind, and the one-time registry bootstrap for pre-RFC
// volumes. No server, no model.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256, sha256OfText, uploadsDocIdOf } from "./corpus.ts";
import { IngestPipeline, parseSidecar, readSidecar, type Staged } from "./ingest.ts";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "ingest-"));

/** Smallest PDF.js-compatible one-page PDF (the shape unpdf.test.ts uses). */
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

const absent = async (path: string): Promise<boolean> => (await stat(path).catch(() => null)) === null;

test("a valid UTF-8 text file is admitted as text with one hash for both halves", async () => {
	const root = await workspace();
	const pipeline = new IngestPipeline(root);
	const bytes = new TextEncoder().encode("Il contratto si rinnova il 1 marzo 2027.");

	const staged = await pipeline.stage({
		bytes,
		target: { kind: "document", docId: "doc1", filename: "contratto.txt", title: "Contratto" },
	});

	assert.equal(staged.indexing, "text");
	assert.equal(staged.searchable, true);
	assert.equal(staged.sourceSha256, sha256(bytes));
	const sidecar = await readSidecar(root, "doc1");
	assert.notEqual(sidecar, null);
	assert.equal(sidecar?.indexing, "text");
	assert.equal(sidecar?.textPath, staged.path); // the staged file is the admitted text
	assert.equal(sidecar?.textSha256, staged.sourceSha256); // R4: one hash for one file
	assert.equal(sidecar?.root, "raw");
	assert.equal(sidecar?.title, "Contratto");
});

test("invalid UTF-8 bytes are staged untouched but never become evidence (R4)", async () => {
	const root = await workspace();
	const pipeline = new IngestPipeline(root);
	// 0xff 0xfe 0x41: decodes to U+FFFD U+FFFD "A", which re-encodes to different bytes.
	const bytes = new Uint8Array([0xff, 0xfe, 0x41]);

	const staged = await pipeline.stage({
		bytes,
		target: { kind: "document", docId: "doc1", filename: "broken.md", title: "" },
	});

	assert.equal(staged.indexing, "none");
	assert.equal(staged.searchable, false);
	// The staged bytes are exactly what arrived: a failed admission is not a mutation.
	assert.deepEqual(new Uint8Array(await readFile(join(root, staged.path))), bytes);
	const sidecar = await readSidecar(root, "doc1");
	assert.equal(sidecar?.indexing, "none");
	assert.equal(sidecar?.textPath, null);
	assert.equal(sidecar?.textSha256, null);
});

test("a PDF with a text layer is admitted as derived; scanned and garbage PDFs as none (R7)", async () => {
	const root = await workspace();
	const pipeline = new IngestPipeline(root);

	const derived = await pipeline.stage({
		bytes: MINIMAL_PDF(),
		target: { kind: "document", docId: "docP", filename: "CU.pdf", title: "" },
	});
	assert.equal(derived.indexing, "derived");
	assert.equal(derived.searchable, true);
	assert.equal(await readFile(join(root, "corpus/text/docP.txt"), "utf8"), "Reddito 2024");
	const sidecar = await readSidecar(root, "docP");
	assert.equal(sidecar?.textPath, "corpus/text/docP.txt");
	assert.equal(sidecar?.textSha256, sha256OfText("Reddito 2024"));
	assert.notEqual(sidecar?.textSha256, sidecar?.sourceSha256); // two files, two hashes

	const scanned = await pipeline.stage({
		bytes: new TextEncoder().encode("no text layer at all"),
		target: { kind: "document", docId: "docS", filename: "scanned.pdf", title: "" },
	});
	assert.equal(scanned.indexing, "none");
	assert.equal(scanned.searchable, false);

	const docx = await pipeline.stage({
		bytes: new TextEncoder().encode("PK\u0003\u0004 fake zip"),
		target: { kind: "document", docId: "docX", filename: "relazione.docx", title: "" },
	});
	assert.equal(docx.indexing, "none");
	assert.equal(docx.searchable, false);
});

test("both targets produce the same Staged semantics for the same bytes (R1, R6)", async () => {
	const root = await workspace();
	const pipeline = new IngestPipeline(root);
	const sentence = new TextEncoder().encode("Il contratto si rinnova il 1 marzo 2027.");

	const asDocument = await pipeline.stage({
		bytes: sentence,
		target: { kind: "document", docId: "docA", filename: "contratto.md", title: "Contratto" },
	});
	const asTreePath = await pipeline.stage({
		bytes: sentence,
		target: { kind: "tree-path", path: "persona-finanza/contratto.md" },
	});
	assert.equal(asDocument.indexing, asTreePath.indexing);
	assert.equal(asDocument.searchable, asTreePath.searchable);
	assert.equal(asTreePath.docId, uploadsDocIdOf("persona-finanza/contratto.md"));
	assert.equal(asTreePath.path, "corpus/uploads/persona-finanza/contratto.md");

	// The same PDF through both entry points yields the same admission (§5.5).
	const pdf = MINIMAL_PDF();
	const pdfDocument = await pipeline.stage({
		bytes: pdf,
		target: { kind: "document", docId: "docB", filename: "CU.pdf", title: "" },
	});
	const pdfTree = await pipeline.stage({ bytes: pdf, target: { kind: "tree-path", path: "dir/CU.pdf" } });
	assert.equal(pdfDocument.indexing, "derived");
	assert.equal(pdfTree.indexing, "derived");
});

test("re-ingesting a docId whose new bytes yield no text drops the stale derived text", async () => {
	const root = await workspace();
	const pipeline = new IngestPipeline(root);
	await pipeline.stage({ bytes: MINIMAL_PDF(), target: { kind: "document", docId: "docP", filename: "a.pdf", title: "" } });
	assert.equal(await absent(join(root, "corpus/text/docP.txt")), false);

	await pipeline.stage({
		bytes: new TextEncoder().encode("now scanned"),
		target: { kind: "document", docId: "docP", filename: "a.pdf", title: "" },
	});
	assert.equal(await absent(join(root, "corpus/text/docP.txt")), true, "the registry must not point at stale text");
	assert.equal((await readSidecar(root, "docP"))?.indexing, "none");
});

test("remove deletes bytes, derived text, and sidecar together — raw and tree, file and subtree (R9)", async () => {
	const root = await workspace();
	const pipeline = new IngestPipeline(root);
	await pipeline.stage({ bytes: MINIMAL_PDF(), target: { kind: "document", docId: "docP", filename: "a.pdf", title: "" } });
	await pipeline.remove({ target: { kind: "document", docId: "docP", filename: "a.pdf" } });
	assert.equal(await absent(join(root, "corpus/raw/docP.pdf")), true);
	assert.equal(await absent(join(root, "corpus/text/docP.txt")), true);
	assert.equal(await absent(join(root, "corpus/meta/docP.json")), true);
	await pipeline.remove({ target: { kind: "document", docId: "docP", filename: "a.pdf" } }); // twice: not an error

	await pipeline.stage({ bytes: new TextEncoder().encode("x"), target: { kind: "tree-path", path: "dir/a.pdf" } }).catch(() => {});
	const stagedTree = await pipeline.stage({ bytes: MINIMAL_PDF(), target: { kind: "tree-path", path: "dir/sub/CU.pdf" } });
	assert.equal(stagedTree.indexing, "derived");
	const docId = uploadsDocIdOf("dir/sub/CU.pdf");
	await pipeline.remove({ target: { kind: "tree-path", path: "dir" } });
	assert.equal(await absent(join(root, "corpus/uploads/dir/sub/CU.pdf")), true);
	assert.equal(await absent(join(root, `corpus/text/${docId}.txt`)), true);
	assert.equal(await absent(join(root, `corpus/meta/${docId}.json`)), true);
	assert.deepEqual(await readdir(join(root, "corpus/meta")), []); // no sidecar survives any delete
});

test("parseSidecar is lenient: absent, malformed, and incomplete entries read as null", () => {
	assert.equal(parseSidecar("not json"), null);
	assert.equal(parseSidecar("{}"), null);
	assert.equal(parseSidecar(JSON.stringify({ title: "t", filename: "f", at: 1 })), null); // pre-RFC shape
	const full = parseSidecar(
		JSON.stringify({
			docId: "doc1",
			root: "raw",
			title: "t",
			filename: "f.md",
			stagedPath: "corpus/raw/doc1.md",
			sourceSha256: "a".repeat(64),
			bytes: 3,
			indexing: "text",
			textPath: "corpus/raw/doc1.md",
			textSha256: "a".repeat(64),
			at: 1,
		}),
	);
	assert.notEqual(full, null);
	assert.equal(full?.docId, "doc1");
	// "none" admits no text fields.
	assert.equal(
		parseSidecar(
			JSON.stringify({ ...full, indexing: "none", textPath: "corpus/raw/doc1.md", textSha256: "a".repeat(64) }),
		),
		null,
	);
});

test("bootstrap registers pre-RFC files once, reuses existing derived text, and drops orphans (R10)", async () => {
	const root = await workspace();
	// A pre-RFC layout: a raw text doc with the old {title, filename} sidecar, a
	// raw PDF whose derived text pre-exists, an uploads file with no sidecar,
	// and an orphaned corpus/text entry whose source is gone.
	await mkdir(join(root, "corpus/raw"), { recursive: true });
	await mkdir(join(root, "corpus/meta"), { recursive: true });
	await mkdir(join(root, "corpus/text"), { recursive: true });
	await mkdir(join(root, "corpus/uploads/tree"), { recursive: true });
	await writeFile(join(root, "corpus/raw/doc_old.md"), "Il contratto si rinnova il 1 marzo 2027.");
	await writeFile(
		join(root, "corpus/meta/doc_old.json"),
		`${JSON.stringify({ title: "Contratto vecchio", filename: "vecchio.md", at: 1 })}\n`,
	);
	await writeFile(join(root, "corpus/raw/doc_pdf.pdf"), MINIMAL_PDF());
	await writeFile(join(root, "corpus/text/doc_pdf.txt"), "Reddito 2024"); // pre-RFC staging wrote it at upload
	await writeFile(join(root, "corpus/uploads/tree/notes.md"), "tetto di spesa 15.000 EUR");
	await writeFile(join(root, "corpus/text/u-ghost-000000000000.txt"), "orphan");

	const pipeline = new IngestPipeline(root);
	const logged: string[] = [];
	await pipeline.bootstrap((message) => logged.push(message));

	const old = await readSidecar(root, "doc_old");
	assert.notEqual(old, null);
	assert.equal(old?.title, "Contratto vecchio"); // the legacy sidecar's title survives
	assert.equal(old?.indexing, "text");
	const pdf = await readSidecar(root, "doc_pdf");
	assert.notEqual(pdf, null);
	assert.equal(pdf?.indexing, "derived");
	assert.equal(pdf?.textSha256, sha256OfText("Reddito 2024")); // reused, not re-extracted
	const tree = await readSidecar(root, uploadsDocIdOf("tree/notes.md"));
	assert.notEqual(tree, null);
	assert.equal(tree?.root, "uploads");
	assert.equal(tree?.title, "tree/notes.md");
	assert.equal(await absent(join(root, "corpus/text/u-ghost-000000000000.txt")), true); // orphan removed
	assert.match(logged[0] ?? "", /registered 3 document\(s\)/);

	// Idempotent: the second run registers nothing and removes nothing.
	const before = await readFile(join(root, "corpus/meta/doc_old.json"), "utf8");
	await pipeline.bootstrap((message) => logged.push(message));
	assert.equal(await readFile(join(root, "corpus/meta/doc_old.json"), "utf8"), before);
	assert.match(logged[1] ?? "", /registered 0 document\(s\)/);
});

// The staged shape the control plane records, kept honest at the type level.
test("Staged carries the fields the catalog row needs", async () => {
	const root = await workspace();
	const pipeline = new IngestPipeline(root);
	const staged: Staged = await pipeline.stage({
		bytes: new TextEncoder().encode("x"),
		target: { kind: "tree-path", path: "solo.md" },
	});
	assert.deepEqual([...Object.keys(staged).sort()], ["bytes", "docId", "indexing", "path", "searchable", "sourceSha256"]);
});
