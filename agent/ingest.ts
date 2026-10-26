// One ingestion pipeline, one index registry (RFC 0014). Every external entry
// point — POST /ingest (single documents), POST /uploads/file (the user's
// tree), and any future one — stages, admits, registers, and deletes documents
// through this class. Staging, text admission, metadata, and deletion happen
// exactly once, here, in one order:
//
//   1. stage the bytes verbatim at the target's location
//   2. admit: decide `indexing` ("text" | "derived" | "none") and `textPath`,
//      deriving PDF text into corpus/text/<docId>.txt, validating strict
//      UTF-8 for text extensions; whatever text is admitted, its hash becomes
//      `textSha256`, verified at every index build
//   3. register: write the corpus/meta/<docId>.json sidecar — the single
//      source of truth a document exists at all
//   4. report: return Staged; the control plane records exactly this object
//
// The citation store never inspects filenames and never reads a file's bytes
// unless the registry declares those bytes to be valid UTF-8 text.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Dirent } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import { safeTreePath, workspacePath } from "./http.ts";
import {
	derivedTextRelativePath,
	isPdfFilename,
	isTextFilename,
	META_DIR,
	RAW_DIR,
	rawRelativePath,
	safeDocId,
	sha256,
	sha256OfText,
	uploadsDocIdOf,
} from "./corpus.ts";
import { UPLOADS_DIR } from "./uploads.ts";

/** Discriminated by target, never by caller: one class, two roots (RFC 0014 §5.1). */
export type IngestTarget =
	| { readonly kind: "document"; readonly docId: string; readonly filename: string; readonly title?: string }
	| { readonly kind: "tree-path"; readonly path: string };

/** What every staging caller reports; the control plane records exactly this. */
export type Staged = {
	readonly docId: string; // control-plane id, or uploadsDocIdOf(path)
	readonly path: string; // corpus/raw/<docId>.<ext> | corpus/uploads/<path>
	readonly bytes: number;
	readonly sourceSha256: string;
	/** indexing !== "none": true exactly when the document joined the citation index. */
	readonly searchable: boolean;
	readonly indexing: "text" | "derived" | "none";
};

/** How a document's text may enter the citation index, decided once at ingest. */
export type Indexing = "text" | "derived" | "none";

/** The registry entry (RFC 0014 §5.2): `corpus/meta/<docId>.json` is the single
 * source of truth a document exists at all. The two hashes pin the two files an
 * admitted document consists of: `sourceSha256` the staged bytes, `textSha256`
 * the exact text the index may read. `textPath`/`textSha256` are null when
 * `indexing` is "none". */
export type CorpusSidecar = {
	readonly docId: string;
	readonly root: "raw" | "uploads";
	readonly title: string;
	readonly filename: string;
	readonly stagedPath: string;
	readonly sourceSha256: string;
	readonly bytes: number;
	readonly indexing: Indexing;
	readonly textPath: string | null;
	readonly textSha256: string | null;
	readonly at: number;
};

const isIndexing = (value: unknown): value is Indexing =>
	value === "text" || value === "derived" || value === "none";

/** Parse one sidecar leniently: absent or malformed registry entries read as
 * `null`, which means "not registered" to every consumer. */
export const parseSidecar = (raw: string): CorpusSidecar | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const sidecar = parsed as Record<string, unknown>;
	const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
	const docId = stringOrNull(sidecar.docId);
	const title = stringOrNull(sidecar.title);
	const filename = stringOrNull(sidecar.filename);
	const stagedPath = stringOrNull(sidecar.stagedPath);
	const sourceSha256 = stringOrNull(sidecar.sourceSha256);
	const textPath = stringOrNull(sidecar.textPath);
	const textSha256 = stringOrNull(sidecar.textSha256);
	if (
		docId === null || title === null || filename === null || stagedPath === null || sourceSha256 === null ||
		(sidecar.root !== "raw" && sidecar.root !== "uploads") ||
		!isIndexing(sidecar.indexing) ||
		typeof sidecar.bytes !== "number" || typeof sidecar.at !== "number" ||
		// indexing "none" admits no text; the other two require it, hashed
		(sidecar.indexing === "none" ? textPath !== null || textSha256 !== null : textPath === null || textSha256 === null)
	) {
		return null;
	}
	return {
		docId,
		root: sidecar.root,
		title,
		filename,
		stagedPath,
		sourceSha256,
		bytes: sidecar.bytes,
		indexing: sidecar.indexing,
		textPath,
		textSha256,
		at: sidecar.at,
	};
};

const metaRelativePath = (docId: string): string => `${META_DIR}/${safeDocId(docId)}.json`;

const writeWorkspaceFile = async (workspace: string, path: string, contents: string | Uint8Array): Promise<void> => {
	const absolute = workspacePath(workspace, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, contents);
};

/** Write the registry entry: both roots, same shape. */
const writeSidecar = async (input: { readonly workspace: string; readonly sidecar: CorpusSidecar }): Promise<void> => {
	await writeWorkspaceFile(input.workspace, metaRelativePath(input.sidecar.docId), `${JSON.stringify(input.sidecar)}\n`);
};

/** Read one registry entry; absent or malformed reads as null ("not registered"). */
export const readSidecar = async (workspace: string, docId: string): Promise<CorpusSidecar | null> => {
	const read = await readFile(workspacePath(workspace, metaRelativePath(docId)), "utf8").catch(() => null);
	return read === null ? null : parseSidecar(read);
};

/** Bounds of one staging-time extraction: the upload is already bounded, but
 * parsing runs on the request's event loop, so pages, image size and time are
 * capped too. Unchanged from pre-RFC staging. */
const DERIVED_MAX_PAGES = 1000;
const DERIVED_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const DERIVED_TIMEOUT_MS = 30_000;

const derivePdfText = async (bytes: Uint8Array): Promise<string | null> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			(async () => {
				const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: DERIVED_MAX_IMAGE_BYTES });
				if (pdf.numPages > DERIVED_MAX_PAGES) return null;
				const { text } = await extractText(pdf, { mergePages: true });
				return typeof text === "string" && text.trim() !== "" ? text : null;
			})(),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), DERIVED_TIMEOUT_MS);
				timer.unref();
			}),
		]);
	} catch {
		return null; // malformed or encrypted PDF, or extraction failed: not indexable, not an upload error
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

type Admission = {
	readonly indexing: Indexing;
	readonly textPath: string | null;
	readonly textSha256: string | null;
};

/** The admission decision of §5.3, evaluated only here. A re-ingested docId
 * whose new bytes yield no text drops the stale derived text: the registry
 * never points at text the current bytes did not produce. */
const admit = async (input: {
	readonly workspace: string;
	readonly docId: string;
	readonly filename: string;
	readonly stagedPath: string;
	readonly bytes: Uint8Array;
	readonly sourceSha256: string;
}): Promise<Admission> => {
	if (isPdfFilename(input.filename)) {
		const textPath = derivedTextRelativePath(input.docId);
		const text = await derivePdfText(input.bytes);
		if (text === null) {
			await rm(workspacePath(input.workspace, textPath), { force: true });
			return { indexing: "none", textPath: null, textSha256: null };
		}
		await writeWorkspaceFile(input.workspace, textPath, text);
		return { indexing: "derived", textPath, textSha256: sha256OfText(text) };
	}
	if (isTextFilename(input.filename)) {
		// Node's utf8 decoding never fails: invalid sequences silently become
		// U+FFFD. A file is text evidence only when the decode round-trips to the
		// exact bytes (R4); otherwise it stays staged — possibly a fine workspace
		// file — but is never citation evidence.
		const decoded = Buffer.from(input.bytes).toString("utf8");
		if (Buffer.compare(Buffer.from(decoded, "utf8"), input.bytes) === 0) {
			return { indexing: "text", textPath: input.stagedPath, textSha256: input.sourceSha256 };
		}
	}
	return { indexing: "none", textPath: null, textSha256: null };
};

const basename = (path: string): string => path.split("/").pop() ?? path;

/** Collect every file below one tree root, relative to it, uncapped: deletion
 * and migration must see the whole tree or they would leave registry drift. */
const collectTreeFiles = async (rootAbsolute: string): Promise<readonly string[]> => {
	let listed: Dirent[];
	try {
		listed = await readdir(rootAbsolute, { withFileTypes: true });
	} catch {
		return []; // no tree yet
	}
	const out: string[] = [];
	for (const entry of listed) {
		if (entry.isDirectory()) {
			for (const child of await collectTreeFiles(join(rootAbsolute, entry.name))) {
				out.push(`${entry.name}/${child}`);
			}
		} else if (entry.isFile()) {
			out.push(entry.name);
		}
	}
	return out;
};

export class IngestPipeline {
	readonly #workspace: string;

	constructor(workspace: string) {
		this.#workspace = workspace;
	}

	/** Stage bytes and decide admission, in the fixed order, for every caller. */
	async stage(input: { readonly bytes: Uint8Array; readonly target: IngestTarget }): Promise<Staged> {
		const bytes = Buffer.from(input.bytes);
		const sourceSha256 = sha256(bytes);
		if (input.target.kind === "document") {
			const docId = safeDocId(input.target.docId);
			const filename = input.target.filename;
			const stagedPath = rawRelativePath(docId, filename);
			await writeWorkspaceFile(this.#workspace, stagedPath, bytes);
			const admission = await admit({
				workspace: this.#workspace,
				docId,
				filename,
				stagedPath,
				bytes,
				sourceSha256,
			});
			await writeSidecar({
				workspace: this.#workspace,
				sidecar: {
					docId,
					root: "raw",
					title: input.target.title === undefined || input.target.title === "" ? filename : input.target.title,
					filename,
					stagedPath,
					sourceSha256,
					bytes: bytes.length,
					indexing: admission.indexing,
					textPath: admission.textPath,
					textSha256: admission.textSha256,
					at: Date.now(),
				},
			});
			return {
				docId,
				path: stagedPath,
				bytes: bytes.length,
				sourceSha256,
				searchable: admission.indexing !== "none",
				indexing: admission.indexing,
			};
		}
		const relative = safeTreePath(input.target.path);
		const docId = uploadsDocIdOf(relative);
		const stagedPath = `${UPLOADS_DIR}/${relative}`;
		await writeWorkspaceFile(this.#workspace, stagedPath, bytes);
		const admission = await admit({
			workspace: this.#workspace,
			docId,
			filename: relative,
			stagedPath,
			bytes,
			sourceSha256,
		});
		await writeSidecar({
			workspace: this.#workspace,
			sidecar: {
				docId,
				root: "uploads",
				title: relative, // the tree path is the title, as the uploads branch always did
				filename: basename(relative),
				stagedPath,
				sourceSha256,
				bytes: bytes.length,
				indexing: admission.indexing,
				textPath: admission.textPath,
				textSha256: admission.textSha256,
				at: Date.now(),
			},
		});
		return {
			docId,
			path: stagedPath,
			bytes: bytes.length,
			sourceSha256,
			searchable: admission.indexing !== "none",
			indexing: admission.indexing,
		};
	}

	/** Remove staged bytes, derived text, and sidecar together (R9). */
	async remove(input: { readonly target: IngestTarget }): Promise<void> {
		const targets =
			input.target.kind === "document"
				? [{ docId: safeDocId(input.target.docId), stagedPath: rawRelativePath(input.target.docId, input.target.filename) }]
				: await this.#treeTargets(safeTreePath(input.target.path));
		for (const target of targets) {
			await rm(workspacePath(this.#workspace, target.stagedPath), { force: true });
			await rm(workspacePath(this.#workspace, metaRelativePath(target.docId)), { force: true });
			await rm(workspacePath(this.#workspace, derivedTextRelativePath(target.docId)), { force: true });
		}
		if (input.target.kind === "tree-path") {
			// The path itself may be a directory or have vanished: one rm closes both.
			await rm(workspacePath(this.#workspace, `${UPLOADS_DIR}/${safeTreePath(input.target.path)}`), {
				recursive: true,
				force: true,
			});
		}
	}

	/** Every staged document at or below one tree path, with its registry keys:
	 * subtree children carry the full tree-relative path, a plain file is itself. */
	async #treeTargets(relative: string): Promise<readonly { readonly docId: string; readonly stagedPath: string }[]> {
		const absolute = workspacePath(this.#workspace, `${UPLOADS_DIR}/${relative}`);
		const info = await stat(absolute).catch(() => null);
		if (info === null) return [];
		const treeRelatives = info.isDirectory()
			? (await collectTreeFiles(absolute)).map((child) => `${relative}/${child}`)
			: [relative];
		return treeRelatives.map((treeRelative) => ({
			docId: uploadsDocIdOf(treeRelative),
			stagedPath: `${UPLOADS_DIR}/${treeRelative}`,
		}));
	}

	/** The one-time migration pass (RFC 0014 §6): register pre-RFC files with the
	 * same admission rules, reuse derived text that already exists, drop orphaned
	 * `corpus/text/` entries. Idempotent: a complete sidecar is left alone, so a
	 * second run registers nothing. After it, read-time never decides anything. */
	async bootstrap(log?: (message: string) => void): Promise<void> {
		let registered = 0;
		let removedText = 0;
		// The last directory walks the read path will ever do.
		const rawNames = await collectTreeFiles(workspacePath(this.#workspace, RAW_DIR));
		for (const name of rawNames) {
			const docId = name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
			if (docId === "" || docId === name) continue; // no extension: not a staged doc
			const stagedPath = `${RAW_DIR}/${name}`;
			if ((await readSidecar(this.#workspace, docId)) !== null) continue;
			const old = await this.#legacyMeta(docId); // pre-RFC {title, filename} sidecar, if any
			const bytes = await readFile(workspacePath(this.#workspace, stagedPath)).catch(() => null);
			if (bytes === null) continue; // vanished mid-walk
			const sourceSha256 = sha256(bytes);
			const admission = await this.#registerAdmission(docId, name, stagedPath, bytes, sourceSha256);
			await writeSidecar({
				workspace: this.#workspace,
				sidecar: {
					docId,
					root: "raw",
					title: old.title ?? docId,
					filename: old.filename ?? name,
					stagedPath,
					sourceSha256,
					bytes: bytes.length,
					indexing: admission.indexing,
					textPath: admission.textPath,
					textSha256: admission.textSha256,
					at: Date.now(),
				},
			});
			registered++;
		}
		const treeFiles = await collectTreeFiles(workspacePath(this.#workspace, UPLOADS_DIR));
		for (const relative of treeFiles) {
			const docId = uploadsDocIdOf(relative);
			const stagedPath = `${UPLOADS_DIR}/${relative}`;
			if ((await readSidecar(this.#workspace, docId)) !== null) continue;
			const bytes = await readFile(workspacePath(this.#workspace, stagedPath)).catch(() => null);
			if (bytes === null) continue;
			const sourceSha256 = sha256(bytes);
			const admission = await this.#registerAdmission(docId, relative, stagedPath, bytes, sourceSha256);
			await writeSidecar({
				workspace: this.#workspace,
				sidecar: {
					docId,
					root: "uploads",
					title: relative,
					filename: basename(relative),
					stagedPath,
					sourceSha256,
					bytes: bytes.length,
					indexing: admission.indexing,
					textPath: admission.textPath,
					textSha256: admission.textSha256,
					at: Date.now(),
				},
			});
			registered++;
		}
		// Derived text is registry-owned: an entry no sidecar references is deleted.
		const textNames = await collectTreeFiles(workspacePath(this.#workspace, "corpus/text"));
		for (const name of textNames) {
			if (!name.endsWith(".txt")) continue;
			const docId = name.slice(0, -".txt".length);
			const sidecar = await readSidecar(this.#workspace, docId);
			if (sidecar !== null && sidecar.textPath === derivedTextRelativePath(docId)) continue;
			await rm(workspacePath(this.#workspace, `corpus/text/${name}`), { force: true });
			removedText++;
		}
		log?.(`ingest registry bootstrap: registered ${registered} document(s), removed ${removedText} orphaned derived text file(s)`);
	}

	/** Admission for migration (§6 step 2): a PDF whose derived text already sits
	 * in `corpus/text/` takes `textSha256` from those bytes; extraction runs only
	 * when the text is absent. */
	async #registerAdmission(
		docId: string,
		filename: string,
		stagedPath: string,
		bytes: Uint8Array,
		sourceSha256: string,
	): Promise<Admission> {
		if (isPdfFilename(filename)) {
			const textPath = derivedTextRelativePath(docId);
			const existing = await readFile(workspacePath(this.#workspace, textPath), "utf8").catch(() => null);
			if (existing !== null && existing.trim() !== "") {
				return { indexing: "derived", textPath, textSha256: sha256OfText(existing) };
			}
		}
		return admit({ workspace: this.#workspace, docId, filename, stagedPath, bytes, sourceSha256 });
	}

	/** The pre-RFC raw sidecar ({title, filename, at}), read leniently. */
	async #legacyMeta(docId: string): Promise<{ readonly title: string | null; readonly filename: string | null }> {
		const raw = await readFile(workspacePath(this.#workspace, metaRelativePath(docId)), "utf8").catch(() => null);
		if (raw === null) return { title: null, filename: null };
		try {
			const parsed = JSON.parse(raw) as Partial<{ title: unknown; filename: unknown }>;
			return {
				title: typeof parsed.title === "string" && parsed.title !== "" ? parsed.title : null,
				filename: typeof parsed.filename === "string" && parsed.filename !== "" ? parsed.filename : null,
			};
		} catch {
			return { title: null, filename: null };
		}
	}
}
