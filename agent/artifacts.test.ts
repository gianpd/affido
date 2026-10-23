// Tests of the artifacts rule (RFC 0009 D5/D6): the download surface is one
// workspace root, confined, capped, symlink-free, typed from a static map, and
// the /prompt envelope field is a pure diff of two snapshots — tested without
// a server, a model, or a Harness.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "./corpus.ts";
import { HttpError } from "./http.ts";
import {
	artifactContentType,
	artifactDisposition,
	describeArtifacts,
	diffArtifacts,
	listArtifactTree,
	MAX_ARTIFACT_BYTES,
	readArtifact,
	removeArtifactPath,
	snapshotArtifacts,
} from "./artifacts.ts";
import { MAX_TREE_ENTRIES } from "./uploads.ts";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "artifacts-"));
const encoder = new TextEncoder();

const writeArtifact = async (root: string, path: string, bytes: Uint8Array | string) =>
	writeFile(join(root, "artifacts", path), bytes);

test("artifactContentType is a static map; unknown and svg are byte streams", () => {
	assert.equal(artifactContentType("proposal.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
	assert.equal(artifactContentType("report.pdf"), "application/pdf");
	assert.equal(artifactContentType("logo.png"), "image/png");
	assert.equal(artifactContentType("photo.JPG"), "image/jpeg");
	assert.equal(artifactContentType("data.csv"), "text/csv");
	assert.equal(artifactContentType("notes.md"), "text/markdown");
	assert.equal(artifactContentType("bundle.zip"), "application/zip");
	assert.equal(artifactContentType("vector.svg"), "application/octet-stream");
	assert.equal(artifactContentType("archive.tar.gz"), "application/octet-stream");
	assert.equal(artifactContentType("noext"), "application/octet-stream");
});

test("artifactDisposition is always an attachment of a quote-free basename", () => {
	assert.equal(artifactDisposition("proposal.docx"), 'attachment; filename="proposal.docx"');
	assert.equal(artifactDisposition("proj/final (2).pdf"), 'attachment; filename="final (2).pdf"');
	// The tree validator refuses quotes, backslashes, and control characters,
	// so a basename that reaches this header can never contain CRLF or `"`.
	const header = artifactDisposition('weird but legal name.docx');
	assert.ok(!header.includes('"filename-break"'));
	assert.ok(!/[\r\n]/.test(header));
});

test("readArtifact streams a bounded file as a download and refuses everything else", async () => {
	const root = await workspace();
	await mkdir(join(root, "artifacts/proj"), { recursive: true });
	await writeArtifact(root, "proposal.docx", encoder.encode("PK-something"));
	await writeArtifact(root, "proj/notes.txt", "plain");

	const download = await readArtifact({ workspace: root, path: "proposal.docx" });
	assert.equal(download.bytes, 12);
	assert.equal(download.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
	assert.equal(download.disposition, 'attachment; filename="proposal.docx"');
	assert.equal(sha256(download.body), sha256(encoder.encode("PK-something")));

	const nested = await readArtifact({ workspace: root, path: "proj/notes.txt" });
	assert.equal(nested.contentType, "text/plain");

	// Missing, directory, traversal, and escape are distinct refusals.
	await assert.rejects(readArtifact({ workspace: root, path: "nope.docx" }), (error: unknown) => {
		assert.ok(error instanceof HttpError);
		assert.equal(error.status, 404);
		return true;
	});
	await assert.rejects(readArtifact({ workspace: root, path: "proj" }), (error: unknown) => {
		assert.ok(error instanceof HttpError);
		assert.equal(error.status, 400);
		return true;
	});
	await assert.rejects(readArtifact({ workspace: root, path: "../data/session.sqlite" }), HttpError);
	await assert.rejects(readArtifact({ workspace: root, path: "/abs" }), HttpError);
});

test("a symlink under artifacts/ is 404 for the download and skipped by the walk", async () => {
	const root = await workspace();
	await mkdir(join(root, "artifacts"), { recursive: true });
	await writeArtifact(root, "real.txt", "real");
	await symlink("/etc/hostname", join(root, "artifacts/leak"));
	await mkdir(join(root, "artifacts/dir-leak"), { recursive: true });
	await symlink("/etc/hostname", join(root, "artifacts/dir-leak/inner"));

	await assert.rejects(readArtifact({ workspace: root, path: "leak" }), (error: unknown) => {
		assert.ok(error instanceof HttpError);
		assert.equal(error.status, 404); // not 200 with /etc/hostname inside
		return true;
	});
	// A symlinked parent component is refused the same way.
	await assert.rejects(readArtifact({ workspace: root, path: "dir-leak/inner" }), HttpError);

	const tree = await listArtifactTree({ workspace: root, path: "" });
	assert.deepEqual(
		tree.entries.map((entry) => entry.path),
		["dir-leak", "real.txt"],
	);
	const snapshot = await snapshotArtifacts({ workspace: root });
	assert.deepEqual([...snapshot.keys()], ["real.txt"]);
});

test("readArtifact refuses a file past the cap with 413", async () => {
	const root = await workspace();
	await mkdir(join(root, "artifacts"), { recursive: true });
	await writeArtifact(root, "big.bin", Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
	await assert.rejects(readArtifact({ workspace: root, path: "big.bin" }), (error: unknown) => {
		assert.ok(error instanceof HttpError);
		assert.equal(error.status, 413);
		return true;
	});
});

test("listArtifactTree lists a subtree, and removeArtifactPath drops files and subtrees", async () => {
	const root = await workspace();
	assert.deepEqual(await listArtifactTree({ workspace: root, path: "" }), {
		path: "artifacts",
		truncated: false,
		entries: [],
	});
	await mkdir(join(root, "artifacts/proj"), { recursive: true });
	await writeArtifact(root, "proposal.docx", "x");
	await writeArtifact(root, "proj/notes.txt", "y");

	const sub = await listArtifactTree({ workspace: root, path: "proj" });
	assert.deepEqual(sub.entries, [{ path: "proj/notes.txt", kind: "file", bytes: 1 }]);

	assert.deepEqual(await removeArtifactPath({ workspace: root, path: "proj" }), { path: "artifacts/proj" });
	await removeArtifactPath({ workspace: root, path: "proj" }); // twice: not an error
	const tree = await listArtifactTree({ workspace: root, path: "" });
	assert.deepEqual(tree.entries, [{ path: "proposal.docx", kind: "file", bytes: 1 }]);
	await assert.rejects(removeArtifactPath({ workspace: root, path: ".." }), HttpError);
});

test("the tree walk stops at the entry cap and reports truncation", async () => {
	const root = await workspace();
	await mkdir(join(root, "artifacts/many"), { recursive: true });
	// One over the cap: the walk reports exactly MAX_TREE_ENTRIES and truncated.
	const writes = Array.from({ length: MAX_TREE_ENTRIES + 5 }, (_, index) =>
		writeArtifact(root, `many/f${String(index).padStart(5, "0")}.txt`, "x"),
	);
	await Promise.all(writes);
	const tree = await listArtifactTree({ workspace: root, path: "" });
	assert.equal(tree.truncated, true);
	assert.equal(tree.entries.length, MAX_TREE_ENTRIES);
	// The dir entry is counted too: one dir + 999 files.
	assert.equal(tree.entries.filter((entry) => entry.kind === "dir").length, 1);
});

test("diffArtifacts reports created and changed files, never deletions", () => {
	const before = new Map([
		["kept.txt", { size: 1, mtimeMs: 1 }],
		["gone.txt", { size: 1, mtimeMs: 1 }],
		["rewritten.txt", { size: 1, mtimeMs: 1 }],
	]);
	const after = new Map([
		["kept.txt", { size: 1, mtimeMs: 1 }],
		["created.txt", { size: 3, mtimeMs: 9 }],
		["rewritten.txt", { size: 2, mtimeMs: 2 }],
	]);
	assert.deepEqual(diffArtifacts(before, after), [
		{ path: "created.txt", size: 3, mtimeMs: 9 },
		{ path: "rewritten.txt", size: 2, mtimeMs: 2 },
	]);
	// An mtime-only touch counts as changed: a rewrite in place is still the run's artifact.
	assert.deepEqual(
		diffArtifacts(new Map([["a", { size: 1, mtimeMs: 1 }]]), new Map([["a", { size: 1, mtimeMs: 5 }]])),
		[{ path: "a", size: 1, mtimeMs: 5 }],
	);
	assert.deepEqual(diffArtifacts(before, new Map(before)), []);
});

test("describeArtifacts hashes changes below the cap and reports null above it", async () => {
	const root = await workspace();
	const baseline = await snapshotArtifacts({ workspace: root });

	await mkdir(join(root, "artifacts"), { recursive: true });
	await writeArtifact(root, "small.txt", "hello");
	const views = await describeArtifacts({ workspace: root, baseline: Object.fromEntries(baseline) });
	assert.equal(views.length, 1);
	assert.equal(views[0]?.path, "small.txt");
	assert.equal(views[0]?.bytes, 5);
	assert.equal(views[0]?.sha256, sha256(encoder.encode("hello")));
	assert.ok(typeof views[0]?.modifiedAt === "string");

	await writeArtifact(root, "big.bin", Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
	const capped = await describeArtifacts({ workspace: root, baseline: Object.fromEntries(baseline) });
	const big = capped.find((view) => view.path === "big.bin");
	assert.equal(big?.bytes, MAX_ARTIFACT_BYTES + 1);
	assert.equal(big?.sha256, null);
	assert.equal(capped.find((view) => view.path === "small.txt")?.sha256, sha256(encoder.encode("hello")));

	// An empty baseline diff reports the whole tree: the replay of an old run.
	const all = await describeArtifacts({ workspace: root, baseline: {} });
	assert.equal(all.length, 2);
});
