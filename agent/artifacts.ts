// The artifacts root: the agent's download surface (RFC 0009 D5). Everything
// the model produces for the user lands under WORKSPACE/artifacts/ and is
// served back as a download — confined, capped, symlink-free, and typed from a
// static extension map. Like uploads, all of it is plain filesystem work that
// never activates the agent.

import { lstat, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import { HttpError, safeTreePath, workspacePath } from "./http.ts";
import { sha256 } from "./corpus.ts";
import { MAX_TREE_ENTRIES, type UploadTree, type UploadTreeEntry } from "./uploads.ts";

export const ARTIFACTS_DIR = "artifacts";

/** The admission-time snapshot of `artifacts/`, stored with the run state so a
 * replay of the same `requestId` re-derives the same artifact list (R9). */
export type ArtifactBaseline = Readonly<Record<string, { readonly size: number; readonly mtimeMs: number }>>;

/** R6: one download stays bounded; past it the agent refuses with 413. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

const artifactsRelativePath = (path: string): string => `${ARTIFACTS_DIR}/${path}`;

/** Static extension map (§5.6): no sniffing, no inline serving. Unknown
 * extensions and `svg` fall back to a plain byte stream. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	csv: "text/csv",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	zip: "application/zip",
};

export const artifactContentType = (path: string): string =>
	CONTENT_TYPES[ /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1]?.toLowerCase() ?? "" ] ?? "application/octet-stream";

/** Always an attachment; the basename comes from a validated path (no `"`, no
 * control characters, no `\`), so header splitting is not possible. */
export const artifactDisposition = (path: string): string => {
	const basename = path.split("/").at(-1) ?? path;
	return `attachment; filename="${basename}"`;
};

/** lstat every component from the artifacts root down: a symlink anywhere is
 * 404, so `ln -s /run/secrets/... artifacts/leak` is not an exfiltration path
 * (§10). The final component must be a regular file. */
const artifactFilePath = async (workspace: string, relative: string): Promise<string> => {
	const validated = safeTreePath(relative);
	const segments = validated.split("/");
	let absolute = workspacePath(workspace, ARTIFACTS_DIR);
	for (const [index, segment] of segments.entries()) {
		absolute = join(absolute, segment);
		const info = await lstat(absolute).catch(() => null);
		if (info === null) throw new HttpError(404, { error: "not_found", message: `${artifactsRelativePath(validated)} does not exist` });
		if (info.isSymbolicLink()) throw new HttpError(404, { error: "not_found", message: `${artifactsRelativePath(validated)} is not downloadable` });
		if (index < segments.length - 1 && !info.isDirectory()) {
			throw new HttpError(404, { error: "not_found", message: `${artifactsRelativePath(validated)} does not exist` });
		}
	}
	const final = await lstat(absolute);
	if (final.isDirectory()) throw new HttpError(400, { error: "is_a_directory", message: "directories are not downloadable; list them with GET /artifacts" });
	if (!final.isFile()) throw new HttpError(404, { error: "not_found", message: `${artifactsRelativePath(validated)} is not downloadable` });
	return absolute;
};

export type ArtifactDownload = {
	readonly path: string;
	readonly bytes: number;
	readonly contentType: string;
	readonly disposition: string;
	readonly body: Buffer;
};

/** Read one artifact, bounded: a stat-checked size, then one read of exactly
 * that many bytes, so a file that grows mid-read cannot exceed the cap. */
export const readArtifact = async (input: {
	readonly workspace: string;
	readonly path: string;
}): Promise<ArtifactDownload> => {
	const absolute = await artifactFilePath(input.workspace, input.path);
	const handle = await open(absolute, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new HttpError(404, { error: "not_found", message: `${input.path} is not downloadable` });
		if (info.size > MAX_ARTIFACT_BYTES) {
			throw new HttpError(413, { error: "artifact_too_large", message: `${input.path} exceeds ${MAX_ARTIFACT_BYTES} bytes` });
		}
		const body = Buffer.alloc(info.size);
		const { bytesRead } = await handle.read(body, 0, info.size, 0);
		return {
			path: input.path,
			bytes: bytesRead,
			contentType: artifactContentType(input.path),
			disposition: artifactDisposition(input.path),
			body,
		};
	} finally {
		await handle.close();
	}
};

/** Walk one subtree of the artifacts root, skipping symlinks entirely (§5.6).
 * Returns false when the entry budget ran out. */
const walk = async (absolute: string, relative: string, out: UploadTreeEntry[]): Promise<boolean> => {
	let listed: Dirent[];
	try {
		listed = await readdir(absolute, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return true; // vanished or a file: nothing under it
		throw error;
	}
	for (const entry of [...listed].sort((a, b) => a.name.localeCompare(b.name))) {
		if (out.length >= MAX_TREE_ENTRIES) return false;
		const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
		if (entry.isSymbolicLink()) continue; // never listed, never downloadable
		if (entry.isDirectory()) {
			out.push({ path: childRelative, kind: "dir", bytes: null });
			if (!(await walk(join(absolute, entry.name), childRelative, out))) return false;
		} else if (entry.isFile()) {
			const info = await stat(join(absolute, entry.name)).catch(() => null);
			out.push({ path: childRelative, kind: "file", bytes: info?.size ?? null });
		}
	}
	return true;
};

/** The recursive listing of the artifacts root (empty `path`) or one subtree. */
export const listArtifactTree = async (input: {
	readonly workspace: string;
	readonly path: string;
}): Promise<UploadTree> => {
	const relative = input.path === "" ? "" : safeTreePath(input.path);
	const rooted = relative === "" ? ARTIFACTS_DIR : artifactsRelativePath(relative);
	const entries: UploadTreeEntry[] = [];
	const complete = await walk(workspacePath(input.workspace, rooted), relative, entries);
	return { path: rooted, truncated: !complete, entries };
};

/** Remove a file or a whole subtree; a missing path is not an error. */
export const removeArtifactPath = async (input: {
	readonly workspace: string;
	readonly path: string;
}): Promise<{ readonly path: string }> => {
	const relative = safeTreePath(input.path);
	const absolute = workspacePath(input.workspace, artifactsRelativePath(relative));
	await rm(absolute, { recursive: true, force: true });
	return { path: artifactsRelativePath(relative) };
};

export type ArtifactStats = { readonly size: number; readonly mtimeMs: number };
/** Path relative to the artifacts root -> its size and mtime. */
export type ArtifactSnapshot = ReadonlyMap<string, ArtifactStats>;

/** One bounded walk of the artifacts root (§5.7 step 1): the diff baseline.
 * A missing root is the empty snapshot — the common case costs one failed stat. */
export const snapshotArtifacts = async (input: { readonly workspace: string }): Promise<Map<string, ArtifactStats>> => {
	const snapshot = new Map<string, ArtifactStats>();
	const entries: UploadTreeEntry[] = [];
	await walk(workspacePath(input.workspace, ARTIFACTS_DIR), "", entries);
	for (const entry of entries) {
		if (entry.kind !== "file") continue;
		const info = await stat(workspacePath(input.workspace, artifactsRelativePath(entry.path))).catch(() => null);
		if (info !== null) snapshot.set(entry.path, { size: info.size, mtimeMs: info.mtimeMs });
	}
	return snapshot;
};

export type ArtifactChange = { readonly path: string; readonly size: number; readonly mtimeMs: number };

/** Pure diff of two snapshots: files created, resized, or re-written (mtime
 * moved) are the run's artifacts; deletions are not reported (§5.7 step 2). */
export const diffArtifacts = (before: ArtifactSnapshot, after: ArtifactSnapshot): readonly ArtifactChange[] => {
	const changes: ArtifactChange[] = [];
	for (const [path, stats] of after) {
		const prior = before.get(path);
		if (prior === undefined || prior.size !== stats.size || prior.mtimeMs !== stats.mtimeMs) {
			changes.push({ path, ...stats });
		}
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
};

export type ArtifactView = {
	/** Path relative to the artifacts root. */
	readonly path: string;
	readonly bytes: number;
	/** sha256 of the bytes now; null when the file is above the download cap. */
	readonly sha256: string | null;
	readonly modifiedAt: string;
};

/** The run's artifacts as the `/prompt` envelope reports them (R7): the diff
 * of the admission baseline against the disk now — re-derived on every replay,
 * never stored with the answer. */
export const describeArtifacts = async (input: {
	readonly workspace: string;
	readonly baseline: ArtifactBaseline;
}): Promise<readonly ArtifactView[]> => {
	const after = await snapshotArtifacts({ workspace: input.workspace });
	const changes = diffArtifacts(new Map(Object.entries(input.baseline)), after);
	return Promise.all(
		changes.map(async (change) => {
			const bytes = await (async () => {
				if (change.size > MAX_ARTIFACT_BYTES) return null;
				try {
					const download = await readArtifact({ workspace: input.workspace, path: change.path });
					return sha256(download.body);
				} catch {
					return null; // vanished or became a directory since the walk: report no hash
				}
			})();
			return {
				path: change.path,
				bytes: change.size,
				sha256: bytes,
				modifiedAt: new Date(change.mtimeMs).toISOString(),
			};
		}),
	);
};
