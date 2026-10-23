// Marketplace skill installs: a second workspace tree (RFC 0009 D2) whose
// files arrive from the platform's curated catalog, one file per request at a
// client-chosen path — the PRD 0003 uploads contract applied to `skills/`.
// Two provenances share the invocation convention: `skills/<name>/` (installed
// from the marketplace) and `uploads/<name>/` (a user-shared tree). Nothing
// here touches the conversation, so install, listing, and verify never
// activate the agent and cannot defeat the idle pause.

import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError, safeTreePath, workspacePath } from "./http.ts";
import { MAX_UPLOAD_BYTES, sha256 } from "./corpus.ts";
import { UPLOADS_DIR } from "./uploads.ts";
export const SKILLS_DIR = "skills";

/** R3: the skills prompt section and the listing stay bounded. */
export const MAX_SKILLS_PER_ROOT = 20;
export const DESCRIPTION_MAX = 200;
/** Only the frontmatter head is read to describe a skill. */
const FRONTMATTER_BYTES = 8192;
/** A verify manifest is data about files, never a way to walk the tree at length. */
const MAX_MANIFEST_FILES = 200;
/** Listing verifies against the installed manifest only while it stays cheap. */
const LIST_VERIFY_MAX_BYTES = 1024 * 1024;

/** Skill names are URL-safe, slash-free, and collide with no path segment. */
export const safeSkillName = (value: string): string => {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
		throw new HttpError(400, {
			error: "invalid_skill_name",
			message: "skill must be 1-64 of [a-z0-9-] and start with a letter or digit",
		});
	}
	return value;
};

export type StagedSkillFile = {
	readonly skill: string;
	/** Workspace-relative path the file landed at, e.g. `skills/md-to-docx/SKILL.md`. */
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
};

/** Write one bundle file under `skills/<name>/<path>`, creating the parents.
 * Idempotent by path: a retry rewrites the same file (R2). */
export const installSkillFile = async (input: {
	readonly workspace: string;
	readonly skill: string;
	readonly path: string;
	readonly bytes: Uint8Array;
}): Promise<StagedSkillFile> => {
	const skill = safeSkillName(input.skill);
	const relative = safeTreePath(input.path);
	const absolute = workspacePath(input.workspace, `${SKILLS_DIR}/${skill}/${relative}`);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, input.bytes);
	return { skill, path: `${SKILLS_DIR}/${skill}/${relative}`, bytes: input.bytes.length, sha256: sha256(input.bytes) };
};

/** Remove the skill subtree; a missing skill is not an error (R2). */
export const removeSkill = async (input: {
	readonly workspace: string;
	readonly skill: string;
}): Promise<{ readonly skill: string; readonly path: string }> => {
	const skill = safeSkillName(input.skill);
	await rm(workspacePath(input.workspace, `${SKILLS_DIR}/${skill}`), { recursive: true, force: true });
	return { skill, path: `${SKILLS_DIR}/${skill}` };
};

export type InstalledSkill = {
	readonly name: string;
	/** `marketplace`: installed under `skills/`; `uploads`: a user-shared tree. */
	readonly provenance: "marketplace" | "uploads";
	/** Workspace-relative root of the skill, e.g. `skills/md-to-docx`. */
	readonly root: string;
	/** Workspace-relative path of `SKILL.md`. */
	readonly entry: string;
	/** First paragraph of the frontmatter description, bounded; null disqualifies. */
	readonly description: string | null;
	/** From the installed `marketplace.json`, when present. */
	readonly version: string | null;
	/** Fresh check against the installed manifest: `ok`, `mismatch`, or null when
	 * no manifest is installed or it is too large to hash on every listing. */
	readonly verified: "ok" | "mismatch" | null;
};

/** Parse `description` out of a SKILL.md frontmatter head: plain scalars and
 * folded (`>`) or literal (`|`) blocks. Tolerant by design; bounded input. */
export const parseFrontmatterDescription = (head: string): string | null => {
	if (!head.startsWith("---")) return null;
	const end = head.indexOf("\n---", 3);
	if (end === -1) return null;
	const lines = head.slice(0, end).split("\n").slice(1);
	let value: string | null = null;
	let folding = false;
	for (const line of lines) {
		if (/^description:/.test(line) && !folding) {
			const rest = line.slice("description:".length).trim();
			if (rest === ">" || rest === ">-" || rest === ">+" || rest === "|" || rest === "|-" || rest === "|+") {
				value = "";
				folding = true;
			} else {
				value = rest.replace(/^["']|["']$/g, "");
			}
		} else if (folding && /^\s+\S/.test(line)) {
			value = `${value ?? ""} ${line.trim()}`.trim();
		} else if (folding) {
			folding = false; // the next key starts: the description block is over
		}
	}
	return value === null || value === "" ? null : value.slice(0, DESCRIPTION_MAX);
};

const isFile = async (absolute: string): Promise<boolean> => {
	const info = await lstat(absolute).catch(() => null);
	return info !== null && info.isFile();
};

/** Read one manifest-shaped `marketplace.json` inside a skill root, if any. */
const readInstalledManifest = async (
	workspace: string,
	root: string,
): Promise<{ version: string | null; files: { path: string; sha256: string; bytes?: number }[] } | null> => {
	const absolute = workspacePath(workspace, `${root}/marketplace.json`);
	if (!(await isFile(absolute))) return null;
	try {
		const parsed = JSON.parse(await readFile(absolute, "utf8")) as {
			version?: unknown;
			files?: unknown;
		};
		const files: { path: string; sha256: string; bytes?: number }[] = [];
		if (Array.isArray(parsed.files)) {
			for (const entry of parsed.files) {
				if (files.length >= MAX_MANIFEST_FILES) break;
				if (typeof entry !== "object" || entry === null) continue;
				const file = entry as { path?: unknown; sha256?: unknown; bytes?: unknown };
				if (typeof file.path !== "string" || typeof file.sha256 !== "string") continue;
				// The installed manifest is data about files, never a way to walk the
				// tree: an illegal path drops its entry instead of breaking the listing
				// (and with it the skills section of the next /prompt).
				try {
					files.push({
						path: safeTreePath(file.path),
						sha256: file.sha256,
						...(typeof file.bytes === "number" ? { bytes: file.bytes } : {}),
					});
				} catch {
					// not a legal tree path: the entry is not a file of this skill
				}
			}
		}
		return {
			version: typeof parsed.version === "string" ? parsed.version : null,
			files,
		};
	} catch {
		return null;
	}
};

/** One skill directory: entry exists, description parsed, version and a fresh
 * verify against the installed manifest when that stays cheap. */
const describeSkillRoot = async (
	workspace: string,
	root: string,
	name: string,
	provenance: "marketplace" | "uploads",
): Promise<InstalledSkill | null> => {
	const entry = `${root}/SKILL.md`;
	const absolute = workspacePath(workspace, entry);
	if (!(await isFile(absolute))) return null;
	const head = await readFile(absolute, "utf8").then(
		(text) => text.slice(0, FRONTMATTER_BYTES),
		() => "",
	);
	const description = parseFrontmatterDescription(head);
	if (description === null) return null; // no SKILL.md voice: not a listable skill
	const manifest = await readInstalledManifest(workspace, root);
	let verified: "ok" | "mismatch" | null = null;
	if (manifest !== null && manifest.files.length > 0 && manifest.files.length <= MAX_MANIFEST_FILES) {
		// Cheap fresh check (bounded total bytes): the listing reports reality, not a cached verdict.
		let total = 0;
		for (const file of manifest.files) total += file.bytes ?? 0;
		if (total <= LIST_VERIFY_MAX_BYTES) {
			verified = "ok";
			for (const file of manifest.files) {
				const bytes = await readFile(workspacePath(workspace, `${root}/${file.path}`)).catch(() => null);
				if (bytes === null || sha256(bytes) !== file.sha256) {
					verified = "mismatch";
					break;
				}
			}
		}
	}
	return { name, provenance, root, entry, description, version: manifest?.version ?? null, verified };
};

/** Every installed skill of both roots, marketplace first, each root capped
 * (R3). Entries without a `SKILL.md` or without a description are skipped:
 * they exist on disk but are not skills the model should discover. */
export const listInstalledSkills = async (input: {
	readonly workspace: string;
}): Promise<{ readonly skills: readonly InstalledSkill[] }> => {
	const skills: InstalledSkill[] = [];
	const roots: readonly ["marketplace" | "uploads", string][] = [
		["marketplace", SKILLS_DIR],
		["uploads", UPLOADS_DIR],
	];
	for (const [provenance, dir] of roots) {
		const listed = await readdir(workspacePath(input.workspace, dir), { withFileTypes: true }).catch(() => []);
		const names = listed
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b))
			.slice(0, MAX_SKILLS_PER_ROOT);
		for (const name of names) {
			const skill = await describeSkillRoot(input.workspace, `${dir}/${name}`, name, provenance);
			if (skill !== null) skills.push(skill);
		}
	}
	return { skills };
};

export type SkillManifestFile = { readonly path: string; readonly sha256: string };

export type SkillVerifyReport = {
	readonly skill: string;
	readonly ok: boolean;
	readonly files: readonly { readonly path: string; readonly status: "ok" | "mismatch" | "missing" }[];
};

/** Validate a manifest body (R10): the files list is bounded and every path is
 * a legal tree path, so a manifest cannot point outside its skill. */
export const parseSkillManifest = (skill: string, body: unknown): { version: string | null; files: readonly SkillManifestFile[] } => {
	const parsed = body as { name?: unknown; version?: unknown; files?: unknown };
	if (parsed === null || typeof parsed !== "object") throw new HttpError(400, { error: "invalid_manifest", message: "the manifest must be a JSON object" });
	if (typeof parsed.name === "string" && parsed.name !== skill) {
		throw new HttpError(400, { error: "invalid_manifest", message: `manifest name "${parsed.name}" does not match skill "${skill}"` });
	}
	if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
		throw new HttpError(400, { error: "invalid_manifest", message: "manifest files must be a non-empty list" });
	}
	if (parsed.files.length > MAX_MANIFEST_FILES) {
		throw new HttpError(400, { error: "invalid_manifest", message: `manifest lists more than ${MAX_MANIFEST_FILES} files` });
	}
	const files = parsed.files.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw new HttpError(400, { error: "invalid_manifest", message: "manifest file entries must be objects" });
		const file = entry as { path?: unknown; sha256?: unknown };
		if (typeof file.path !== "string" || typeof file.sha256 !== "string") {
			throw new HttpError(400, { error: "invalid_manifest", message: "manifest file entries need path and sha256" });
		}
		return { path: safeTreePath(file.path), sha256: file.sha256 };
	});
	return { version: typeof parsed.version === "string" ? parsed.version : null, files };
};

/** Recompute the sha256 of the installed files against the manifest (R10):
 * per-file ok / mismatch / missing, never an error for a bad state — the
 * report is the state. */
export const verifySkill = async (input: {
	readonly workspace: string;
	readonly skill: string;
	readonly manifest: { readonly files: readonly SkillManifestFile[] };
}): Promise<SkillVerifyReport> => {
	const skill = safeSkillName(input.skill);
	const files = await Promise.all(
		input.manifest.files.map(async (file) => {
			const bytes = await readFile(workspacePath(input.workspace, `${SKILLS_DIR}/${skill}/${file.path}`)).catch(() => null);
			if (bytes === null) return { path: file.path, status: "missing" as const };
			return { path: file.path, status: sha256(bytes) === file.sha256 ? ("ok" as const) : ("mismatch" as const) };
		}),
	);
	return { skill, ok: files.every((file) => file.status === "ok"), files };
};
export type SkillHint =
	| { readonly kind: "resolved"; readonly name: string; readonly content: string }
	| { readonly kind: "unresolved"; readonly name: string; readonly content: string };

const INVOCATION = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+|$)/;

const skillEntryOf = async (workspace: string, name: string): Promise<string | null> => {
	for (const dir of [SKILLS_DIR, UPLOADS_DIR]) {
		const entry = `${dir}/${name}/SKILL.md`;
		if (await isFile(workspacePath(workspace, entry))) return entry;
	}
	return null;
};

/**
 * D4: a prompt starting `/skill_name` becomes a server-built hint appended to
 * the submitted content. Resolved: the token is stripped and the note names the
 * `SKILL.md` to read first. Unresolved: the prompt is kept verbatim and the
 * note names reality — what is installed — so the model cannot pretend. Any
 * other text (including `/` elsewhere) is returned untouched as `null`.
 */
export const buildSkillHint = async (input: {
	readonly workspace: string;
	readonly prompt: string;
}): Promise<SkillHint | null> => {
	const trimmed = input.prompt.trim();
	const match = INVOCATION.exec(trimmed);
	if (match === null) return null;
	const name = match[1] ?? "";
	const entry = await skillEntryOf(input.workspace, name);
	if (entry !== null) {
		const rest = trimmed.slice(match[0].length);
		const note =
			`[skill hint] The user invoked the skill "${name}".\n` +
			`Read ${input.workspace}/${entry} with the read tool first and follow it for this task.`;
		return { kind: "resolved", name, content: rest === "" ? note : `${rest}\n\n${note}` };
	}
	const { skills } = await listInstalledSkills({ workspace: input.workspace });
	const installed =
		skills.length === 0
			? "none"
			: skills.map((skill) => `${skill.name} (${input.workspace}/${skill.entry})`).join(", ");
	const note =
		`[skill hint] The user invoked the skill "${name}", which is not installed.\n` +
		`Installed skills: ${installed}.\n` +
		"Answer in plain text without pretending to use it.";
	return { kind: "unresolved", name, content: `${trimmed}\n\n${note}` };
};

/** R3: the server-built skills section of the prompt. `undefined` omits it —
 * a workspace without skills pays nothing and sees nothing. */
export const renderSkillsSection = async (workspace: string): Promise<string | undefined> => {
	const { skills } = await listInstalledSkills({ workspace });
	if (skills.length === 0) return undefined;
	const lines = skills.map(
		(skill) =>
			`- ${skill.name} (${skill.provenance}${skill.version === null ? "" : ` v${skill.version}`}): ` +
			`${skill.description} Read ${workspace}/${skill.entry} before using it.`,
	);
	return (
		`Skills installed in this workspace:\n${lines.join("\n")}\n` +
		`The user can download files you produce. Write user-facing deliverables (documents, exports, generated files) ` +
		`under ${workspace}/artifacts/ (create it if needed), never anywhere else.`
	);
};