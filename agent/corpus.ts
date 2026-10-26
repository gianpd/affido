// Corpus path rules and identities: the only module that decides where a
// document's bytes, sidecar, and derived text live inside the workspace.
// Staging, admission, and deletion are RFC 0014's IngestPipeline (ingest.ts);
// Postgres keeps the ingestion history while the bytes never leave the volume.

import { createHash } from "node:crypto";
import { HttpError } from "./http.ts";

export const RAW_DIR = "corpus/raw";
/** The registry (RFC 0014 §5.2): `corpus/meta/<docId>.json` is the single
 * source of truth a document exists at all — admission included. */
export const META_DIR = "corpus/meta";
/** Text derived from a binary upload at staging time (today: PDF via unpdf), the
 * only form of a PDF the citation index can read. Keyed by docId, so the index
 * resolves it without touching the binary bytes. */
export const TEXT_DIR = "corpus/text";

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

/** sha256 of a text's UTF-8 bytes: the hash form both the registry's
 * `textSha256` and the index-build verification use. */
export const sha256OfText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Extensions the pipeline may admit directly as text (RFC 0014 §5.3); a file
 * joins the index only when its bytes are strict UTF-8, decided at ingest. */
const TEXT_EXTENSIONS = new Set([
	"cfg", "conf", "csv", "html", "ini", "js", "json", "log", "md", "mjs", "cjs",
	"py", "rst", "sh", "sql", "srt", "tex", "toml", "ts", "txt", "vtt", "xml", "yaml", "yml",
]);

const extensionOfName = (name: string): string => {
	const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
	return match?.[1] === undefined ? "" : match[1].toLowerCase();
};

export const isPdfFilename = (name: string): boolean => extensionOfName(name) === "pdf";
export const isTextFilename = (name: string): boolean => TEXT_EXTENSIONS.has(extensionOfName(name));

/** docId of one uploads-tree file: `u-` + a readable slice of the sanitized path
 * + a hash of the full path, always a legal `safeDocId` (≤ 64 of [A-Za-z0-9_-]).
 * Deterministic, so the tree path and the registry agree without coordination. */
export const uploadsDocIdOf = (relativePath: string): string => {
	const readable = relativePath
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const hash = createHash("sha256").update(relativePath, "utf8").digest("hex").slice(0, 12);
	return `u-${readable === "" ? "file" : readable}-${hash}`;
};

/** Workspace-relative path of the derived text of one document. */
export const derivedTextRelativePath = (docId: string): string => `${TEXT_DIR}/${safeDocId(docId)}.txt`;
