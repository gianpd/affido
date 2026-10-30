// RFC 0016: the web-search node. One container per user's sandbox, dual-homed
// on the per-user internal network (pi-net-<user>, where the agent calls it)
// and the shared search network (websearch-in, where SearXNG and Camofox live).
// It owns no writable volume, runs no user code, and has no route to the open
// web: SearXNG and Camofox are the only peers with egress, and they hold no
// user data.
//
// The node is the only edge between the sandbox and the web. Two calls:
//   POST /search {query, lang?, max?} -> [{sourceId, title, domain, snippet}]
//   POST /read   {sourceId}           -> {untrusted, url, title, text, sha256}
// The model never names a URL: sourceIds are opaque tokens resolved from this
// run's table. `/read` refuses a `url` argument by name (no_url_in_arguments),
// an id the run never received (unknown_source), a second read of the same
// result, and the fifth search of a run (budget_exhausted). The run id rides in
// the `x-run-id` header, set by the agent tool, never by the model.
//
// Page fetches go through Camofox (a Firefox over REST): a raw fetch here
// would need egress in the node, which is exactly what this topology removes.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { HttpError, json, readRawBody } from "./http.ts";

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
const SOURCE_ID_RE = /^web_[A-Za-z0-9_-]{8,64}$/;
/** The page text expression: title plus readable body, capped before it leaves
 * the browser so a huge page cannot flood the node. */
const PAGE_EXPRESSION =
	"JSON.stringify({title: document.title, text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 20000)})";

export type WebsearchLog = (...args: unknown[]) => void;

export type WebsearchSource = { readonly url: string; readonly title: string };

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

// ── the two upstream clients ────────────────────────────────────────────────

type SearxResult = { readonly title?: unknown; readonly url?: unknown; readonly content?: unknown };

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

const searxngAttempt = async (
	base: string,
	query: string,
	lang: string | undefined,
	engine: string | undefined,
	signal: AbortSignal,
): Promise<readonly SearxResult[]> => {
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
	const results = (doc as { results?: unknown }).results;
	return Array.isArray(results) ? (results as SearxResult[]) : [];
};

/** Try the default engine set first, then one engine at a time. An empty 200 is
 * not an error: keep going until an engine returns results or the budget runs
 * out. A refusal is surfaced only when no attempt answered at all, so "no
 * results" and "search stack down" stay distinguishable. */
const searxngSearch = async (base: string, query: string, lang: string | undefined): Promise<readonly SearxResult[]> => {
	const deadline = Date.now() + SEARCH_DEADLINE_MS;
	let lastRefusal: WebsearchError | null = null;
	let answered = false;
	for (const engine of [undefined, ...SEARXNG_FALLBACK_ENGINES]) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const signal = AbortSignal.timeout(Math.min(SEARCH_ATTEMPT_TIMEOUT_MS, remaining));
		try {
			const results = await searxngAttempt(base, query, lang, engine, signal);
			answered = true;
			if (results.length > 0) return results;
		} catch (error) {
			lastRefusal =
				error instanceof WebsearchError
					? error
					: new WebsearchError(502, "search_unavailable", error instanceof Error ? error.message : String(error));
		}
	}
	if (!answered && lastRefusal !== null) throw lastRefusal;
	return [];
};

type CamofoxRead = { readonly title: string; readonly text: string };

const camofoxRead = async (
	base: string,
	key: string,
	user: string,
	sessionKey: string,
	target: string,
	delayMs: number,
): Promise<CamofoxRead> => {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key !== "") headers.authorization = `Bearer ${key}`;
	const root = baseOf(base);
	let tabId: string | null = null;
	try {
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
		const opened = (await response.json().catch(() => ({}))) as { tabId?: unknown };
		if (typeof opened.tabId !== "string" || opened.tabId === "") {
			throw new WebsearchError(502, "read_unavailable", "Camofox returned no tabId");
		}
		tabId = opened.tabId;
		// A freshly opened tab may still be navigating; a couple of evaluates
		// absorb that without turning a slow page into a hard failure.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0 && delayMs > 0) await sleep(delayMs);
			const evaluated = await fetch(`${root}/tabs/${encodeURIComponent(tabId)}/evaluate`, {
				method: "POST",
				headers,
				body: JSON.stringify({ userId: user, expression: PAGE_EXPRESSION }),
				redirect: "error",
			});
			if (evaluated.status === 401 || evaluated.status === 403) {
				// A missing or wrong CAMOFOX_API_KEY lands here; without this the
				// retry loop turns an auth failure into "the page produced no text".
				throw new WebsearchError(502, "read_unavailable", `Camofox refused the evaluate (${evaluated.status})`);
			}
			if (!evaluated.ok) continue;
			const body = (await evaluated.json().catch(() => ({}))) as { result?: unknown };
			const raw = typeof body.result === "string" ? body.result : "";
			if (raw === "") continue;
			let page: { title?: unknown; text?: unknown };
			try {
				page = JSON.parse(raw) as { title?: unknown; text?: unknown };
			} catch {
				continue;
			}
			const text = typeof page.text === "string" ? page.text : "";
			if (text !== "") {
				return { title: typeof page.title === "string" ? page.title : "", text };
			}
		}
		throw new WebsearchError(502, "read_unavailable", "the page produced no text");
	} finally {
		if (tabId !== null) {
			// Always close: no shared history, no leaked tabs between runs.
			await fetch(`${root}/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(user)}`, {
				method: "DELETE",
				headers,
			}).catch(() => undefined);
		}
	}
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

	const search = async (req: IncomingMessage): Promise<unknown> => {
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
		if (run.searches >= MAX_SEARCHES_PER_RUN) {
			throw new WebsearchError(429, "budget_exhausted", `this run already spent its ${MAX_SEARCHES_PER_RUN} searches`);
		}
		run.searches += 1;
		const raw = await searxngSearch(searxngUrl, query, lang);
		const results: { sourceId: string; title: string; domain: string; snippet: string }[] = [];
		const seen = new Set<string>();
		for (const item of raw) {
			if (results.length >= max) break;
			if (typeof item.url !== "string") continue;
			const url = httpUrl(item.url);
			if (url === null || seen.has(url)) continue;
			seen.add(url);
			// Opaque id: the model cannot turn a result into a fetch target, and
			// the id carries neither the run nor the URL.
			const sourceId = `web_${randomBytes(9).toString("base64url")}`;
			const title = typeof item.title === "string" && item.title !== "" ? item.title : new URL(url).hostname;
			run.sources.set(sourceId, { url, title });
			results.push({
				sourceId,
				title: title.slice(0, 300),
				domain: new URL(url).hostname,
				snippet: typeof item.content === "string" ? item.content.slice(0, 500) : "",
			});
		}
		return results;
	};

	const read = async (req: IncomingMessage): Promise<unknown> => {
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
		if (run.read.has(sourceId)) {
			throw new WebsearchError(429, "already_read", "this result was already read in this run");
		}
		if (run.reads >= MAX_READS_PER_RUN) {
			throw new WebsearchError(429, "budget_exhausted", `this run already spent its ${MAX_READS_PER_RUN} reads`);
		}
		if (camofoxUrl === "") throw new WebsearchError(503, "read_unavailable", "CAMOFOX_URL is not configured");
		run.reads += 1;
		run.read.add(sourceId);
		const page = await camofoxRead(camofoxUrl, camofoxKey, user, runId, source.url, delayMs);
		const text = page.text.slice(0, MAX_READ_CHARS);
		return {
			untrusted: true,
			url: source.url,
			title: page.title !== "" ? page.title.slice(0, 300) : source.title,
			text,
			sha256: createHash("sha256").update(text).digest("hex"),
		};
	};

	const server = createServer((req, res) => {
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
					return json(res, 200, await search(req));
				}
				if (req.method === "POST" && url.pathname === "/read") {
					guard(req);
					return json(res, 200, await read(req));
				}
				return json(res, 404, { error: "not_found", message: `${req.method} ${url.pathname}` });
			} catch (error) {
				if (error instanceof WebsearchError) {
					// Never log the query or the page: only the refusal code.
					if (error.code !== "forbidden_peer") log(`refused ${error.code}: ${error.message}`);
					return json(res, error.status, { error: error.code, message: error.message });
				}
				if (error instanceof HttpError) return json(res, error.status, error.body);
				const message = error instanceof Error ? error.message : String(error);
				log(`websearch request failed: ${message}`);
				return json(res, 500, { error: "internal", message });
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
