// Corpus bytes in the workspace: the only durable home of an uploaded document.
//
// Postgres keeps the metadata, the hashes and the ingestion history; the bytes
// never leave the volume. This module owns the one path rule, so the web app
// never builds a corpus path itself.
//
// Staging only: an upload lands at `corpus/raw/<docId><ext>` and its sha256 is
// computed here. The parse (knowledge-extractor) is PRD 0001 §6.2 work; until it
// exists nothing is written to `corpus/docs/` and no citation can be made.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { HttpError, workspacePath } from "./http.ts";

export const RAW_DIR = "corpus/raw";
/** Sidecar metadata the ingest endpoint writes beside the raw bytes (RFC 0006 §5.2):
 * the control plane owns title and original filename; the sandbox owns the bytes. */
export const META_DIR = "corpus/meta";

/** 10 MiB: the browser upload limit of PRD 0001 §4. The form enforces the same
 * value in `frontend/src/lib/server/upload-limit.ts`; keep the two equal. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Doc ids come from the web app; refuse anything that could become a path. */
export const safeDocId = (value: string): string => {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
		throw new HttpError(400, { error: "invalid_doc_id", message: "docId must be 1-64 of [A-Za-z0-9_-]" });
	}
	return value;
};

/** Keep the upload's own extension, bounded and alphanumeric, or fall back to `.bin`. */
const extensionOf = (filename: string): string => {
	const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
	return match?.[1] === undefined ? ".bin" : `.${match[1].toLowerCase()}`;
};

/** Workspace-relative path of the raw bytes for one document. */
export const rawRelativePath = (docId: string, filename: string): string =>
	`${RAW_DIR}/${safeDocId(docId)}${extensionOf(filename)}`;

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type DocumentMeta = {
	readonly title: string;
	readonly filename: string;
};

const metaRelativePath = (docId: string): string => `${META_DIR}/${safeDocId(docId)}.json`;

/** Write the ingest sidecar: title and original filename of one document. */
export const writeMeta = async (input: {
	readonly workspace: string;
	readonly docId: string;
	readonly meta: DocumentMeta;
}): Promise<void> => {
	const absolute = workspacePath(input.workspace, metaRelativePath(input.docId));
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, `${JSON.stringify({ ...input.meta, at: Date.now() })}\n`);
};

/** Read the sidecar back; absent or malformed falls back to `fallback`. */
export const readMeta = async (
	env: ExecutionEnv,
	docId: string,
	fallback: DocumentMeta,
	context: Context,
): Promise<DocumentMeta> => {
	const read = await env.readTextFile(metaRelativePath(docId), context);
	if (!read.ok) return fallback;
	try {
		const parsed = JSON.parse(read.value) as Partial<DocumentMeta>;
		return {
			title: typeof parsed.title === "string" && parsed.title !== "" ? parsed.title : fallback.title,
			filename: typeof parsed.filename === "string" && parsed.filename !== "" ? parsed.filename : fallback.filename,
		};
	} catch {
		return fallback;
	}
};

export type StagedDocument = {
	readonly docId: string;
	readonly filename: string;
	readonly title: string;
	/** Path as the env resolves it (relative to the env cwd). */
	readonly path: string;
};

/** Every staged document with its sidecar metadata. The citation store's lazy
 * index is built from this listing; the text and its hash are read once there. */
export const listRawDocuments = async (env: ExecutionEnv, context: Context): Promise<readonly StagedDocument[]> => {
	const listed = await env.listDir(RAW_DIR, context);
	if (!listed.ok) return [];
	const documents: StagedDocument[] = [];
	for (const info of [...listed.value].sort((a, b) => a.name.localeCompare(b.name))) {
		if (info.kind !== "file") continue;
		const docId = info.name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
		if (docId === "" || docId === info.name) continue; // no extension: not a staged doc
		const path = `${RAW_DIR}/${info.name}`;
		const meta = await readMeta(env, docId, { title: docId, filename: info.name }, context);
		documents.push({ docId, filename: meta.filename, title: meta.title, path });
	}
	return documents;
};

export type StagedRaw = {
	readonly docId: string;
	readonly path: string;
	readonly bytes: number;
	readonly sourceSha256: string;
};

/** Write the uploaded bytes once and report what arrived. */
export const stageRaw = async (input: {
	readonly workspace: string;
	readonly docId: string;
	readonly filename: string;
	readonly bytes: Uint8Array;
}): Promise<StagedRaw> => {
	const path = rawRelativePath(input.docId, input.filename);
	const absolute = workspacePath(input.workspace, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, input.bytes);
	return {
		docId: input.docId,
		path,
		bytes: input.bytes.length,
		sourceSha256: sha256(input.bytes),
	};
};

/** Remove the raw bytes of one document and its sidecar; a missing file is not an error. */
export const removeRaw = async (input: {
	readonly workspace: string;
	readonly docId: string;
	readonly filename: string;
}): Promise<{ docId: string; path: string }> => {
	const path = rawRelativePath(input.docId, input.filename);
	await rm(workspacePath(input.workspace, path), { force: true });
	await rm(workspacePath(input.workspace, metaRelativePath(input.docId)), { force: true });
	return { docId: input.docId, path };
};
