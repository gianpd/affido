// CitationStore: the port of RFC 0006 plus the pure pieces every backend shares.
// One property, mechanical, not judged: an answer reports exactly the citations
// it used, and every citation is a text span the server located and verified in
// a real document.

import { createHash } from "node:crypto";

/** Rejection reasons, as named by RFC 0006 R1-R9. Wire values; do not rename. */
export type VerifyReason =
	| "not_found" // document (or needle, or grep pattern) matched nothing
	| "version_unavailable"
	| "quote_mismatch" // the quote is not an exact span of the stated version
	| "quote_too_long"
	| "unsafe_pattern"
	| "pattern_budget" // wall-clock/scan budget of one grep exhausted
	| "anchor_required" // corpus_read without needle or lineRange
	| "unknown_citation"
	| "unverified_citation"
	| "foreign_citation"
	| "undeclared_token"
	| "unused_citation"
	| "uncited_line"
	| "citations_unused" // answer_plain while the run has verified annotations
	| "not_a_strict_run" // a strict-only exit called in a normal run
	| "turn_budget_exhausted";

export class VerifyError extends Error {
	readonly reason: VerifyReason;
	/** Short context for the model: the token, the line preview, the id. */
	readonly detail: string | null;

	constructor(reason: VerifyReason, detail: string | null = null) {
		super(detail === null ? reason : `${reason}: ${detail}`);
		this.name = "VerifyError";
		this.reason = reason;
		this.detail = detail;
	}
}

/** One staged corpus document, decoded and indexed. */
export type CorpusDocument = {
	readonly docId: string;
	/** Original filename, from the ingest sidecar when present. */
	readonly filename: string;
	readonly title: string;
	readonly version: 1;
	readonly text: string;
	readonly textSha256: string;
};

/** A verified annotation as stored in the run (RFC 0006 §5.1). */
export type Annotation = {
	readonly citationId: string;
	readonly runId: string;
	readonly docId: string;
	readonly docVersion: number;
	/** Code-point span of the quote inside the decoded text. */
	readonly start: number;
	readonly end: number;
	/** 1-based line of `start`. */
	readonly line: number;
	readonly quote: string;
	readonly textSha256: string;
	readonly status: "verified";
	readonly at: number;
};

export type GrepHit = {
	readonly docId: string;
	readonly line: number;
	readonly text: string;
	/** Code-point span of the first match inside the line. */
	readonly start: number;
	readonly end: number;
};

export type ReadLine = {
	readonly line: number;
	readonly start: number;
};

export type ReadWindow = {
	readonly docId: string;
	readonly docVersion: number;
	readonly text: string;
	/** Absolute code-point span of `text` inside the document. */
	readonly start: number;
	readonly end: number;
	readonly lines: readonly ReadLine[];
	readonly truncated: boolean;
	readonly nextStart: number | null;
};

export const MAX_QUOTE_CHARS = 1000; // RFC 0006 §9, proposal adopted
export const MAX_RADIUS = 4000;
export const DEFAULT_RADIUS = 400;
export const MAX_READ_CHARS = 16000;
export const DEFAULT_READ_CHARS = 8000;
export const MAX_GREP_LIMIT = 100;
export const DEFAULT_GREP_LIMIT = 40;
export const MAX_PATTERN_CHARS = 200;
export const GREP_LINE_PREFIX_CHARS = 1000; // RFC 0006 §5.2: a match must start inside this prefix

/** `cit_` + 10 hex chars: content-addressed, run-scoped (R3). */
export const citationIdOf = (runId: string, docId: string, docVersion: number, quote: string): string =>
	`cit_${createHash("sha256").update(`${runId}|${docId}|${docVersion}|${quote}`).digest("hex").slice(0, 10)}`;

/** Code points in `text[0, utf16Index)` — the only utf16→code-point conversion here. */
export const codePointsBefore = (text: string, utf16Index: number): number => {
	let count = 0;
	for (let index = 0; index < utf16Index; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0xdc00 && code <= 0xdfff) continue; // low surrogate: same code point
		count++;
	}
	return count;
};

/** 1-based line-start table in both index spaces; `lines[n - 1]` starts line `n`. */
export type LineTable = {
	readonly utf16: readonly number[];
	readonly codePoints: readonly number[];
};

export const lineTableOf = (text: string): LineTable => {
	const utf16: number[] = [0];
	const codePoints: number[] = [0];
	let cp = 0; // code points before the current index
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0xdc00 && code <= 0xdfff) continue; // low surrogate: same code point as its high half
		if (text[index] === "\n" && index + 1 < text.length) {
			utf16.push(index + 1);
			codePoints.push(cp + 1);
		}
		cp++;
	}
	return { utf16, codePoints };
};

/** 1-based line containing `utf16Index`. */
export const lineOf = (table: LineTable, utf16Index: number): number => {
	let low = 0;
	let high = table.utf16.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const start = table.utf16[mid];
		if (start !== undefined && start <= utf16Index) low = mid;
		else high = mid - 1;
	}
	return low + 1;
};

const TOKEN = /cit_[0-9a-f]{6,}/g;
const BRACKET_GROUP = /\[([^\[\]\n]*)\]/g;

/** Every citation id token in the markdown, including grouped `[cit_a; cit_b]` (R5). */
export const citationTokens = (markdown: string): string[] => {
	const tokens: string[] = [];
	for (const match of markdown.matchAll(BRACKET_GROUP)) {
		const group = match[1] ?? "";
		for (const token of group.matchAll(TOKEN)) {
			const id = token[0];
			if (!tokens.includes(id)) tokens.push(id);
		}
	}
	return tokens;
};

/** A non-heading, non-blank line must carry at least one token (gate step 3). */
const lineCarriesToken = (line: string): boolean => /\[[^\[\]\n]*cit_[0-9a-f]{6,}[^\[\]\n]*\]/.test(line);

export type PublishCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: VerifyReason; readonly detail: string };

/** The deterministic gate of RFC 0006 §5.4, in order. Pure: writes nothing. */
export const evaluatePublish = (input: {
	readonly markdown: string;
	readonly declared: readonly string[];
	readonly annotations: readonly Annotation[];
	readonly runId: string;
}): PublishCheck => {
	const { markdown, declared, annotations, runId } = input;
	const byId = new Map(annotations.map((annotation) => [annotation.citationId, annotation]));
	for (const id of declared) {
		const annotation = byId.get(id);
		if (annotation === undefined) return { ok: false, reason: "unknown_citation", detail: id };
		if (annotation.status !== "verified") return { ok: false, reason: "unverified_citation", detail: id };
		if (annotation.runId !== runId) return { ok: false, reason: "foreign_citation", detail: id };
	}
	const used = citationTokens(markdown);
	const declaredSet = new Set(declared);
	for (const token of used) {
		if (!declaredSet.has(token)) return { ok: false, reason: "undeclared_token", detail: token };
	}
	const usedSet = new Set(used);
	for (const id of declared) {
		if (!usedSet.has(id)) return { ok: false, reason: "unused_citation", detail: id };
	}
	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue; // headings and blanks are exempt
		if (!lineCarriesToken(line)) {
			return { ok: false, reason: "uncited_line", detail: line.slice(0, 200) };
		}
	}
	return { ok: true };
};

/** Reject patterns that can blow up backtracking: a quantified group that
 * itself quantifies or alternates — `(a+)+`, `(a|b)+`. */
export const unsafePattern = (pattern: string): boolean => {
	if (pattern.length > MAX_PATTERN_CHARS) return true;
	const stack: number[] = []; // group start indexes
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "\\") {
			index++; // skip the escaped character
			continue;
		}
		if (char === "(") stack.push(index);
		if (char === ")") {
			const start = stack.pop();
			if (start === undefined) continue; // unbalanced; the RegExp compile will say so
			const after = pattern[index + 1];
			if (after === "*" || after === "+" || after === "{") {
				const group = pattern.slice(start + 1, index);
				if (/[*+{|]/.test(group)) return true; // nested quantification or alternation
			}
		}
	}
	return false;
};

/** The port of RFC 0006 §5.2. One instance per agent; documents load lazily. */
export interface CitationStore {
	readonly documents: () => Promise<readonly CorpusDocument[]>;
	grepLines(input: {
		readonly pattern: string;
		readonly docIds?: readonly string[];
		readonly limit?: number;
	}): Promise<{ readonly hits: readonly GrepHit[]; readonly truncated: boolean }>;
	readWindow(input: {
		readonly docId: string;
		readonly version?: number;
		readonly needle?: string;
		readonly lineRange?: readonly [number, number];
		readonly radius?: number;
		readonly maxChars?: number;
	}): Promise<ReadWindow>;
	/** Locate and verify a quote; returns the annotation. Never writes anything. */
	annotate(input: {
		readonly runId: string;
		readonly docId: string;
		readonly docVersion: number;
		readonly kind: string;
		readonly quote: string;
	}): Promise<Annotation>;
	/** Re-verify a stored annotation against the text on disk now (R11). */
	verify(annotation: Annotation): Promise<{ readonly status: "attribution_verified" | VerifyReason }>;
}
