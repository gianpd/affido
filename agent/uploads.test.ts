// Tests of the uploads rule (PRD 0003): the client dictates the path, the
// sandbox decides which paths can exist. One tree, one validation, one hash
// per file — tested without a server or a model, like corpus.test.ts.

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "./corpus.ts";
import { HttpError, safeTreePath } from "./http.ts";
import {
	createUploadDir,
	listUploadTree,
	removeUploadPath,
	stageUploadFile,
} from "./uploads.ts";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "uploads-"));

test("safeTreePath accepts nested trees and rejects anything path-like", () => {
	assert.equal(safeTreePath("md-to-docx"), "md-to-docx");
	assert.equal(safeTreePath("md-to-docx/SKILL.md"), "md-to-docx/SKILL.md");
	assert.equal(safeTreePath("md-to-docx/references/style-guide.md"), "md-to-docx/references/style-guide.md");
	// Unicode and punctuation are legal filenames; only the dangerous shapes are not.
	assert.equal(safeTreePath("Relazione finale (2).docx"), "Relazione finale (2).docx");
	assert.equal(safeTreePath("skïlls/nést/dfa̧cil.md"), "skïlls/nést/dfa̧cil.md");
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
		`${"x".repeat(241)}`,
		`x/${"y".repeat(65)}`,
		Array.from({ length: 11 }, () => "a").join("/"),
	]) {
		assert.throws(() => safeTreePath(bad), HttpError, `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("stageUploadFile writes nested files with their parents and reports the hash", async () => {
	const root = await workspace();
	const bytes = new TextEncoder().encode("# md-to-docx skill");
	const staged = await stageUploadFile({
		workspace: root,
		path: "md-to-docx/SKILL.md",
		bytes,
	});
	assert.equal(staged.path, "uploads/md-to-docx/SKILL.md");
	assert.equal(staged.bytes, bytes.length);
	assert.equal(staged.sha256, sha256(bytes));

	const guide = new TextEncoder().encode("style guide");
	const nested = await stageUploadFile({ workspace: root, path: "md-to-docx/references/style-guide.md", bytes: guide });
	assert.equal(nested.path, "uploads/md-to-docx/references/style-guide.md");
	assert.deepEqual(new Uint8Array(await readFile(join(root, nested.path))), guide);

	// Same path twice: overwrite, not two files.
	await stageUploadFile({ workspace: root, path: "md-to-docx/SKILL.md", bytes: new TextEncoder().encode("second") });
	assert.equal(await readFile(join(root, "uploads/md-to-docx/SKILL.md"), "utf8"), "second");
});

test("createUploadDir is idempotent and refuses a file in the way", async () => {
	const root = await workspace();
	assert.deepEqual(await createUploadDir({ workspace: root, path: "md-to-docx/references" }), {
		path: "uploads/md-to-docx/references",
	});
	assert.deepEqual(await createUploadDir({ workspace: root, path: "md-to-docx/references" }), {
		path: "uploads/md-to-docx/references",
	});
	await stageUploadFile({ workspace: root, path: "a-file", bytes: new TextEncoder().encode("x") });
	await assert.rejects(createUploadDir({ workspace: root, path: "a-file" }), HttpError);
});

test("listUploadTree returns a flat sorted tree and an empty root when nothing exists", async () => {
	const root = await workspace();
	assert.deepEqual(await listUploadTree({ workspace: root, path: "" }), {
		path: "uploads",
		truncated: false,
		entries: [],
	});

	await stageUploadFile({ workspace: root, path: "md-to-docx/SKILL.md", bytes: new TextEncoder().encode("# skill") });
	await stageUploadFile({ workspace: root, path: "md-to-docx/references/style-guide.md", bytes: new TextEncoder().encode("guide") });
	await createUploadDir({ workspace: root, path: "md-to-docx/empty" });

	assert.deepEqual(await listUploadTree({ workspace: root, path: "md-to-docx" }), {
		path: "uploads/md-to-docx",
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

test("removeUploadPath drops a subtree, a single file, and is idempotent", async () => {
	const root = await workspace();
	await stageUploadFile({ workspace: root, path: "md-to-docx/SKILL.md", bytes: new TextEncoder().encode("# skill") });
	await stageUploadFile({ workspace: root, path: "solo.txt", bytes: new TextEncoder().encode("x") });

	assert.deepEqual(await removeUploadPath({ workspace: root, path: "md-to-docx" }), { path: "uploads/md-to-docx" });
	await assert.rejects(stat(join(root, "uploads/md-to-docx")));
	await removeUploadPath({ workspace: root, path: "md-to-docx" }); // twice: not an error

	assert.deepEqual(await removeUploadPath({ workspace: root, path: "solo.txt" }), { path: "uploads/solo.txt" });
	const tree = await listUploadTree({ workspace: root, path: "" });
	assert.deepEqual(tree.entries, []);
	// The uploads root itself is not a deletable path: it has no path above it.
	await assert.rejects(removeUploadPath({ workspace: root, path: ".." }), HttpError);
});
