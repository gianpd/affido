// WorkspaceCitationStore: the v1 `CitationStore` over the staged corpus
// (RFC 0006 §5.2). Documents are the files in `corpus/raw/<docId><ext>` plus
// the uploads tree under `corpus/uploads/` — one bucket, two ingestion modes.
// Titles and original filenames of raw documents come from the sidecar
// `corpus/meta/<docId>.json` the ingest endpoint writes (the control plane
// owns the metadata; the bytes never leave the volume); uploads-tree files
// carry their tree path as the title. PDFs of either root are indexed through
// the derived text of `corpus/text/<docId>.txt`. When RFC 0005 lands, a
// CatalogStore implements the same port against Postgres + object storage;
// nothing here or in the tools changes.
//
// Reads go through the injected execution env, read-only; no write ever touches
// `corpus/raw/`. Text is decoded server-side; `version` is always 1 here.
// All offsets are code points; the walkers below never allocate a copy of the
// document just to count them.

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	codePointsBefore,
	citationIdOf,
	DEFAULT_GREP_LIMIT,
	DEFAULT_RADIUS,
	DEFAULT_READ_CHARS,
	GREP_LINE_PREFIX_CHARS,
	lineOf,
	lineTableOf,
	MAX_GREP_LIMIT,
	MAX_QUOTE_CHARS,
	MAX_RADIUS,
	MAX_READ_CHARS,
	unsafePattern,
	VerifyError,
	type Annotation,
	type CitationStore,
	type CorpusDocument,
	type GrepHit,
	type ReadLine,
	type ReadWindow,
	type VerifyReason,
} from "./citation-store.ts";
import { derivedTextRelativePath, isPdfFilename, isTextFilename, listRawDocuments, uploadsDocIdOf } from "./corpus.ts";
import { UPLOADS_DIR } from "./uploads.ts";

/** Scan budget of one grep, in lines: bounds a slow pattern over a big corpus. */
const GREP_SCAN_BUDGET_LINES = 200_000;

type LineTable = ReturnType<typeof lineTableOf>;

type IndexedDocument = CorpusDocument & {
	readonly table: LineTable;
};

const sha256OfText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The utf16 index `count` code points after `from`, clamped to the text length. */
const advanceCodePoints = (text: string, from: number, count: number): number => {
	let index = from;
	let seen = 0;
	while (index < text.length && seen < count) {
		const code = text.charCodeAt(index);
		index += code >= 0xd800 && code <= 0xdbff ? 2 : 1; // skip a whole surrogate pair
		seen++;
	}
	return Math.min(index, text.length);
};

/** The utf16 index `count` code points before `from`, clamped to 0. */
const retreatCodePoints = (text: string, from: number, count: number): number => {
	let index = from;
	let seen = 0;
	while (index > 0 && seen < count) {
		const code = text.charCodeAt(index - 1);
		index -= code >= 0xdc00 && code <= 0xdfff ? 2 : 1; // step back over a whole pair
		seen++;
	}
	return Math.max(index, 0);
};

/** The first `count` code points of `text`, as a string. */
const prefixCodePoints = (text: string, count: number): string => text.slice(0, advanceCodePoints(text, 0, count));

/** Load and decode every staged document once per store lifetime: the staged
 * documents of corpus/raw, then the uploads tree. A text file (by extension)
 * is indexed from its bytes; a PDF from its derived text under corpus/text/;
 * any other binary is staged but never indexed — grep over undecoded bytes is
 * noise, not evidence. An uploads file whose docId collides with a corpus/raw
 * document loses: raw ids are the control plane's, tree ids are derived. */
const UPLOADS_INDEX_FILES = 500;

const walkUploadFiles = async (
	env: ExecutionEnv,
	directory: string,
	out: string[],
	context: Context,
): Promise<void> => {
	const listed = await env.listDir(directory, context);
	if (!listed.ok) return; // no uploads tree yet: nothing to index
	for (const info of [...listed.value].sort((a, b) => a.name.localeCompare(b.name))) {
		if (out.length >= UPLOADS_INDEX_FILES) return;
		const child = directory === UPLOADS_DIR ? `${UPLOADS_DIR}/${info.name}` : `${directory}/${info.name}`;
		if (info.kind === "directory") await walkUploadFiles(env, child, out, context);
		else if (info.kind === "file") out.push(child);
	}
};

const basename = (path: string): string => path.split("/").pop() ?? path;

const loadDocuments = async (env: ExecutionEnv, context: Context): Promise<readonly CorpusDocument[]> => {
	const staged = await listRawDocuments(env, context);
	const documents: CorpusDocument[] = [];
	const docIds = new Set<string>();
	for (const item of staged) {
		const read = await env.readTextFile(item.path, context);
		if (!read.ok) continue; // raced with a delete; the document is simply absent
		docIds.add(item.docId);
		documents.push({
			docId: item.docId,
			filename: item.filename,
			title: item.title,
			version: 1,
			text: read.value,
			textSha256: sha256OfText(read.value),
		});
	}
	const uploadFiles: string[] = [];
	await walkUploadFiles(env, UPLOADS_DIR, uploadFiles, context);
	for (const path of uploadFiles) {
		const name = path.slice(UPLOADS_DIR.length + 1);
		const docId = uploadsDocIdOf(name);
		if (docIds.has(docId)) continue;
		let text: string | null = null;
		if (isTextFilename(name)) {
			const read = await env.readTextFile(path, context);
			text = read.ok ? read.value : null;
		} else if (isPdfFilename(name)) {
			const read = await env.readTextFile(derivedTextRelativePath(docId), context);
			text = read.ok ? read.value : null;
		}
		if (text === null || text === "") continue; // binary without derived text: staged, not indexed
		docIds.add(docId);
		documents.push({
			docId,
			filename: basename(name),
			title: name,
			version: 1,
			text,
			textSha256: sha256OfText(text),
		});
	}
	return documents;
};

export class WorkspaceCitationStore implements CitationStore {
	readonly #env: ExecutionEnv;
	readonly #context: Context;
	#indexed: Promise<Map<string, IndexedDocument>> | undefined;

	constructor(env: ExecutionEnv, context: Context) {
		this.#env = env;
		this.#context = context;
	}

	#documents(): Promise<Map<string, IndexedDocument>> {
		this.#indexed ??= loadDocuments(this.#env, this.#context).then((documents) => {
			const map = new Map<string, IndexedDocument>();
			for (const document of documents) {
				map.set(document.docId, { ...document, table: lineTableOf(document.text) });
			}
			return map;
		});
		return this.#indexed;
	}

	/** Drop the index so the next call re-reads the corpus (uploads, deletes). */
	invalidate(): void {
		this.#indexed = undefined;
	}

	async documents(): Promise<readonly CorpusDocument[]> {
		const map = await this.#documents();
		return [...map.values()].map(({ table: _table, ...document }) => document);
	}

	async #doc(docId: string): Promise<IndexedDocument> {
		const map = await this.#documents();
		const document = map.get(docId);
		if (document === undefined) throw new VerifyError("not_found", `no corpus document ${docId}`);
		return document;
	}

	async grepLines(input: {
		readonly pattern: string;
		readonly docIds?: readonly string[];
		readonly limit?: number;
	}): Promise<{ readonly hits: readonly GrepHit[]; readonly truncated: boolean }> {
		if (unsafePattern(input.pattern)) throw new VerifyError("unsafe_pattern", input.pattern.slice(0, 120));
		let pattern: RegExp;
		try {
			pattern = new RegExp(input.pattern, "g");
		} catch {
			throw new VerifyError("unsafe_pattern", input.pattern.slice(0, 120));
		}
		const limit = Math.min(Math.max(input.limit ?? DEFAULT_GREP_LIMIT, 1), MAX_GREP_LIMIT);
		const documents = [...(await this.#documents()).values()].filter(
			(document) => input.docIds === undefined || input.docIds.includes(document.docId),
		);
		if (documents.length === 0) throw new VerifyError("not_found", "no document matches the request");
		const hits: GrepHit[] = [];
		let truncated = false;
		let completed = true;
		let scanned = 0;
		outer: for (const document of documents) {
			for (let line = 1; line <= document.table.utf16.length; line++) {
				if (scanned >= GREP_SCAN_BUDGET_LINES) {
					completed = false;
					truncated = true;
					break outer;
				}
				const lineStartUtf16 = document.table.utf16[line - 1];
				const lineEnd = line < document.table.utf16.length ? document.table.utf16[line] : document.text.length;
				if (lineStartUtf16 === undefined || lineEnd === undefined) continue;
				const raw = document.text.slice(lineStartUtf16, lineEnd);
				scanned++;
				const prefix = prefixCodePoints(raw, GREP_LINE_PREFIX_CHARS);
				pattern.lastIndex = 0;
				const match = pattern.exec(prefix);
				if (match === null || match.index === prefix.length) continue;
				if (hits.length >= limit) {
					truncated = true; // more matches may follow
					break outer;
				}
				const matchCp = codePointsBefore(raw, lineStartUtf16 + match.index) - codePointsBefore(raw, lineStartUtf16);
				hits.push({
					docId: document.docId,
					line,
					text: raw.replace(/\r?\n$/, ""),
					start: matchCp,
					end: matchCp + codePointsBefore(match[0], match[0].length),
				});
			}
		}
		if (hits.length === 0 && completed) throw new VerifyError("not_found", "pattern matched no line");
		return { hits, truncated };
	}

	async readWindow(input: {
		readonly docId: string;
		readonly version?: number;
		readonly needle?: string;
		readonly lineRange?: readonly [number, number];
		readonly radius?: number;
		readonly maxChars?: number;
	}): Promise<ReadWindow> {
		const document = await this.#doc(input.docId);
		if (input.version !== undefined && input.version !== document.version) {
			throw new VerifyError("version_unavailable", `version ${input.version} of ${input.docId}`);
		}
		if (input.needle === undefined && input.lineRange === undefined) {
			throw new VerifyError("anchor_required", "pass needle or lineRange; a bare read never dumps a document");
		}
		const radius = Math.min(Math.max(input.radius ?? DEFAULT_RADIUS, 0), MAX_RADIUS);
		const maxChars = Math.min(Math.max(input.maxChars ?? DEFAULT_READ_CHARS, 1), MAX_READ_CHARS);
		const text = document.text;

		let wantedStartUtf16: number;
		let wantedEndUtf16: number;
		if (input.needle !== undefined) {
			const found = document.text.indexOf(input.needle);
			if (found === -1) throw new VerifyError("not_found", `needle not in ${input.docId}`);
			wantedStartUtf16 = retreatCodePoints(text, found, radius);
			wantedEndUtf16 = advanceCodePoints(text, found, 1 + radius);
		} else {
			const [first, maybeLast] = input.lineRange ?? [];
			const firstLine = Math.min(Math.max(first ?? 1, 1), document.table.utf16.length);
			const lastLine = Math.min(Math.max(maybeLast ?? firstLine, firstLine), document.table.utf16.length);
			const start = document.table.utf16[firstLine - 1];
			if (start === undefined) throw new VerifyError("not_found", `line ${firstLine} is outside ${input.docId}`);
			wantedStartUtf16 = start;
			wantedEndUtf16 =
				lastLine < document.table.utf16.length
					? (document.table.utf16[lastLine] ?? text.length) // start of the next line = end of lastLine
					: text.length;
			// `radius` still applies around the whole range.
			wantedStartUtf16 = retreatCodePoints(text, wantedStartUtf16, radius);
			wantedEndUtf16 = advanceCodePoints(text, wantedEndUtf16, radius);
		}

		const windowCap = advanceCodePoints(text, wantedStartUtf16, maxChars);
		const startUtf16 = wantedStartUtf16;
		const endUtf16 = Math.min(wantedEndUtf16, windowCap, text.length);
		const window = text.slice(startUtf16, endUtf16);
		const truncated = endUtf16 < wantedEndUtf16 || wantedEndUtf16 < text.length;

		const lines: ReadLine[] = [];
		const firstLine = lineOf(document.table, startUtf16);
		const lastLine = lineOf(document.table, Math.max(startUtf16, endUtf16 - 1));
		for (let line = firstLine; line <= lastLine; line++) {
			const lineStartUtf16 = document.table.utf16[line - 1];
			if (lineStartUtf16 === undefined) break;
			lines.push({ line, start: codePointsBefore(text, lineStartUtf16) });
		}
		return {
			docId: document.docId,
			docVersion: document.version,
			text: window,
			start: codePointsBefore(text, startUtf16),
			end: codePointsBefore(text, endUtf16),
			lines,
			truncated,
			nextStart: truncated ? codePointsBefore(text, endUtf16) : null,
		};
	}

	async annotate(input: {
		readonly runId: string;
		readonly docId: string;
		readonly docVersion: number;
		readonly kind: string;
		readonly quote: string;
	}): Promise<Annotation> {
		if (input.kind !== "quote") throw new VerifyError("quote_mismatch", `kind ${input.kind} is not evidence`);
		const document = await this.#doc(input.docId);
		if (input.docVersion !== document.version) {
			throw new VerifyError("version_unavailable", `version ${input.docVersion} of ${input.docId}`);
		}
		if (codePointsBefore(input.quote, input.quote.length) > MAX_QUOTE_CHARS) {
			throw new VerifyError("quote_too_long");
		}
		if (input.quote === "") throw new VerifyError("quote_mismatch", "an empty quote is not evidence");
		const found = document.text.indexOf(input.quote);
		if (found === -1) throw new VerifyError("quote_mismatch", `quote is not an exact span of ${input.docId}`);
		const start = codePointsBefore(document.text, found);
		return {
			citationId: citationIdOf(input.runId, input.docId, document.version, input.quote),
			runId: input.runId,
			docId: input.docId,
			docVersion: document.version,
			start,
			end: start + codePointsBefore(input.quote, input.quote.length),
			line: lineOf(document.table, found),
			quote: input.quote,
			textSha256: document.textSha256,
			status: "verified",
			at: Date.now(),
		};
	}

	async verify(annotation: Annotation): Promise<{ readonly status: "attribution_verified" | VerifyReason }> {
		try {
			const document = await this.#doc(annotation.docId);
			if (!document.text.includes(annotation.quote)) return { status: "quote_mismatch" };
			return { status: "attribution_verified" };
		} catch (error) {
			if (error instanceof VerifyError && error.reason === "not_found") return { status: "not_found" };
			throw error;
		}
	}
}
