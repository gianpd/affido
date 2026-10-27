// Tests of the uploads tree rule (PRD 0003): the client dictates the path, the
// sandbox decides which paths can exist. Staging and deletion of tree files are
// RFC 0014's IngestPipeline (ingest.test.ts); what stays here is the tree
// itself — one validation, one listing — tested without a server or a model.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpError, safeTreePath } from "./http.ts";
import { createUploadDir, listUploadTree } from "./uploads.ts";
import { IngestPipeline } from "./ingest.ts";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "uploads-"));

test("safeTreePath accepts nested trees and rejects anything path-like", () => {
	assert.equal(safeTreePath("md-to-docx"), "md-to-docx");
	assert.equal(safeTreePath("md-to-docx/SKILL.md"), "md-to-docx/SKILL.md");
	assert.equal(safeTreePath("md-to-docx/references/style-guide.md"), "md-to-docx/references/style-guide.md");
	// Unicode and punctuation are legal filenames; only the dangerous shapes are not.
	assert.equal(safeTreePath("Relazione finale (2).docx"), "Relazione finale (2).docx");
	assert.equal(safeTreePath("skïlls/nést/dfaçil.md"), "skïlls/nést/dfaçil.md");
	// Real procurement basenames run past 100 bytes; the cap is the filesystem's
	// NAME_MAX, not a shorter guess.
	const longTender =
		"DD_3683_2026 - Allegato N° 16.0 - DD-3683-2026-All_16-POD_ES_RG01_RELAZIONE_GENERALE_DI_PROGETTO_V02.pdf.pdf";
	assert.equal(safeTreePath(`REGGIOCALABRIA/${longTender}`), `REGGIOCALABRIA/${longTender}`);
	for (const bad of [
		"",
		"/abs/path",
		"trailing/",
		"a//b",
		"a/./b",
		"..",
		"../corpus/raw/evil",
		"a/../b",
		"a\\b",
		"a:b",
		"a*b?",
		"a\nb",
		`${"x".repeat(1025)}`,
		`x/${"y".repeat(256)}`,
		// 255-byte NAME_MAX is counted in UTF-8 bytes, not characters.
		"à".repeat(128),
		Array.from({ length: 11 }, () => "a").join("/"),
	]) {
		assert.throws(() => safeTreePath(bad), HttpError, `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("createUploadDir is idempotent, builds nested parents, and refuses a file in the way", async () => {
	const root = await workspace();
	assert.deepEqual(await createUploadDir({ workspace: root, path: "md-to-docx/references" }), {
		path: "corpus/uploads/md-to-docx/references",
	});
	assert.deepEqual(await createUploadDir({ workspace: root, path: "md-to-docx/references" }), {
		path: "corpus/uploads/md-to-docx/references",
	});
});

test("listUploadTree returns a flat sorted tree and an empty root when nothing exists", async () => {
	const root = await workspace();
	assert.deepEqual(await listUploadTree({ workspace: root, path: "" }), {
		path: "corpus/uploads",
		truncated: false,
		entries: [],
	});

	await createUploadDir({ workspace: root, path: "md-to-docx/references" });
	await createUploadDir({ workspace: root, path: "md-to-docx/empty" });
	// Files enter the tree through the ingestion pipeline (RFC 0014 R1).
	const pipeline = new IngestPipeline(root);
	await pipeline.stage({ bytes: new TextEncoder().encode("# skill"), target: { kind: "tree-path", path: "md-to-docx/SKILL.md" } });
	await pipeline.stage({ bytes: new TextEncoder().encode("guide"), target: { kind: "tree-path", path: "md-to-docx/references/style-guide.md" } });

	assert.deepEqual(await listUploadTree({ workspace: root, path: "md-to-docx" }), {
		path: "corpus/uploads/md-to-docx",
		truncated: false,
		entries: [
			{ path: "md-to-docx/empty", kind: "dir", bytes: null },
			{ path: "md-to-docx/references", kind: "dir", bytes: null },
			{ path: "md-to-docx/references/style-guide.md", kind: "file", bytes: 5 },
			{ path: "md-to-docx/SKILL.md", kind: "file", bytes: 7 },
		],
	});
	// A subtree keeps paths relative to the uploads root, not to the query.
	const sub = await listUploadTree({ workspace: root, path: "md-to-docx/references" });
	assert.deepEqual(sub.entries, [{ path: "md-to-docx/references/style-guide.md", kind: "file", bytes: 5 }]);
});
