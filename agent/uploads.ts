import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Dirent } from "node:fs";
import { HttpError, safeTreePath, workspacePath } from "./http.ts";
import { sha256 } from "./corpus.ts";

export const UPLOADS_DIR = "corpus/uploads";

const uploadsRelativePath = (path: string): string => `${UPLOADS_DIR}/${path}`;

/** Create (or confirm) a directory; a file in the way is a conflict, not a silent replace. */
export const createUploadDir = async (input: {
	readonly workspace: string;
	readonly path: string;
}): Promise<{ readonly path: string }> => {
	const relative = safeTreePath(input.path);
	const absolute = workspacePath(input.workspace, uploadsRelativePath(relative));
	const existing = await stat(absolute).catch(() => null);
	if (existing !== null && !existing.isDirectory()) {
		throw new HttpError(409, {
			error: "not_a_directory",
			message: `${uploadsRelativePath(relative)} already exists and is a file`,
		});
	}
	await mkdir(absolute, { recursive: true });
	return { path: uploadsRelativePath(relative) };
};

export type StagedUpload = {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
};

/** Write one file at its complete client-chosen path, creating the parents. */
export const stageUploadFile = async (input: {
	readonly workspace: string;
	readonly path: string;
	readonly bytes: Uint8Array;
}): Promise<StagedUpload> => {
	const relative = safeTreePath(input.path);
	const absolute = workspacePath(input.workspace, uploadsRelativePath(relative));
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, input.bytes);
	return {
		path: uploadsRelativePath(relative),
		bytes: input.bytes.length,
		sha256: sha256(input.bytes),
	};
};

/** Remove a file or a whole subtree; a missing path is not an error, like `removeRaw`. */
export const removeUploadPath = async (input: {
	readonly workspace: string;
	readonly path: string;
}): Promise<{ readonly path: string }> => {
	const relative = safeTreePath(input.path);
	const absolute = workspacePath(input.workspace, uploadsRelativePath(relative));
	await rm(absolute, { recursive: true, force: true });
	return { path: uploadsRelativePath(relative) };
};

export type UploadTreeEntry = {
	/** Path relative to the uploads root, e.g. `md-to-docx/references/style-guide.md`. */
	readonly path: string;
	readonly kind: "dir" | "file";
	/** File size; directories carry null. */
	readonly bytes: number | null;
};

export type UploadTree = {
	readonly path: string;
	/** True when the entry budget ran out before the walk finished. */
	readonly truncated: boolean;
	readonly entries: readonly UploadTreeEntry[];
};

/** Cap of one tree response (PRD 0003 §6): bounds the payload of a deep upload. */
export const MAX_TREE_ENTRIES = 1000;

/** Walk one subtree, flat and sorted so a parent always precedes its children.
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

/** The recursive listing of the uploads root (empty `path`) or of one subtree. */
export const listUploadTree = async (input: {
	readonly workspace: string;
	readonly path: string;
}): Promise<UploadTree> => {
	const relative = input.path === "" ? "" : safeTreePath(input.path);
	const rooted = relative === "" ? UPLOADS_DIR : uploadsRelativePath(relative);
	const entries: UploadTreeEntry[] = [];
	const complete = await walk(workspacePath(input.workspace, rooted), relative, entries);
	return { path: rooted, truncated: !complete, entries };
};
