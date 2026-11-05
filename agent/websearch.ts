// RFC 0016: the web-search node. One container per user's sandbox, dual-homed
// on the per-user internal network (pi-net-<user>, where the agent calls it)
// and the shared search network (websearch-in, where SearXNG and Camofox live).
// It owns no writable volume, runs no user code, and has no route to the open
// web: SearXNG and Camofox are the only peers with egress, and they hold no
// user data.
//
// The node is the only edge between the sandbox and the web. Two calls:
//   POST /search {query, lang?, max?} -> {requestId, results, diagnostics}
//   POST /read   {sourceId}           -> {requestId, page, diagnostics}
// The model sees the compact `results` array and the `page` object; programs
// that call the tools see the validated envelope. `page.text` is at most 6000
// characters, selected from a head window plus a focus window. Search results
// never carry a URL: sourceIds are opaque tokens resolved from this run's
// table. `/read` refuses a `url` argument by name (no_url_in_arguments), an id
// the run never received (unknown_source), a second read of the same result,
// and the fifth search of a run (budget_exhausted). The run id rides in the
// `x-run-id` header, set by the agent tool, never by the model.
//
// Page fetches go through Camofox (a Firefox over REST): a raw fetch here
// would need egress in the node, which is exactly what this topology removes.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { HttpError, json, readRawBody } from "./http.ts";
import {
	WEB_SOURCE_ID_PATTERN,
	isCamofoxEvaluate,
	isCamofoxPage,
	isCamofoxTab,
	isSearxResult,
	isSearxngResponse,
	isWebReadEnvelope,
	isWebSearchEnvelope,
	type CamofoxEvaluate,
	type CamofoxPage,
	type CamofoxTab,
	type SearxResult,
	type SearxngResponse,
	type WebReadEnvelope,
	type WebReadWindow,
	type WebSearchEnvelope,
} from "./web-protocol.ts";

const DEFAULT_PORT = 8082;
const MAX_BODY_BYTES = 16 * 1024;

/** RFC 0016 §5 bounds. */
export const MAX_QUERY_CHARS = 256;
export const MAX_SEARCHES_PER_RUN = 4;
export const MAX_RESULTS = 8;
export const MAX_READS_PER_RUN = 8;
export const MAX_READ_CHARS = 6000;

const RUN_ID_MAX = 128;
const RUN_ID_RE = /^[A-Za-z0-9._:-]+$/;
const CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SOURCE_ID_RE = new RegExp(WEB_SOURCE_ID_PATTERN);
/** The browser renders semantic blocks as Markdown-like text. It keeps the
 * full visible length so the node can report an honest `totalChars`. */
const PAGE_TEXT_CEILING = 60_000;
const HEAD_WINDOW_CHARS = 2_500;
const MAX_OPEN_ATTEMPTS = 2;
const MAX_EVALUATE_ATTEMPTS = 3;

const PAGE_EXPRESSION = `(() => {
	const body = document.body;
	if (!body) return JSON.stringify({ title: document.title, text: '', totalChars: 0 });
	const textOf = (node) => ((node.innerText || node.textContent || '').trim());
	const nodes = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,tr')).slice(0, 400);
	const blocks = [];
	for (const node of nodes) {
		const tag = node.tagName.toLowerCase();
		let value = '';
		if (tag === 'tr') {
			value = Array.from(node.querySelectorAll('th,td')).map(textOf).join(' | ');
			if (value) value = '| ' + value + ' |';
		} else {
			value = textOf(node);
		}
		if (!value) continue;
		value = value.slice(0, 2000);
		let kind = 'p';
		if (/^h[1-6]$/.test(tag)) kind = tag;
		else if (tag === 'li' || tag === 'pre' || tag === 'tr') kind = tag;
		blocks.push({ kind, text: value });
	}
	if (blocks.length === 0) {
		const fallback = (body.innerText || body.textContent || '').slice(0, ${PAGE_TEXT_CEILING});
		return JSON.stringify({ title: document.title, text: fallback, totalChars: fallback.length });
	}
	const render = (block) => {
		if (block.kind[0] === 'h') return '#'.repeat(Number(block.kind[1])) + ' ' + block.text;
		if (block.kind === 'li') return '- ' + block.text;
		if (block.kind === 'pre') return '\`\`\`\\n' + block.text + '\\n\`\`\`';
		return block.text;
	};
	let text = '';
	for (const block of blocks) {
		text += (text ? '\\n\\n' : '') + render(block);
		if (text.length >= ${PAGE_TEXT_CEILING}) break;
	}
	const totalChars = text.length;
	text = text.slice(0, ${PAGE_TEXT_CEILING});
	return JSON.stringify({ title: document.title, text, totalChars });
})()`;

export type WebsearchLog = (...args: unknown[]) => void;

export type WebsearchSource = {
	readonly url: string;
	readonly title: string;
	/** Server-side terms from the query/title/snippet, used only to select a
	 * reading window. Never model-supplied and never returned to the model. */
	readonly focus: readonly string[];
};

export type WebsearchOptions = {
	readonly port?: number;
	readonly host?: string;
	/** CIDRs of the per-user network; anything else is forbidden_peer. Empty
	 * refuses every data call (fail closed, never "open by default"). */
	readonly peers?: readonly string[];
	readonly searxngUrl?: string;
	readonly camofoxUrl?: string;
	readonly camofoxKey?: string;
	/** Camofox session owner: the user slug, never another tenant's. */
	readonly userId?: string;
	readonly log?: WebsearchLog;
	/** Delay between evaluate attempts, for slow pages; 0 in tests. */
	readonly readDelayMs?: number;
	/** Initial control token; production leaves it unset and the manager sets
	 * it over POST /control before the first prompt (RFC 0016 §7). */
	readonly controlToken?: string;
};

export class WebsearchError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

type RunState = {
	/** Last registration/use, for the TTL: a run's authorisation must not
	 * outlive the run by much. */
	at: number;
	/** The user authorised web access for this run. Set only by the trusted
	 * admission path, never by the model. */
	web: boolean;
	/** Handed to the agent at registration; without it /search and /read refuse,
	 * so a bash child of the sandbox cannot open a run of its own. */
	token: string;
	searches: number;
	reads: number;
	/** A failed upstream call must not spend the per-run budget. */
	searchInFlight: number;
	readInFlight: Set<string>;
	sources: Map<string, WebsearchSource>;
	read: Set<string>;
};

/** Per-run source tables, LRU-capped: a node outlives many runs, and a run
 * table is worthless once the conversation moved on. Never persisted. */
const MAX_RUNS = 64;
/** A run's web authorisation expires with it: an old token must not stay
 * usable for a later, web-off prompt. */
const RUN_TTL_MS = 60 * 60 * 1000;

class RunTable {
	#runs = new Map<string, RunState>();

	/** Register (or refresh) one run. Returns its token; a repeated
	 * registration keeps the token so an idempotent replay stays valid. */
	register(runId: string, web: boolean): string {
		this.#prune();
		const existing = this.#runs.get(runId);
		if (existing !== undefined) {
			existing.web = web;
			existing.at = Date.now();
			this.#touch(runId, existing);
			return existing.token;
		}
		const token = randomBytes(18).toString("base64url");
		this.#runs.set(runId, {
			at: Date.now(),
			web,
			token,
			searches: 0,
			reads: 0,
			searchInFlight: 0,
			readInFlight: new Set(),
			sources: new Map(),
			read: new Set(),
		});
		if (this.#runs.size > MAX_RUNS) {
			const oldest = this.#runs.keys().next().value;
			if (oldest !== undefined) this.#runs.delete(oldest);
		}
		return token;
	}

	find(runId: string): RunState | undefined {
		this.#prune();
		const existing = this.#runs.get(runId);
		if (existing !== undefined) {
			existing.at = Date.now();
			this.#touch(runId, existing);
		}
		return existing;
	}

	#prune(): void {
		const cutoff = Date.now() - RUN_TTL_MS;
		for (const [runId, state] of this.#runs) {
			if (state.at < cutoff) this.#runs.delete(runId);
		}
	}

	#touch(runId: string, state: RunState): void {
		this.#runs.delete(runId);
		this.#runs.set(runId, state);
	}

	get size(): number {
		return this.#runs.size;
	}
}

// ── peer guard (RFC 0016 §6: another tenant's node is not a caller) ─────────

const ipv4ToInt = (value: string): number | null => {
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		result = result * 256 + octet;
	}
	return result;
};

/** Normalize the socket address: strip an IPv4-mapped IPv6 prefix and a zone. */
const normalizeAddress = (value: string | undefined): string | null => {
	if (value === undefined) return null;
	let address = value;
	if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
	const zone = address.indexOf("%");
	if (zone !== -1) address = address.slice(0, zone);
	return address === "" ? null : address;
};

/** True when `peer` sits inside one of the allowed CIDRs. IPv4 CIDRs only:
 * Docker's per-user networks are IPv4, and anything unparsable is refused. */
export const peerAllowed = (peer: string | undefined, peers: readonly string[]): boolean => {
	if (peers.length === 0) return false;
	const address = normalizeAddress(peer);
	if (address === null) return false;
	const numeric = ipv4ToInt(address);
	if (numeric === null) return peers.includes(address);
	for (const cidr of peers) {
		const [network, rawBits] = cidr.split("/");
		if (network === undefined || rawBits === undefined) continue;
		const base = ipv4ToInt(network);
		const bits = Number(rawBits);
		if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		if (((numeric ^ base) & mask) === 0) return true;
	}
	return false;
};

// ── helpers ─────────────────────────────────────────────────────────────────

const requireString = (
	value: unknown,
	field: string,
	max: number,
	failure: () => WebsearchError,
): string => {
	if (typeof value !== "string") throw failure();
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.length > max) throw failure();
	return trimmed;
};

const optionalInt = (value: unknown, field: string, min: number, max: number): number | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new WebsearchError(400, "invalid_request", `${field} must be an integer between ${min} and ${max}`);
	}
	return value;
};

const requireRun = (req: IncomingMessage): string => {
	const raw = req.headers["x-run-id"];
	const runId = Array.isArray(raw) ? raw[0] : raw;
	if (typeof runId !== "string" || runId === "" || runId.length > RUN_ID_MAX || !RUN_ID_RE.test(runId)) {
		throw new WebsearchError(400, "missing_run", "x-run-id is required (1-128 chars of [A-Za-z0-9._:-])");
	}
	return runId;
};

const requestIdOf = (req: IncomingMessage): string => {
	const raw = req.headers["x-call-id"];
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value === "string" && CALL_ID_RE.test(value)) return value;
	return `req_${randomBytes(9).toString("base64url")}`;
};

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
	const bytes = await readRawBody(req, MAX_BODY_BYTES);
	if (bytes.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new WebsearchError(400, "invalid_json", "the body is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new WebsearchError(400, "invalid_json", "the body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
};

const baseOf = (value: string): string => value.replace(/\/+$/, "");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Address literals the search stack must never be pointed at: the node's own
 * network, the host's bridge addresses, and the cloud metadata endpoint. This
 * is a literal check, not a DNS one — Camofox resolves in its own network, so a
 * hostile name that resolves inward is the operator stack's responsibility
 * (the same rule the browser-search tooling applies). */
const privateHost = (host: string): boolean => {
	// WHATWG URL keeps the brackets of an IPv6 literal; strip them before the
	// address checks (the v4-mapped form then normalizes to its v4 address).
	const candidate = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	const lower = candidate.toLowerCase();
	const address = normalizeAddress(candidate);
	const numeric = address === null ? null : ipv4ToInt(address);
	if (numeric !== null) {
		const first = numeric >>> 24;
		const second = (numeric >>> 16) & 0xff;
		return (
			first === 0 || // 0.0.0.0/8
			first === 10 || // 10/8
			first === 127 || // loopback
			(first === 100 && second >= 64 && second <= 127) || // CGNAT 100.64/10
			(first === 169 && second === 254) || // link-local, metadata
			(first === 172 && second >= 16 && second <= 31) || // 172.16/12
			(first === 192 && second === 168) || // 192.168/16
			first >= 224 // multicast + reserved
		);
	}
	if (lower === "localhost" || lower.endsWith(".localhost")) return true;
	if (lower.endsWith(".local") || lower.endsWith(".internal")) return true;
	// IPv6 literal: global unicast is 2000::/3 (2000–3fff). Everything else —
	// ::1, fc00::/7, fe80::/10, multicast, and the ::ffff: v4-mapped form — is
	// not a destination the search stack should fetch.
	if (lower.includes(":")) return !(lower.startsWith("2") || lower.startsWith("3"));
	return false;
};

const httpUrl = (value: string): string | null => {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		if (privateHost(parsed.hostname)) return null;
		return parsed.href;
	} catch {
		return null;
	}
};

const STOP_WORDS = new Set([
	"about", "after", "again", "from", "into", "that", "their", "there", "these",
	"this", "what", "when", "where", "which", "with", "would", "your",
	"per", "con", "della", "delle", "dello", "della", "delle", "sono", "questa",
	"questo", "quello", "che", "non", "una", "uno", "sono", "come", "anche",
]);

/** Server-side focus terms: the model never chooses the reading window. */
export const focusTermsOf = (parts: readonly (string | undefined)[]): string[] => {
	const text = parts.filter((part): part is string => typeof part === "string").join(" ").toLowerCase();
	const tokens = text.match(/[\p{L}\p{N}]{4,}/gu) ?? [];
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		if (STOP_WORDS.has(token) || seen.has(token)) continue;
		seen.add(token);
		terms.push(token);
		if (terms.length >= 16) break;
	}
	return terms;
};

export type ReadWindowSelection = { readonly text: string; readonly window: WebReadWindow };

/** Keep a head window and a bounded window around the best focus/heading hit.
 * `maxChars` stays 6000: the eval's deep-marker loss came from taking only the
 * first 6000 characters, not from the size of the cap itself. */
export const selectReadWindow = (
	text: string,
	terms: readonly string[],
	maxChars: number = MAX_READ_CHARS,
): ReadWindowSelection => {
	if (text.length <= maxChars) {
		return { text, window: { mode: "full", headChars: text.length, start: 0, end: text.length } };
	}
	const headChars = Math.min(HEAD_WINDOW_CHARS, maxChars);
	const head = text.slice(0, headChars);
	const windowSize = maxChars - head.length;
	const lower = text.toLowerCase();
	const starts = new Set<number>([headChars]);
	for (const term of terms) {
		let from = headChars;
		for (let found = 0; found < 40; found++) {
			const at = lower.indexOf(term, from);
			if (at < 0) break;
			starts.add(Math.max(headChars, at - 200));
			from = at + term.length;
		}
	}
	const heading = /^#{1,6} /gm;
	let match: RegExpExecArray | null;
	while ((match = heading.exec(text)) !== null) {
		if (match.index >= headChars) starts.add(Math.max(headChars, match.index - 200));
		if (starts.size >= 80) break;
	}
	let best = headChars;
	let bestScore = -1;
	for (const start of starts) {
		const end = Math.min(text.length, start + windowSize);
		if (end <= start) continue;
		const slice = text.slice(start, end);
		const sliceLower = slice.toLowerCase();
		let distinct = 0;
		for (const term of terms) if (sliceLower.includes(term)) distinct += 1;
		const headings = (slice.match(/^#{1,6} /gm) ?? []).length;
		const score = distinct * 2 + headings;
		if (score > bestScore) {
			bestScore = score;
			best = start;
		}
	}
	const focus = text.slice(best, Math.min(text.length, best + windowSize));
	const mode = best > headChars && terms.length > 0 ? "head+focus" : "head";
	return {
		text: head + focus,
		window: { mode, headChars: head.length, start: best, end: best + focus.length },
	};
};

const suspendedOf = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const entry of value) {
		if (Array.isArray(entry) && typeof entry[0] === "string") names.push(entry[0]);
		else if (typeof entry === "object" && entry !== null) {
			const record = entry as Record<string, unknown>;
			if (typeof record["engine"] === "string") names.push(record["engine"]);
		}
	}
	return [...new Set(names)];
};

// ── the two upstream clients ────────────────────────────────────────────────

/** The default engine set can be entirely suspended (CAPTCHA, rate limits), in
 * which case SearXNG answers 200 with an empty list and the model sees "no
 * results" for a query that has plenty. The n2n search goes engine by engine
 * for the same reason; keep that order, the healthy engine first. */
const SEARXNG_FALLBACK_ENGINES = ["bing", "duckduckgo", "brave", "mojeek", "wikipedia", "yandex"] as const;

/** One attempt must not eat the caller's whole timeout: SearXNG can park the
 * request until its own max_request_timeout when every engine is suspended. */
const SEARCH_ATTEMPT_TIMEOUT_MS = 10_000;
/** Overall cascade budget, below web-tools' 30s abort. */
const SEARCH_DEADLINE_MS = 25_000;

type SearxAttempt = {
	readonly results: readonly SearxResult[];
	readonly suspended: readonly string[];
	readonly dropped: number;
};

type SearxOutcome = {
	readonly results: readonly SearxResult[];
	readonly enginesTried: readonly string[];
	readonly fallbackUsed: boolean;
	readonly suspendedEngines: readonly string[];
	readonly droppedCount: number;
	readonly elapsedMs: number;
};

const searxngAttempt = async (
	base: string,
	query: string,
	lang: string | undefined,
	engine: string | undefined,
	signal: AbortSignal,
): Promise<SearxAttempt> => {
	const url = new URL(`${baseOf(base)}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	if (lang !== undefined) url.searchParams.set("language", lang);
	if (engine !== undefined) url.searchParams.set("engines", engine);
	const label = engine === undefined ? "" : ` (${engine})`;
	let response: Response;
	try {
		response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WebsearchError(502, "search_unavailable", `SearXNG${label} did not answer: ${reason}`);
	}
	if (!response.ok) {
		throw new WebsearchError(502, "search_unavailable", `SearXNG${label} answered ${response.status}`);
	}
	let doc: unknown;
	try {
		doc = await response.json();
	} catch {
		throw new WebsearchError(502, "search_unavailable", "SearXNG did not answer JSON (format=json disabled?)");
	}
	if (!isSearxngResponse(doc)) {
		throw new WebsearchError(502, "search_unavailable", "SearXNG returned an invalid JSON envelope");
	}
	const results: SearxResult[] = [];
	let dropped = 0;
	for (const item of doc.results) {
		if (isSearxResult(item)) results.push(item);
		else dropped += 1;
	}
	return { results, suspended: suspendedOf(doc.unresponsive_engines), dropped };
};

/** Try the default engine set first, then one engine at a time. An empty 200 is
 * not an error: keep going until an engine returns results or the budget runs
 * out. A refusal is surfaced only when no attempt answered at all, so "no
 * results" and "search stack down" stay distinguishable. */
const searxngSearch = async (base: string, query: string, lang: string | undefined): Promise<SearxOutcome> => {
	const started = Date.now();
	const deadline = started + SEARCH_DEADLINE_MS;
	let lastRefusal: WebsearchError | null = null;
	let answered = false;
	const enginesTried: string[] = [];
	const suspended = new Set<string>();
	let winning: SearxAttempt | null = null;
	let fallbackUsed = false;
	for (const engine of [undefined, ...SEARXNG_FALLBACK_ENGINES]) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		enginesTried.push(engine ?? "default");
		const signal = AbortSignal.timeout(Math.min(SEARCH_ATTEMPT_TIMEOUT_MS, remaining));
		try {
			const attempt = await searxngAttempt(base, query, lang, engine, signal);
			answered = true;
			for (const name of attempt.suspended) suspended.add(name);
			if (attempt.results.length > 0) {
				winning = attempt;
				fallbackUsed = engine !== undefined;
				break;
			}
			if (winning === null) winning = attempt;
		} catch (error) {
			lastRefusal =
				error instanceof WebsearchError
					? error
					: new WebsearchError(502, "search_unavailable", error instanceof Error ? error.message : String(error));
		}
	}
	if (!answered && lastRefusal !== null) throw lastRefusal;
	const outcome = winning ?? { results: [], suspended: [], dropped: 0 };
	return {
		results: outcome.results,
		enginesTried,
		fallbackUsed,
		suspendedEngines: [...suspended],
		droppedCount: outcome.dropped,
		elapsedMs: Date.now() - started,
	};
};

type CamofoxRead = {
	readonly title: string;
	readonly text: string;
	readonly totalChars: number;
	readonly attempts: number;
};

type CamofoxOnce = { readonly page: CamofoxPage; readonly attempts: number } | null;

const camofoxOnce = async (
	base: string,
	key: string,
	user: string,
	sessionKey: string,
	target: string,
	delayMs: number,
): Promise<CamofoxOnce> => {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key !== "") headers.authorization = `Bearer ${key}`;
	const root = baseOf(base);
	let response: Response;
	try {
		response = await fetch(`${root}/tabs`, {
			method: "POST",
			headers,
			body: JSON.stringify({ userId: user, sessionKey, url: target }),
			redirect: "error",
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WebsearchError(502, "read_unavailable", `Camofox did not answer: ${reason}`);
	}
	if (!response.ok) throw new WebsearchError(502, "read_unavailable", `Camofox answered ${response.status} on /tabs`);
	const opened: unknown = await response.json().catch(() => ({}));
	if (!isCamofoxTab(opened)) throw new WebsearchError(502, "read_unavailable", "Camofox returned no tabId");
	const tab: CamofoxTab = opened;
	let attempts = 1;
	try {
		for (let attempt = 0; attempt < MAX_EVALUATE_ATTEMPTS; attempt++) {
			attempts += 1;
			if (attempt > 0 && delayMs > 0) await sleep(delayMs);
			let evaluated: Response;
			try {
				evaluated = await fetch(`${root}/tabs/${encodeURIComponent(tab.tabId)}/evaluate`, {
					method: "POST",
					headers,
					body: JSON.stringify({ userId: user, expression: PAGE_EXPRESSION }),
					redirect: "error",
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new WebsearchError(502, "read_unavailable", `Camofox evaluate did not answer: ${reason}`);
			}
			if (evaluated.status === 401 || evaluated.status === 403) {
				// A missing or wrong CAMOFOX_API_KEY lands here; retries cannot fix it.
				throw new WebsearchError(502, "read_unavailable", `Camofox refused the evaluate (${evaluated.status})`);
			}
			if (!evaluated.ok) continue;
			const body: unknown = await evaluated.json().catch(() => ({}));
			if (!isCamofoxEvaluate(body)) continue;
			const evaluatedBody: CamofoxEvaluate = body;
			let page: unknown;
			try {
				page = JSON.parse(evaluatedBody.result);
			} catch {
				continue;
			}
			if (!isCamofoxPage(page)) continue;
			if (page.text === "") continue;
			return { page, attempts };
		}
		return null;
	} finally {
		// Always close: no shared history, no leaked tabs between runs.
		await fetch(`${root}/tabs/${encodeURIComponent(tab.tabId)}?userId=${encodeURIComponent(user)}`, {
			method: "DELETE",
			headers,
		}).catch(() => undefined);
	}
};

const camofoxRead = async (
	base: string,
	key: string,
	user: string,
	sessionKey: string,
	target: string,
	delayMs: number,
): Promise<CamofoxRead> => {
	let attempts = 0;
	let lastRefusal: WebsearchError | null = null;
	for (let open = 0; open < MAX_OPEN_ATTEMPTS; open++) {
		try {
			const once = await camofoxOnce(base, key, user, sessionKey, target, delayMs);
			attempts += once?.attempts ?? MAX_EVALUATE_ATTEMPTS + 1;
			if (once !== null) {
				return {
					title: once.page.title ?? "",
					text: once.page.text,
					totalChars: once.page.totalChars,
					attempts,
				};
			}
			lastRefusal = new WebsearchError(502, "read_unavailable", "the page produced no text");
		} catch (error) {
			const refusal =
				error instanceof WebsearchError
					? error
					: new WebsearchError(502, "read_unavailable", error instanceof Error ? error.message : String(error));
			attempts += 1;
			if (error instanceof WebsearchError && error.message.includes("refused the evaluate")) throw error;
			lastRefusal = refusal;
		}
		if (delayMs > 0) await sleep(delayMs);
	}
	throw lastRefusal ?? new WebsearchError(502, "read_unavailable", "the page produced no text");
};

// ── server ──────────────────────────────────────────────────────────────────

export type WebsearchServer = {
	readonly server: ReturnType<typeof createServer>;
	readonly port: number;
	readonly close: () => Promise<void>;
};

export const createWebsearchServer = async (options: WebsearchOptions = {}): Promise<WebsearchServer> => {
	const peers = options.peers ?? [];
	const searxngUrl = options.searxngUrl ?? "";
	const camofoxUrl = options.camofoxUrl ?? "";
	const camofoxKey = options.camofoxKey ?? "";
	const user = options.userId ?? "affido";
	const log = options.log ?? (() => {});
	const delayMs = options.readDelayMs ?? 250;
	const runs = new RunTable();
	// RFC 0016 §7: the manager mints a per-user control token from its own
	// secret and delivers it here before the first prompt. The agent (its
	// trusted admission code, not the model) registers each run with this token
	// and gets a per-run token back. A bash child of the sandbox has neither, so
	// it cannot open a run of its own; the first set wins, and only the same
	// token is accepted afterwards.
	const control: { token: string | null } = { token: options.controlToken ?? null };

	const guard = (req: IncomingMessage): void => {
		if (!peerAllowed(req.socket.remoteAddress, peers)) {
			throw new WebsearchError(403, "forbidden_peer", "the caller is outside this sandbox's network");
		}
	};

	const requireControl = (req: IncomingMessage): void => {
		const provided = req.headers["x-control-token"];
		if (control.token === null) {
			throw new WebsearchError(503, "control_token_unset", "the manager has not delivered the control token yet");
		}
		if (typeof provided !== "string" || provided !== control.token) {
			throw new WebsearchError(403, "forbidden_control", "the control token is required to register a run");
		}
	};

	/** Authorise one data call: the run must have been registered by the trusted
	 * admission path, must carry the user's `web: "allowed"`, and must present
	 * the per-run token the registration returned. */
	const authorizeRun = (req: IncomingMessage): { run: RunState; runId: string } => {
		const runId = requireRun(req);
		const run = runs.find(runId);
		if (run === undefined || !run.web) {
			throw new WebsearchError(403, "web_not_authorized", "this run was not authorised for web access");
		}
		const token = req.headers["x-run-token"];
		if (typeof token !== "string" || token !== run.token) {
			throw new WebsearchError(403, "not_authorized", "the per-run token is required");
		}
		return { run, runId };
	};

	const validated = <T>(value: unknown, guard: (candidate: unknown) => candidate is T, label: string): T => {
		if (!guard(value)) throw new WebsearchError(500, "internal", `the node produced an invalid ${label} response`);
		return value;
	};

	const search = async (req: IncomingMessage, requestId: string): Promise<WebSearchEnvelope> => {
		const started = Date.now();
		const body = await readJson(req);
		const query = requireString(
			body.query,
			"query",
			MAX_QUERY_CHARS,
			() => new WebsearchError(413, "query_too_long", `query must be 1-${MAX_QUERY_CHARS} characters`),
		);
		const max = optionalInt(body.max, "max", 1, MAX_RESULTS) ?? MAX_RESULTS;
		let lang: string | undefined;
		if (body.lang !== undefined) {
			if (typeof body.lang !== "string" || !/^[A-Za-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(body.lang)) {
				throw new WebsearchError(400, "invalid_request", "lang must be a language tag such as en or it-IT");
			}
			lang = body.lang;
		}
		if (searxngUrl === "") throw new WebsearchError(503, "search_unavailable", "SEARXNG_URL is not configured");
		const { run } = authorizeRun(req);
		if (run.searches + run.searchInFlight >= MAX_SEARCHES_PER_RUN) {
			throw new WebsearchError(429, "budget_exhausted", `this run already spent its ${MAX_SEARCHES_PER_RUN} searches`);
		}
		run.searchInFlight += 1;
		let outcome: SearxOutcome;
		try {
			outcome = await searxngSearch(searxngUrl, query, lang);
		} finally {
			run.searchInFlight -= 1;
		}
		run.searches += 1;
		const results: WebSearchEnvelope["results"] = [];
		const seen = new Set<string>();
		let dropped = outcome.droppedCount;
		for (const item of outcome.results) {
			if (results.length >= max) break;
			if (typeof item.url !== "string") {
				dropped += 1;
				continue;
			}
			const url = httpUrl(item.url);
			if (url === null || seen.has(url)) {
				dropped += 1;
				continue;
			}
			seen.add(url);
			// Opaque id: the model cannot turn a result into a fetch target, and
			// the id carries neither the run nor the URL.
			const sourceId = `web_${randomBytes(9).toString("base64url")}`;
			const title = typeof item.title === "string" && item.title !== "" ? item.title : new URL(url).hostname;
			const snippet = typeof item.content === "string" ? item.content.slice(0, 500) : "";
			run.sources.set(sourceId, {
				url,
				title,
				focus: focusTermsOf([query, title, snippet]),
			});
			results.push({
				sourceId,
				title: title.slice(0, 300),
				domain: new URL(url).hostname,
				snippet,
			});
		}
		const envelope: unknown = {
			requestId,
			results,
			diagnostics: {
				enginesTried: [...outcome.enginesTried],
				fallbackUsed: outcome.fallbackUsed,
				suspendedEngines: [...outcome.suspendedEngines],
				droppedCount: dropped,
				partial: outcome.fallbackUsed || dropped > 0 || results.length === 0,
				resultCount: results.length,
				elapsedMs: Date.now() - started,
			},
		};
		return validated(envelope, isWebSearchEnvelope, "/search");
	};

	const read = async (req: IncomingMessage, requestId: string): Promise<WebReadEnvelope> => {
		const started = Date.now();
		const body = await readJson(req);
		// RFC 0016 §5: there is no URL argument, ever. Name the refusal so a
		// model that tries anyway can correct itself on the next call.
		if (body.url !== undefined) {
			throw new WebsearchError(400, "no_url_in_arguments", "web_read accepts only a sourceId issued by web_search");
		}
		const sourceId = requireString(
			body.sourceId,
			"sourceId",
			128,
			() => new WebsearchError(404, "unknown_source", "sourceId is not an id issued by web_search"),
		);
		if (!SOURCE_ID_RE.test(sourceId)) {
			throw new WebsearchError(404, "unknown_source", "sourceId is not an id issued by web_search");
		}
		const { run, runId } = authorizeRun(req);
		const source = run.sources.get(sourceId);
		if (source === undefined) {
			throw new WebsearchError(404, "unknown_source", "sourceId was not issued to this run");
		}
		if (run.read.has(sourceId) || run.readInFlight.has(sourceId)) {
			throw new WebsearchError(429, "already_read", "this result was already read in this run");
		}
		if (run.reads + run.readInFlight.size >= MAX_READS_PER_RUN) {
			throw new WebsearchError(429, "budget_exhausted", `this run already spent its ${MAX_READS_PER_RUN} reads`);
		}
		if (camofoxUrl === "") throw new WebsearchError(503, "read_unavailable", "CAMOFOX_URL is not configured");
		run.readInFlight.add(sourceId);
		let fetched: CamofoxRead;
		try {
			fetched = await camofoxRead(camofoxUrl, camofoxKey, user, runId, source.url, delayMs);
		} finally {
			run.readInFlight.delete(sourceId);
		}
		run.reads += 1;
		run.read.add(sourceId);
		const selection = selectReadWindow(fetched.text, source.focus);
		const text = selection.text.slice(0, MAX_READ_CHARS);
		const page = {
			untrusted: true,
			url: source.url,
			title: fetched.title !== "" ? fetched.title.slice(0, 300) : source.title,
			text,
			sha256: createHash("sha256").update(text).digest("hex"),
			truncated: fetched.totalChars > text.length,
			totalChars: fetched.totalChars,
		};
		const envelope: unknown = {
			requestId,
			page,
			diagnostics: {
				readAttempts: fetched.attempts,
				window: selection.window,
				selectedChars: text.length,
				elapsedMs: Date.now() - started,
			},
		};
		return validated(envelope, isWebReadEnvelope, "/read");
	};

	const server = createServer((req, res) => {
		const requestId = requestIdOf(req);
		const url = new URL(req.url ?? "/", "http://websearch");
		void (async () => {
			try {
				// Liveness and status never touch the search stack: the manager's
				// resolve and healthcheck must not depend on SearXNG being up.
				if (req.method === "GET" && url.pathname === "/health") {
					return json(res, 200, { status: "ok" });
				}
				if (req.method === "GET" && url.pathname === "/status") {
					return json(res, 200, {
						status: "ok",
						searxng: searxngUrl !== "",
						camofox: camofoxUrl !== "",
						control: control.token !== null,
						runs: runs.size,
					});
				}
				// Manager-only in practice: it is the first caller, before any
				// prompt, and only the same token is accepted afterwards.
				if (req.method === "POST" && url.pathname === "/control") {
					guard(req);
					const body = await readJson(req);
					const token = requireString(
						body.token,
						"token",
						128,
						() => new WebsearchError(400, "invalid_request", "token is required"),
					);
					if (token.length < 32) {
						throw new WebsearchError(400, "invalid_request", "the control token is too short");
					}
					if (control.token !== null && control.token !== token) {
						throw new WebsearchError(403, "control_token_mismatch", "the node already holds a control token");
					}
					control.token = token;
					return json(res, 200, { status: "ok" });
				}
				// The trusted admission path registers one run per /prompt.
				if (req.method === "POST" && url.pathname === "/runs") {
					guard(req);
					requireControl(req);
					const body = await readJson(req);
					const runId = requireRun(req);
					const web = body.web === true;
					return json(res, 200, { runToken: runs.register(runId, web) });
				}
				if (req.method === "POST" && url.pathname === "/search") {
					guard(req);
					return json(res, 200, await search(req, requestId));
				}
				if (req.method === "POST" && url.pathname === "/read") {
					guard(req);
					return json(res, 200, await read(req, requestId));
				}
				return json(res, 404, { error: "not_found", message: `${req.method} ${url.pathname}`, requestId });
			} catch (error) {
				if (error instanceof WebsearchError) {
					// Never log the query or the page: only the refusal code.
					if (error.code !== "forbidden_peer") log(`refused ${error.code}: ${error.message}`);
					return json(res, error.status, { error: error.code, message: error.message, requestId });
				}
				if (error instanceof HttpError) return json(res, error.status, { ...error.body, requestId });
				const message = error instanceof Error ? error.message : String(error);
				log(`websearch request failed: ${message}`);
				return json(res, 500, { error: "internal", message, requestId });
			}
		})();
	});

	const instance = server.listen(options.port ?? DEFAULT_PORT, options.host ?? "0.0.0.0");
	await new Promise<void>((resolve, reject) => {
		instance.once("listening", () => resolve());
		instance.once("error", reject);
	});
	const address = instance.address();
	const port = typeof address === "object" && address !== null ? address.port : (options.port ?? DEFAULT_PORT);
	return {
		server: instance,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				instance.closeIdleConnections();
				instance.closeAllConnections();
				instance.close(() => resolve());
			}),
	};
};

// Bootstrap: `node /app/websearch.ts` starts the node; unit tests import the
// module without triggering it.
const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
	const port = Number(process.env.PORT ?? DEFAULT_PORT);
	const peers = (process.env.WEBSEARCH_PEERS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value !== "");
	const log: WebsearchLog = (...args) => console.log("[websearch]", ...args);
	void createWebsearchServer({
		port,
		peers,
		searxngUrl: process.env.SEARXNG_URL ?? "",
		camofoxUrl: process.env.CAMOFOX_URL ?? "",
		camofoxKey: process.env.CAMOFOX_API_KEY ?? "",
		userId: process.env.WEBSEARCH_USER ?? "affido",
		log,
	}).then(() =>
		log(`listening on :${port} (web-search node, RFC 0016; peers ${peers.join(",") || "none"})`),
	);
}
