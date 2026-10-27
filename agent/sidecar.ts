// RFC 0013 §6.1: the key-injection sidecar. One image, two entrypoints — this
// file is the second (`node /app/sidecar.ts`): the only process that ever holds
// a user's provider key in plaintext. The manager delivers
// `{provider, modelId, apiKey, baseUrl?}` here at resolve time and delivers a
// keyless `{provider, modelId, viaSidecar: true}` to the agent; the agent's
// model calls arrive with no credential, get the inbound auth headers stripped,
// are stamped with the real key, and are forwarded to an upstream pinned at
// delivery time (catalog hostname or the user-registered custom endpoint).
// A fully agent-compromised attacker can use the key (quota spend, inherent)
// but cannot disclose it: there is no plaintext in the agent container, and
// the key never travels anywhere but the pinned upstream over verified TLS.
//
// The proxy path scheme carries the real base URL of the provider:
//   POST {SIDECAR_URL}/<provider>/~/<percent-encoded-real-base>/<rest...>
// The encoded real base exists for RFC 0013 §4 A3/A1 parity: pi-ai resolves
// per-request compatibility quirks and the OpenAI prompt-cache key from
// substrings of `model.baseUrl`, and percent-encoding preserves those
// substrings verbatim, so detection behaves exactly as it would against the
// real URL. The sidecar decodes the segment and refuses the request when it
// does not match the pinned upstream (R3: no agent-controlled redirect).

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pathToFileURL } from "node:url";
import { json, readBody } from "./http.ts";

const DEFAULT_PORT = 8081;
const DEFAULT_CATALOG = "/app/provider-catalog.json";

export type SidecarLog = (...args: unknown[]) => void;

export type SidecarSlot = {
	readonly provider: string;
	readonly modelId: string;
	/** Plaintext, in this process's memory only. Null for faux. */
	readonly apiKey: string | null;
	readonly keyFingerprint: string | null;
	/** The pinned upstream base URL; null for faux (the agent stays direct). */
	readonly upstream: string | null;
	/** Which header the upstream expects (RFC 0013 §6.1 step 3). */
	readonly authHeader: "authorization" | "x-api-key";
};

type CatalogEntry = {
	readonly id: string;
	readonly baseUrl?: string;
	readonly auth?: string;
};

/** Module-level state: the sidecar's whole reason to exist is that this lives
 * here, in this process, and nowhere else. */
let slot: SidecarSlot | null = null;
/** Orders concurrent /config deliveries (§8: one lock, atomic replacement). */
let configChain: Promise<unknown> = Promise.resolve();
let catalogCache: readonly CatalogEntry[] | null = null;

export const resetSidecarState = (): void => {
	slot = null;
	catalogCache = null;
	configChain = Promise.resolve();
};

export const sidecarSlot = (): SidecarSlot | null => slot;

export const keyFingerprint = (apiKey: string): string =>
	createHash("sha256").update(apiKey).digest("hex").slice(0, 12);

const loadCatalog = async (path: string): Promise<readonly CatalogEntry[]> => {
	if (catalogCache !== null) return catalogCache;
	const doc = JSON.parse(await readFile(path, "utf8")) as { providers?: CatalogEntry[] };
	catalogCache = Array.isArray(doc.providers) ? doc.providers : [];
	return catalogCache;
};

/** The pinned upstream for a delivery: the catalog entry's baseUrl (operator
 * built, same image), or the user-registered custom endpoint the manager
 * already validated (RFC 0012 §5.1/§5.6). Faux is accepted and ignored. */
const resolveUpstream = async (
	provider: string,
	baseUrl: string | undefined,
	catalogPath: string,
): Promise<{ upstream: string | null; authHeader: "authorization" | "x-api-key" }> => {
	if (provider === "faux") return { upstream: null, authHeader: "authorization" };
	const entry = (await loadCatalog(catalogPath)).find((candidate) => candidate.id === provider);
	if (entry !== undefined) {
		if (typeof entry.baseUrl !== "string" || entry.baseUrl === "")
			throw new ConfigError(500, "invalid_catalog", `catalog entry ${provider} has no baseUrl`);
		return { upstream: entry.baseUrl, authHeader: entry.auth === "x-api-key" ? "x-api-key" : "authorization" };
	}
	if (baseUrl === undefined)
		throw new ConfigError(400, "invalid_base_url", `provider "${provider}" is neither faux nor in the catalog; baseUrl is required`);
	return { upstream: baseUrl, authHeader: "authorization" };
};

class ConfigError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** POST /config: the manager-only writer (same contract as the agent's /config
 * today, minus everything else). Never returns key material. */
export const configureSlot = async (body: unknown, catalogPath: string): Promise<SidecarSlot> => {
	if (typeof body !== "object" || body === null) throw new ConfigError(400, "invalid_json", "body must be a JSON object");
	const record = body as Record<string, unknown>;
	const provider = record.provider;
	const modelId = record.modelId;
	if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider))
		throw new ConfigError(400, "invalid_provider", "provider must be 1-64 chars of [a-z0-9-]");
	if (typeof modelId !== "string" || !(1 <= modelId.length && modelId.length <= 200))
		throw new ConfigError(400, "invalid_model", "modelId must be 1-200 characters");
	if (provider === "faux" && modelId !== "faux-1")
		throw new ConfigError(400, "invalid_model", "the faux provider has exactly one model: faux-1");
	let apiKey: string | undefined;
	if (record.apiKey !== undefined) {
		if (typeof record.apiKey !== "string" || !(1 <= record.apiKey.length && record.apiKey.length <= 4096))
			throw new ConfigError(400, "invalid_api_key", "apiKey must be 1-4096 characters");
		apiKey = record.apiKey;
	}
	let baseUrl: string | undefined;
	if (record.baseUrl !== undefined) {
		if (typeof record.baseUrl !== "string" || !(1 <= record.baseUrl.length && record.baseUrl.length <= 2048))
			throw new ConfigError(400, "invalid_base_url", "baseUrl must be 1-2048 characters");
		baseUrl = record.baseUrl;
	}
	if (provider === "faux") {
		apiKey = undefined;
		baseUrl = undefined;
	} else if (apiKey === undefined) {
		// The manager delivers the key here or not at all: a keyless non-faux
		// slot could stamp nothing and would only ever answer 401 upstream.
		throw new ConfigError(400, "invalid_api_key", "non-faux providers require the apiKey");
	}
	let upstreamUrl: URL | undefined;
	if (baseUrl !== undefined) {
		try {
			upstreamUrl = new URL(baseUrl);
		} catch {
			throw new ConfigError(400, "invalid_base_url", "baseUrl is not a URL");
		}
		if (upstreamUrl.protocol !== "https:" && upstreamUrl.protocol !== "http:")
			throw new ConfigError(400, "invalid_base_url", "baseUrl must be http(s)");
		if (upstreamUrl.username || upstreamUrl.password || upstreamUrl.hash)
			throw new ConfigError(400, "invalid_base_url", "baseUrl must not carry userinfo or a fragment");
	}
	const resolved = await resolveUpstream(provider, baseUrl, catalogPath);
	if (resolved.upstream !== null) {
		try {
			upstreamUrl = new URL(resolved.upstream);
		} catch {
			throw new ConfigError(500, "invalid_catalog", `pinned upstream for ${provider} is not a URL`);
		}
	}
	const next: SidecarSlot = {
		provider,
		modelId,
		apiKey: provider === "faux" ? null : (apiKey ?? null),
		keyFingerprint: provider === "faux" || apiKey === undefined ? null : keyFingerprint(apiKey),
		upstream: provider === "faux" ? null : (upstreamUrl?.href.replace(/\/$/, "") ?? null),
		authHeader: resolved.authHeader,
	};
	slot = next;
	return next;
};

// ── proxy ───────────────────────────────────────────────────────────────────

/** Never forwarded to the upstream (R3 step 2: strip every inbound
 * credential) and never relayed back. */
const STRIPPED_REQUEST_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"cookie",
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"keep-alive",
	"upgrade",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
	"content-encoding", // fetch already decompressed the body
	"content-length", // the relayed body is chunked
	"connection",
	"transfer-encoding",
	"keep-alive",
]);

/** `{provider}/~/{encoded-real-base}/{rest}` of a proxy path. */
const parseProxyPath = (pathname: string): { provider: string; realBase: string; rest: string } | null => {
	const segments = pathname.split("/");
	if (segments.length < 4 || segments[0] !== "" || segments[2] !== "~") return null;
	const provider = segments[1] ?? "";
	if (provider === "") return null;
	let realBase: string;
	try {
		realBase = decodeURIComponent(segments[3] ?? "");
	} catch {
		return null;
	}
	if (realBase === "") return null;
	return { provider, realBase, rest: segments.slice(4).join("/") };
};

export class ProxyRefused extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

const proxy = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
	if (slot === null) throw new ProxyRefused(503, "not_configured", "the sidecar holds no provider config");
	const parsed = parseProxyPath(url.pathname);
	if (parsed === null)
		throw new ProxyRefused(404, "unknown_route", `proxy paths are /<provider>/~/<encoded-base>/...`);
	if (parsed.provider !== slot.provider)
		throw new ProxyRefused(404, "unknown_provider", `only provider "${slot.provider}" is configured`);
	if (slot.apiKey === null || slot.upstream === null)
		throw new ProxyRefused(503, "not_configured", `provider "${slot.provider}" carries no key (faux stays direct)`);
	// R3: the embedded real base must equal the upstream pinned at /config
	// time. A prompt-injected agent cannot redirect the key anywhere else.
	if (parsed.realBase !== slot.upstream)
		throw new ProxyRefused(403, "unpinned_upstream", "the requested upstream is not the pinned one");

	const target = new URL(slot.upstream);
	target.pathname = target.pathname.replace(/\/+$/, "") + (parsed.rest === "" ? "" : `/${parsed.rest}`);
	target.search = url.search;

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
		if (typeof value === "string") headers[name] = value;
		else if (Array.isArray(value)) headers[name] = value.join(", ");
	}
	if (slot.authHeader === "x-api-key") headers["x-api-key"] = slot.apiKey;
	else headers.authorization = `Bearer ${slot.apiKey}`;

	const method = req.method ?? "GET";
	const controller = new AbortController();
	// Abort the upstream call only when the client actually goes away: a
	// response 'close' before 'writableFinished' is a disconnect, while the
	// request stream's own 'close' also fires after a fully-read body.
	res.on("close", () => {
		if (!res.writableFinished) controller.abort();
	});
	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method,
			headers,
			body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req),
			duplex: "half",
			redirect: "error", // a redirect would carry the stamped header off the pinned host
			signal: controller.signal,
		});
	} catch (error) {
		req.resume(); // drain the inbound body so the socket can be reused
		const reason = error instanceof Error ? error.message : String(error);
		throw new ProxyRefused(502, "upstream_unreachable", `pinned upstream did not answer: ${reason}`);
	}
	const relay: Record<string, string> = {};
	upstream.headers.forEach((value, name) => {
		if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) relay[name] = value;
	});
	res.writeHead(upstream.status, relay);
	if (upstream.body === null) {
		res.end();
		return;
	}
	// A2: pass bodies through unbuffered — SSE chunks flush as they arrive.
	const body = Readable.fromWeb(upstream.body as NodeWebReadableStream);
	body.pipe(res);
	await new Promise<void>((resolve) => {
		body.on("end", resolve);
		body.on("error", () => {
			res.destroy();
			resolve();
		});
		res.on("close", resolve);
	});
};

// ── server ──────────────────────────────────────────────────────────────────

export type SidecarServer = {
	readonly server: ReturnType<typeof createServer>;
	readonly port: number;
	readonly close: () => Promise<void>;
};

export const createSidecarServer = async (options: {
	readonly port?: number;
	readonly catalogPath?: string;
	readonly log?: SidecarLog;
}): Promise<SidecarServer> => {
	const catalogPath = options.catalogPath ?? DEFAULT_CATALOG;
	const log = options.log ?? (() => {});
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://sidecar");
		void (async () => {
			try {
				if (req.method === "GET" && url.pathname === "/health") {
					// Liveness only; never touches the key.
					return json(res, 200, { status: "ok" });
				}
				if (req.method === "GET" && url.pathname === "/status") {
					const current = slot;
					return json(res, 200, {
						provider: current?.provider ?? null,
						modelId: current?.modelId ?? null,
						keyFingerprint: current?.keyFingerprint ?? null,
						upstream: current?.upstream ?? null,
					});
				}
				if (req.method === "POST" && url.pathname === "/config") {
					const body = await readBody(req);
					// Serialized on one chain: concurrent deliveries replace the
					// slot atomically; in-flight proxy requests keep the old one.
					const delivery = configChain.then(() => configureSlot(body, catalogPath));
					configChain = delivery.catch(() => undefined);
					const applied = await delivery;
					// Never the key: fingerprint only (RFC 0012 §8.3 discipline).
					log(
						`sidecar config: provider=${applied.provider} model=${applied.modelId}`,
						`fingerprint=${applied.keyFingerprint} upstream=${applied.upstream}`,
					);
					return json(res, 200, {
						provider: applied.provider,
						modelId: applied.modelId,
						keyFingerprint: applied.keyFingerprint,
						upstream: applied.upstream,
					});
				}
				return await proxy(req, res, url);
			} catch (error) {
				if (error instanceof ConfigError)
					return json(res, error.status, { error: error.code, message: error.message });
				if (error instanceof ProxyRefused) {
					if (error.code !== "upstream_unreachable") log(`proxy refused: ${error.code}`);
					if (!res.headersSent) return json(res, error.status, { error: error.code, message: error.message });
					res.destroy();
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				log(`sidecar request failed: ${message}`);
				if (!res.headersSent) return json(res, 500, { error: "internal", message });
				res.destroy();
			}
		})();
	});
	const instance = server.listen(options.port ?? DEFAULT_PORT, "0.0.0.0");
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
				// Same discipline as the test fixture: force keep-alive sockets
				// closed so the listener releases immediately.
				instance.closeIdleConnections();
				instance.closeAllConnections();
			instance.close(() => resolve());
			}),
	};
};

// Bootstrap: `node /app/sidecar.ts` starts the server; unit tests import the
// module without triggering it.
	const invokedAsScript =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
	// RFC 0013 §6.4 P0.2: RLIMIT_CORE=0 for this process. Node core has no
	// setrlimit binding, so the enforced layer is the image entry chain
	// ("sh -c 'ulimit -c 0 && exec node …'", Dockerfile), which covers
	// standalone runs too; docker create's --ulimit core=0 covers the rest.
	const port = Number(process.env.PORT ?? DEFAULT_PORT);
	const log: SidecarLog = (...args) => console.log("[sidecar]", ...args);
	void createSidecarServer({ port, log }).then(() =>
		log(`listening on :${port} (key-injection sidecar, RFC 0013)`),
	);
}
