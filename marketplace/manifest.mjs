#!/usr/bin/env node
// Regenerates the `files[]` hashes of every marketplace/skills/*/marketplace.json
// (RFC 0009 D1). The manifest is what the dashboard renders and what a sandbox
// install verifies against, so it must match the bundle byte for byte.
//
// Usage:
//   node marketplace/manifest.mjs            rewrite the manifests in place
//   node marketplace/manifest.mjs --check    exit 1 when a manifest is stale
//
// `name`, `version`, `description`, and `requires` are authored by hand (the
// reviewable part); only `files` is generated. A skill without a manifest gets
// one with defaults derived from its SKILL.md frontmatter.

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(here, "skills");
const check = process.argv.includes("--check");
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_MAX = 200;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const parseFrontmatter = (text) => {
	const description = /description:\s*(>[-+]?)?\n?((?:[ \t]+.+\n?)+?)/.exec(text)?.[2];
	const simple = /^description:\s*(.+)$/m.exec(text)?.[1];
	const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
	const clean = (value) =>
		value
			?.split("\n")
			.map((line) => line.trim())
			.join(" ")
			.replace(/^["']|["']$/g, "")
			.trim();
	const descriptionText = clean(description ?? simple ?? "");
	return {
		version: version ?? "1.0.0",
		description: descriptionText === "" ? null : descriptionText.slice(0, DESCRIPTION_MAX),
	};
};

const listFiles = async (directory, prefix = "") => {
	const out = [];
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (entry.name === "marketplace.json") continue;
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...(await listFiles(join(directory, entry.name), relative)));
		else if (entry.isFile()) out.push({ path: relative, bytes: (await stat(join(directory, entry.name))).size });
	}
	return out;
};

let stale = 0;
for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
	if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue;
	const directory = join(skillsRoot, entry.name);
	const manifestPath = join(directory, "marketplace.json");
	let existing = {};
	try {
		existing = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch {
		// first run for this skill: derive defaults from the SKILL.md frontmatter
		const frontmatter = parseFrontmatter(await readFile(join(directory, "SKILL.md"), "utf8"));
		existing = {
			name: entry.name,
			version: frontmatter.version,
			description: frontmatter.description ?? "",
			requires: { nodeLibraries: [] },
		};
	}
	const files = [];
	for (const file of await listFiles(directory)) {
		files.push({ path: file.path, sha256: sha256(await readFile(join(directory, file.path))), bytes: file.bytes });
	}
	const manifest = {
		name: existing.name ?? entry.name,
		version: existing.version ?? "1.0.0",
		description: existing.description ?? "",
		requires: existing.requires ?? { nodeLibraries: [] },
		files,
	};
	const serialized = `${JSON.stringify(manifest, null, "\t")}\n`;
	const current = await readFile(manifestPath, "utf8").catch(() => null);
	if (current === serialized) {
		console.log(`ok    ${entry.name}: manifest up to date (${files.length} files)`);
		continue;
	}
	stale++;
	if (check) {
		console.log(`STALE ${entry.name}: manifest does not match the bundle — run: node marketplace/manifest.mjs`);
		continue;
	}
	await writeFile(manifestPath, serialized);
	console.log(`wrote ${entry.name}: ${files.length} files hashed -> ${manifestPath}`);
}

if (check && stale > 0) {
	console.error(`${stale} stale manifest(s)`);
	process.exit(1);
}
