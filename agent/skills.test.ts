// Tests of the skills rule (RFC 0009): the platform ships a catalog, the user
// installs it file-by-file into `skills/`, the model learns what exists, and
// `/name` becomes a server-built hint. All tested without a server or a model,
// like uploads.test.ts.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "./corpus.ts";
import { HttpError } from "./http.ts";
import { stageUploadFile } from "./uploads.ts";
import {
	buildSkillHint,
	installSkillFile,
	listInstalledSkills,
	parseFrontmatterDescription,
	parseSkillManifest,
	removeSkill,
	renderSkillsSection,
	safeSkillName,
	verifySkill,
} from "./skills.ts";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "skills-"));

const encoder = new TextEncoder();
const SKILL_MD = `---
name: md-to-docx
description: >
  Convert markdown notes into a branded Word document, with cover page,
  headings, tables, and footers.
version: 1.0.0
---

# md-to-docx

Follow the references.
`;

const installFixture = async (root: string) => {
	await installSkillFile({ workspace: root, skill: "md-to-docx", path: "SKILL.md", bytes: encoder.encode(SKILL_MD) });
	const reference = encoder.encode("// template\n");
	await installSkillFile({
		workspace: root,
		skill: "md-to-docx",
		path: "references/generator-template.js",
		bytes: reference,
	});
	const manifest = {
		name: "md-to-docx",
		version: "1.0.0",
		files: [
			{ path: "SKILL.md", sha256: sha256(encoder.encode(SKILL_MD)) },
			{ path: "references/generator-template.js", sha256: sha256(reference) },
		],
	};
	await installSkillFile({
		workspace: root,
		skill: "md-to-docx",
		path: "marketplace.json",
		bytes: encoder.encode(JSON.stringify(manifest)),
	});
	return manifest;
};

test("safeSkillName accepts catalog names and refuses anything path-like", () => {
	assert.equal(safeSkillName("md-to-docx"), "md-to-docx");
	assert.equal(safeSkillName("a"), "a");
	assert.equal(safeSkillName("9lives"), "9lives");
	for (const bad of ["", "-no", "No-Caps", "with space", "../x", "a/b", `${"x".repeat(65)}`, "docx_2"]) {
		assert.throws(() => safeSkillName(bad), HttpError, `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("installSkillFile writes nested bundle files idempotently and reports the hash", async () => {
	const root = await workspace();
	const first = await installSkillFile({
		workspace: root,
		skill: "md-to-docx",
		path: "SKILL.md",
		bytes: encoder.encode("# one"),
	});
	assert.equal(first.path, "skills/md-to-docx/SKILL.md");
	assert.equal(first.bytes, 5);
	assert.equal(first.sha256, sha256(encoder.encode("# one")));

	const second = await installSkillFile({
		workspace: root,
		skill: "md-to-docx",
		path: "references/brand-palettes.md",
		bytes: encoder.encode("palettes"),
	});
	assert.equal(second.path, "skills/md-to-docx/references/brand-palettes.md");

	// Same path twice: overwrite, not two files (keep a frontmatter so it stays a skill).
	await installSkillFile({
		workspace: root,
		skill: "md-to-docx",
		path: "SKILL.md",
		bytes: encoder.encode("---\ndescription: two\n---\n# two"),
	});
	const { skills } = await listInstalledSkills({ workspace: root });
	assert.equal(skills.length, 1);

	// Traversal is refused at both parameters.
	await assert.rejects(installSkillFile({ workspace: root, skill: "../x", path: "SKILL.md", bytes: encoder.encode("x") }), HttpError);
	await assert.rejects(installSkillFile({ workspace: root, skill: "md-to-docx", path: "../escape.md", bytes: encoder.encode("x") }), HttpError);
});

test("parseFrontmatterDescription reads plain, folded, and missing shapes", () => {
	assert.equal(
		parseFrontmatterDescription("---\nname: x\ndescription: plain value\n---\nbody"),
		"plain value",
	);
	assert.equal(parseFrontmatterDescription('---\ndescription: "quoted"\n---\n'), "quoted");
	const folded = parseFrontmatterDescription(SKILL_MD);
	assert.ok(folded !== null);
	assert.ok(folded.startsWith("Convert markdown notes into a branded Word document, with cover page,"));
	assert.ok(folded.endsWith("footers."));
	assert.equal(parseFrontmatterDescription("---\nname: x\n---\nbody"), null);
	assert.equal(parseFrontmatterDescription("# no frontmatter"), null);
	assert.equal(parseFrontmatterDescription("---\ndescription: >\n  one\n  two\nother: v\n---\n"), "one two");
});

test("listInstalledSkills reports both roots, versions, and a fresh verify; non-skills are skipped", async () => {
	const root = await workspace();
	const manifest = await installFixture(root);
	// A user-shared tree is a skill too (PRD 0003 provenance).
	await stageUploadFile({ workspace: root, path: "my-skill/SKILL.md", bytes: encoder.encode("---\ndescription: mine\n---\n# mine") });
	// Directories without a SKILL.md, or with one that has no description, are not skills.
	await mkdir(join(root, "skills/not-a-skill"), { recursive: true });
	await installSkillFile({
		workspace: root,
		skill: "silent",
		path: "SKILL.md",
		bytes: encoder.encode("# no frontmatter"),
	});

	const { skills } = await listInstalledSkills({ workspace: root });
	assert.deepEqual(
		skills.map((skill) => [skill.name, skill.provenance, skill.version, skill.verified]),
		[
			["md-to-docx", "marketplace", "1.0.0", "ok"],
			["my-skill", "uploads", null, null],
		],
	);
	const listed = skills[0];
	assert.equal(listed?.root, "skills/md-to-docx");
	assert.equal(listed?.entry, "skills/md-to-docx/SKILL.md");
	assert.ok((listed?.description ?? "").startsWith("Convert markdown notes"));

	// The listing's fresh verify follows the disk: corrupt one file (keeping it a
	// skill — a valid frontmatter) and the verdict flips.
	await installSkillFile({
		workspace: root,
		skill: "md-to-docx",
		path: "SKILL.md",
		bytes: encoder.encode("---\ndescription: corrupted\n---\n# corrupted"),
	});
	const after = await listInstalledSkills({ workspace: root });
	assert.equal(after.skills.find((skill) => skill.name === "md-to-docx")?.verified, "mismatch");
	await installSkillFile({ workspace: root, skill: "md-to-docx", path: "SKILL.md", bytes: encoder.encode(SKILL_MD) });
	void manifest;
});

test("verifySkill reports ok, mismatch, and missing per file, and refuses bad manifests", async () => {
	const root = await workspace();
	const manifest = await installFixture(root);
	assert.deepEqual(await verifySkill({ workspace: root, skill: "md-to-docx", manifest }), {
		skill: "md-to-docx",
		ok: true,
		files: [
			{ path: "SKILL.md", status: "ok" },
			{ path: "references/generator-template.js", status: "ok" },
		],
	});

	await installSkillFile({ workspace: root, skill: "md-to-docx", path: "SKILL.md", bytes: encoder.encode("# wrong byte") });
	const report = await verifySkill({ workspace: root, skill: "md-to-docx", manifest });
	assert.equal(report.ok, false);
	assert.deepEqual(report.files[0], { path: "SKILL.md", status: "mismatch" });

	// A partial install is visible as a missing file, not an error.
	await removeSkill({ workspace: root, skill: "md-to-docx" });
	await installSkillFile({ workspace: root, skill: "md-to-docx", path: "SKILL.md", bytes: encoder.encode(SKILL_MD) });
	const partial = await verifySkill({ workspace: root, skill: "md-to-docx", manifest });
	assert.equal(partial.ok, false);
	assert.deepEqual(partial.files.find((file) => file.path === "references/generator-template.js"), {
		path: "references/generator-template.js",
		status: "missing",
	});

	// The manifest body is data about the skill, never a path walker.
	assert.throws(() => parseSkillManifest("md-to-docx", { name: "other" }), HttpError);
	assert.throws(() => parseSkillManifest("md-to-docx", { files: [] }), HttpError);
	assert.throws(() => parseSkillManifest("md-to-docx", { files: [{ path: "../escape", sha256: "00" }] }), HttpError);
	assert.throws(() => parseSkillManifest("md-to-docx", { files: [{ path: "x", sha256: 1 }] }), HttpError);
});

test("buildSkillHint resolves, strips, and names reality for unknown names", async () => {
	const root = await workspace();
	await installFixture(root);

	const resolved = await buildSkillHint({ workspace: root, prompt: "/md-to-docx make a proposal" });
	assert.equal(resolved?.kind, "resolved");
	assert.equal(resolved?.name, "md-to-docx");
	assert.equal(
		resolved?.content,
		`make a proposal\n\n[skill hint] The user invoked the skill "md-to-docx".\n` +
			`Read ${root}/skills/md-to-docx/SKILL.md with the read tool first and follow it for this task.`,
	);

	// Token-only prompt: the note is the whole content.
	const bare = await buildSkillHint({ workspace: root, prompt: "  /md-to-docx  " });
	assert.equal(bare?.kind, "resolved");
	assert.ok(bare?.content.startsWith("[skill hint]"));

	// A user-shared tree is invocable the same way (PRD 0003 provenance).
	await stageUploadFile({ workspace: root, path: "my-skill/SKILL.md", bytes: encoder.encode("---\ndescription: mine\n---\n# mine") });
	const uploaded = await buildSkillHint({ workspace: root, prompt: "/my-skill go" });
	assert.equal(uploaded?.kind, "resolved");
	assert.ok(uploaded?.content.includes(`${root}/uploads/my-skill/SKILL.md`));

	const unresolved = await buildSkillHint({ workspace: root, prompt: "/nope summarize this" });
	assert.equal(unresolved?.kind, "unresolved");
	assert.equal(
		unresolved?.content,
		`/nope summarize this\n\n[skill hint] The user invoked the skill "nope", which is not installed.\n` +
			`Installed skills: md-to-docx (${root}/skills/md-to-docx/SKILL.md), my-skill (${root}/uploads/my-skill/SKILL.md).\n` +
			"Answer in plain text without pretending to use it.",
	);

	// Without skills, the note still names reality.
	const empty = await mkdtemp(join(tmpdir(), "skills-empty-"));
	const none = await buildSkillHint({ workspace: empty, prompt: "/nope x" });
	assert.ok(none?.content.includes("Installed skills: none."));

	// Only a leading /name matches; other slashes are ordinary text.
	assert.equal(await buildSkillHint({ workspace: root, prompt: "see /etc/hosts and /md-to-docx later" }), null);
	assert.equal(await buildSkillHint({ workspace: root, prompt: "/ABS/path" }), null);
	assert.equal(await buildSkillHint({ workspace: root, prompt: "plain question" }), null);
});

test("renderSkillsSection lists installs and the artifacts rule, or omits itself", async () => {
	const empty = await mkdtemp(join(tmpdir(), "skills-empty-"));
	assert.equal(await renderSkillsSection(empty), undefined);

	const root = await workspace();
	await installFixture(root);
	const section = await renderSkillsSection(root);
	assert.ok(section !== undefined);
	assert.ok(section.includes("- md-to-docx (marketplace v1.0.0):"));
	assert.ok(section.includes(`${root}/skills/md-to-docx/SKILL.md`));
	assert.ok(section.includes(`${root}/artifacts/`));
});

test("removeSkill is idempotent and leaves siblings alone", async () => {
	const root = await workspace();
	await installFixture(root);
	await installSkillFile({ workspace: root, skill: "other", path: "SKILL.md", bytes: encoder.encode("---\ndescription: o\n---\nx") });

	assert.deepEqual(await removeSkill({ workspace: root, skill: "md-to-docx" }), { skill: "md-to-docx", path: "skills/md-to-docx" });
	await removeSkill({ workspace: root, skill: "md-to-docx" }); // twice: not an error
	const { skills } = await listInstalledSkills({ workspace: root });
	assert.deepEqual(skills.map((skill) => skill.name), ["other"]);
	await assert.rejects(removeSkill({ workspace: root, skill: "../uploads" }), HttpError);
});

test("a symlinked SKILL.md is not a skill entry", async () => {
	const root = await workspace();
	await mkdir(join(root, "skills/linked"), { recursive: true });
	await installSkillFile({ workspace: root, skill: "real", path: "SKILL.md", bytes: encoder.encode("---\ndescription: real\n---\nx") });
	await symlink(join(root, "skills/real/SKILL.md"), join(root, "skills/linked/SKILL.md"));
	const { skills } = await listInstalledSkills({ workspace: root });
	assert.deepEqual(skills.map((skill) => skill.name), ["real"]);
});

test("a crafted installed manifest cannot break the listing or the prompt section", async () => {
	const root = await workspace();
	await installFixture(root);
	// A direct POST /skills/file can overwrite marketplace.json with anything;
	// a traversal path there must not 500 GET /skills (and with it /prompt).
	const crafted = {
		name: "md-to-docx",
		version: "1.0.0",
		files: [
			{ path: "../../../../etc/passwd", sha256: "0".repeat(64) },
			{ path: "SKILL.md", sha256: sha256(encoder.encode(SKILL_MD)) },
		],
	};
	await installSkillFile({
		workspace: root,
		skill: "md-to-docx",
		path: "marketplace.json",
		bytes: encoder.encode(JSON.stringify(crafted)),
	});

	const { skills } = await listInstalledSkills({ workspace: root });
	assert.equal(skills.length, 1);
	const listed = skills[0];
	assert.ok(listed !== undefined);
	assert.equal(listed.name, "md-to-docx");
	assert.equal(listed.version, "1.0.0");
	// The legal entry still verifies; the illegal one is dropped, not fatal.
	assert.equal(listed.verified, "ok");
	// The skills section of the next /prompt renders instead of throwing.
	const section = await renderSkillsSection(root);
	assert.ok(section !== undefined && section.includes("- md-to-docx (marketplace v1.0.0):"));
});
