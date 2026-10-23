import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SandboxError } from './sandbox';

/**
 * The marketplace catalog is static content owned by the web app (RFC 0009
 * D1): the repo bundle under `marketplace/skills/`, read at request time. No
 * database rows, no manager involvement — the same way the landing page is
 * static. The app runs from the repo (dev and build alike), so the bundle is
 * one directory above the frontend root.
 */
const CATALOG_ROOT = resolve(process.cwd(), '..', 'marketplace', 'skills');
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_SEGMENT = /^[^/?#]+$/;

export type CatalogFile = {
	path: string;
	sha256: string;
	bytes: number;
};

export type CatalogSkill = {
	name: string;
	version: string;
	description: string;
	requires: string[];
	files: CatalogFile[];
};

export type CatalogManifest = {
	name: string;
	version: string;
	description: string;
	requires: { nodeLibraries?: string[] };
	files: { path: string; sha256: string }[];
};

const skillDirectory = (name: string): string => {
	if (!NAME_PATTERN.test(name)) {
		throw new SandboxError(400, 'invalid_skill', 'Unknown skill in the catalog.');
	}
	return join(CATALOG_ROOT, name);
};

/** Every catalog entry, sorted by name. A malformed manifest skips its skill:
 * the catalog page degrades to the well-formed entries instead of erroring. */
export const listCatalog = async (): Promise<CatalogSkill[]> => {
	const entries = await readdir(CATALOG_ROOT, { withFileTypes: true }).catch(() => []);
	const skills: CatalogSkill[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue;
		try {
			const manifest = JSON.parse(
				await readFile(join(CATALOG_ROOT, entry.name, 'marketplace.json'), 'utf8')
			) as CatalogManifest;
			const files = await Promise.all(
				(manifest.files ?? []).map(async (file) => ({
					path: file.path,
					sha256: file.sha256,
					bytes: (await stat(join(CATALOG_ROOT, entry.name, file.path))).size
				}))
			);
			skills.push({
				name: entry.name,
				version: manifest.version ?? '0.0.0',
				description: manifest.description ?? '',
				requires: manifest.requires?.nodeLibraries ?? [],
				files
			});
		} catch {
			continue;
		}
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
};

/** One catalog manifest, verbatim: what an install streams file-by-file and
 * what the sandbox verifies against. */
export const readCatalogManifest = async (name: string): Promise<CatalogManifest> => {
	let manifest: CatalogManifest;
	try {
		manifest = JSON.parse(await readFile(join(skillDirectory(name), 'marketplace.json'), 'utf8'));
	} catch {
		throw new SandboxError(404, 'unknown_skill', `"${name}" is not in the catalog.`);
	}
	if (manifest.name !== name || !Array.isArray(manifest.files) || manifest.files.length === 0) {
		throw new SandboxError(500, 'invalid_manifest', `"${name}" has a malformed manifest.`);
	}
	return manifest;
};

/** One bundle file's bytes: the source of an install write. The sandbox
 * re-validates the destination path; here we only refuse the obviously
 * non-relative, so a bad path never leaves the process. */
export const readCatalogFile = async (
	name: string,
	path: string
): Promise<Uint8Array<ArrayBuffer>> => {
	if (
		path === '' ||
		path.length > 240 ||
		path.split('/').some((segment) => !PATH_SEGMENT.test(segment))
	) {
		throw new SandboxError(400, 'invalid_path', `"${path}" is not a bundle file path.`);
	}
	try {
		return new Uint8Array(await readFile(join(skillDirectory(name), path)));
	} catch {
		throw new SandboxError(404, 'unknown_file', `"${name}" has no file "${path}".`);
	}
};
