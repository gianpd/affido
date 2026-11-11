// RFC 0024 §7.1: the per-user MCP node (`mcp-<user>`), fourth entrypoint of
// affido-agent:latest. Same shape as the web-search node (RFC 0016): one
// container per sandbox on the per-user internal network, the only edge
// between the sandbox and third-party MCP servers. The sandbox keeps zero
// egress; the credentials live here, in RAM, never on a volume.
//
// Three network legs (D2): pi-net-<user> (the agent calls it), mcp-in
// (operator-hosted servers), mcp-out (third-party servers, NAT, icc off).
//
// The node owns: the run registry (control token from the manager, admission
// key from Caddy via the agent's relay), the catalog enforcement (D5: the
// committed manifest is the authority; server descriptions and schemas are
// discarded), the per-server limits (§10.3: timeout, bytes while streaming,
// chars to the model, rate, concurrency, breaker) and the write tier gate
// (D7: write needs a run whose registration carried the Caddy admission
// header — the sandbox cannot mint one, T9).

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { json, HttpError, readRawBody } from "./http.ts";
import { peerAllowed, type WebsearchLog } from "./websearch.ts";
import { McpCatalogFile, type McpManifestServer } from "./mcp/catalog.ts";
import { StatelessHttpTransport } from "./mcp/stateless-http.ts";
import type { McpTransport } from "./mcp/transport.ts";
import {
	capServerText,
	isMcpConfiguredServer,
	MCP_CATALOG_PATH,
	MCP_REFUSALS,
	type McpToolError,
} from "./mcp-protocol.ts";

const DEFAULT_PORT = 8083;
const MAX_BODY_BYTES = 64 * 1024;
const RUN_ID_MAX = 128;
const RUN_ID_RE = /^[A-Za-z0-9._:-]+$/;
const CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** RFC 0024 §10.3: a run token outlives the run by at most a day. */
const RUN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS = 64;
/** §10.3: 5 failures in 60 s -> 5 min unhealthy. */
const BREAKER_FAILURES = 5;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_COOLDOWN_MS = 5 * 60_000;

export class McpGatewayError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

type ToolRuntime = {
	/** The server still offers this tool (verified against tools/list). */
	available: boolean;
	/** The server's schema differs from the manifest: the manifest wins (§6.4). */
	schemaDrift: boolean;
};

type ServerRuntime = {
	readonly manifest: McpManifestServer;
	url: string;
	token: string | undefined;
	transport: McpTransport;
	verified: boolean;
	tools: Map<string, ToolRuntime>;
	extraTools: number;
	failures: number[];
	unhealthyUntil: number;
	minuteAt: number;
	minuteCount: number;
	inFlight: number;
};

type RunState = {
	id: string;
	at: number;
	write: boolean;
	token: string;
};

// The manifest schema as a TypeBox-checkable value: the raw JSON Schema is
// validated as-is, so what the node checks on /call is exactly what the agent
// offered the model (M0's drift rule). The unit test proves Value.Check
// enforces `additionalProperties: false`, bounds and type mismatches on it.
export const manifestSchemaOf = (parameters: Record<string, unknown>): TSchema => parameters as TSchema;

export const valueCheck = (parameters: Record<string, unknown>, args: unknown): boolean =>
	Value.Check(manifestSchemaOf(parameters), args);

export type McpGatewayOptions = {
	readonly port?: number;
	readonly host?: string;
	/** CIDRs of the per-user network; anything else is forbidden_peer. */
	readonly peers?: readonly string[];
	readonly catalogPath?: string;
	/** Baked by the manager at container create (docker create env, not
	 * delivery): kills the first-set race websearch /control still has, because
	 * a bash child of the sandbox shares the agent's network but can never read
	 * this container's environment. Null (tests, standalone) accepts the first
	 * config delivery and pins it. */
	readonly controlToken?: string | null;
	readonly log?: WebsearchLog;
	readonly now?: () => number;
	readonly transportFactory?: (url: string, token: string | undefined) => McpTransport;
};

export type McpGatewayServer = {
	readonly server: ReturnType<typeof createServer>;
	readonly port: number;
	readonly close: () => Promise<void>;
};

export const createMcpGatewayServer = async (options: McpGatewayOptions = {}): Promise<McpGatewayServer> => {
	const peers = options.peers ?? [];
	const log = options.log ?? (() => {});
	const now = options.now ?? Date.now;
	const makeTransport =
		options.transportFactory ?? ((url: string, token: string | undefined) => new StatelessHttpTransport({ url, token, log }));
	const catalog = await McpCatalogFile.load(options.catalogPath ?? MCP_CATALOG_PATH);

	const servers = new Map<string, ServerRuntime>();
	const runs = new Map<string, RunState>();
	/** Set at boot from env (production) or pinned by the first config delivery. */
	const control: { token: string | null } = { token: options.controlToken ?? null };
	/** Delivered with the config by the manager; Caddy is the only minter of
	 * headers that carry it. Null until the first delivery: no write run can be
	 * registered before the manager has configured the node (fail closed). */
	const admission: { key: string | null } = { key: null };

	const guard = (req: IncomingMessage): void => {
		if (!peerAllowed(req.socket.remoteAddress, peers)) {
			throw new McpGatewayError(403, "forbidden_peer", "the caller is outside this sandbox's network");
		}
	};

	const requireControl = (req: IncomingMessage): void => {
		const provided = req.headers["x-control-token"];
		if (control.token === null) {
			throw new McpGatewayError(503, "control_token_required", "the node has no control token yet");
		}
		if (typeof provided !== "string" || provided !== control.token) {
			throw new McpGatewayError(403, "forbidden_control", "the control token is required to manage this node");
		}
	};

	const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
		const bytes = await readRawBody(req, MAX_BODY_BYTES);
		if (bytes.length === 0) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new McpGatewayError(400, "invalid_json", "the body is not JSON");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new McpGatewayError(400, "invalid_json", "the body must be a JSON object");
		}
		return parsed as Record<string, unknown>;
	};

	const requireRunId = (req: IncomingMessage): string => {
		const raw = req.headers["x-run-id"];
		const runId = Array.isArray(raw) ? raw[0] : raw;
		if (typeof runId !== "string" || runId === "" || runId.length > RUN_ID_MAX || !RUN_ID_RE.test(runId)) {
			throw new McpGatewayError(400, "missing_run", "x-run-id is required (1-128 chars of [A-Za-z0-9._:-])");
		}
		return runId;
	};

	const pruneRuns = (): void => {
		const cutoff = now() - RUN_TTL_MS;
		for (const [runId, state] of runs) {
			if (state.at < cutoff) runs.delete(runId);
		}
	};

	const registerRun = (runId: string, write: boolean): string => {
		pruneRuns();
		const existing = runs.get(runId);
		if (existing !== undefined) {
			existing.write = write;
			existing.at = now();
			return existing.token;
		}
		const token = randomBytes(18).toString("base64url");
		runs.set(runId, { id: runId, at: now(), write, token });
		if (runs.size > MAX_RUNS) {
			const oldest = runs.keys().next().value;
			if (oldest !== undefined) runs.delete(oldest);
		}
		return token;
	};

	const refusal = (status: number, code: McpToolError, detail?: string): McpGatewayError =>
		new McpGatewayError(status, code, detail === undefined ? MCP_REFUSALS[code] : `${MCP_REFUSALS[code]} (${detail})`);

	/** §6.4: compare the server's tools/list to the manifest. Descriptions and
	 * schemas are never read from the response; only presence and (hashed)
	 * schema equality are, and the manifest always wins. */
	const verifyServer = async (entry: ServerRuntime): Promise<void> => {
		const outcome = await entry.transport.listTools(AbortSignal.timeout(Math.min(entry.manifest.limits.timeoutMs, 10_000)));
		if (!outcome.ok) {
			log(`tools/list failed for ${entry.manifest.id}: ${outcome.detail}`);
			return; // stays unverified; the call path retries once and reports the named error
		}
		const upstream = new Set(outcome.tools.map((tool) => tool.name));
		for (const tool of entry.manifest.tools) {
			const runtime = entry.tools.get(tool.name);
			if (runtime === undefined) continue;
			runtime.available = upstream.has(tool.name);
		}
		entry.extraTools = [...upstream].filter((name) => !entry.manifest.tools.some((tool) => tool.name === name)).length;
		if (entry.extraTools > 0) {
			log(`server ${entry.manifest.id} offers ${entry.extraTools} tools outside the manifest: ignored (D5)`);
		}
		entry.verified = true;
	};

	const applyConfig = async (body: Record<string, unknown>): Promise<string[]> => {
		const rawServers = body.servers;
		if (!Array.isArray(rawServers)) {
			throw new McpGatewayError(400, "invalid_request", "servers must be an array");
		}
		const admissionKey = body.admissionKey;
		if (admissionKey !== undefined && (typeof admissionKey !== "string" || !(32 <= admissionKey.length && admissionKey.length <= 256))) {
			throw new McpGatewayError(400, "invalid_request", "admissionKey must be 32-256 characters");
		}
		const configured: { id: string; url: string; token?: string }[] = [];
		for (const candidate of rawServers) {
			if (!isMcpConfiguredServer(candidate)) {
				throw new McpGatewayError(400, "invalid_request", "every server must be { id, url, token? }");
			}
			const manifest = catalog.server(candidate.id);
			if (manifest === undefined) {
				throw new McpGatewayError(400, "invalid_request", `server "${candidate.id}" is not in the catalog`);
			}
			configured.push({ id: candidate.id, url: candidate.url, token: candidate.token });
		}
		// Replace the whole set (idempotent, like the agent's /config): a
		// revocation lands on the next delivery without a restart (§10.2).
		const next = new Map<string, ServerRuntime>();
		for (const server of configured) {
			const manifest = catalog.server(server.id);
			if (manifest === undefined) continue;
			const previous = servers.get(server.id);
			const tools = new Map<string, ToolRuntime>(
				manifest.tools.map((tool) => [
					tool.name,
					{ available: previous?.tools.get(tool.name)?.available ?? true, schemaDrift: false },
				]),
			);
			next.set(server.id, {
				manifest,
				url: server.url,
				token: server.token,
				transport: makeTransport(server.url, server.token),
				verified: false,
				tools,
				extraTools: 0,
				failures: previous?.failures ?? [],
				unhealthyUntil: 0,
				minuteAt: now(),
				minuteCount: 0,
				inFlight: 0,
			});
		}
		servers.clear();
		for (const [id, entry] of next) servers.set(id, entry);
		if (admissionKey !== undefined) admission.key = admissionKey;
		// Warm the verification off the request path; a call that lands first
		// verifies inline (below) within its own timeout budget.
		for (const entry of servers.values()) void verifyServer(entry).catch(() => undefined);
		return [...servers.keys()];
	};

	const call = async (req: IncomingMessage): Promise<unknown> => {
		const started = now();
		const token = req.headers["x-run-token"];
		let run: RunState | undefined;
		if (typeof token === "string") {
			for (const candidate of runs.values()) {
				if (token === candidate.token) run = candidate;
			}
		}
		if (run === undefined) {
			throw new McpGatewayError(403, "run_not_registered", "this run was not registered by the trusted admission path");
		}
		run.at = now();
		const body = await readJson(req);
		const serverId = body.serverId;
		const tool = body.tool;
		const args = body.args;
		const requestId = typeof body.requestId === "string" && CALL_ID_RE.test(body.requestId) ? body.requestId : `req_${randomBytes(9).toString("base64url")}`;
		if (typeof serverId !== "string" || typeof tool !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) {
			throw new McpGatewayError(400, "invalid_request", "{ serverId, tool, args } are required");
		}
		const entry = servers.get(serverId);
		if (entry === undefined) throw refusal(403, "server_disabled");
		const manifestTool = entry.manifest.tools.find((candidate) => candidate.name === tool);
		if (manifestTool === undefined) throw refusal(404, "tool_unavailable", `${tool} is not in the manifest`);
		if (manifestTool.tier === "write" && !run.write) throw refusal(403, "write_not_authorized");
		const runtime = entry.tools.get(tool);
		if (entry.verified && runtime !== undefined && !runtime.available) {
			throw refusal(404, "tool_unavailable", "the server dropped this tool since the manifest was written");
		}
		if (!valueCheck(manifestTool.parameters, args)) {
			throw new McpGatewayError(400, "invalid_request", "the arguments do not match the manifest schema");
		}
		// §10.3 limits: breaker, then rate window, then concurrency.
		const at = now();
		entry.failures = entry.failures.filter((time) => at - time < BREAKER_WINDOW_MS);
		if (entry.unhealthyUntil > at || entry.failures.length >= BREAKER_FAILURES) {
			if (entry.unhealthyUntil <= at) entry.unhealthyUntil = at + BREAKER_COOLDOWN_MS;
			throw refusal(503, "breaker_open");
		}
		if (at - entry.minuteAt >= 60_000) {
			entry.minuteAt = at;
			entry.minuteCount = 0;
		}
		if (entry.minuteCount >= entry.manifest.limits.requestsPerMinute) throw refusal(429, "rate_limited");
		if (entry.inFlight >= entry.manifest.limits.concurrency) {
			throw refusal(429, "rate_limited", "the per-server concurrency cap is reached");
		}
		entry.minuteCount += 1;
		entry.inFlight += 1;
		let outcome;
		try {
			if (!entry.verified) await verifyServer(entry);
			outcome = await entry.transport.callTool(
				tool,
				args as Record<string, unknown>,
				entry.manifest.limits.maxResultBytes,
				AbortSignal.timeout(entry.manifest.limits.timeoutMs),
			);
		} finally {
			entry.inFlight -= 1;
		}
		if (!outcome.ok) {
			entry.failures.push(now());
			log(`call ${serverId}.${tool} failed (${outcome.code}): ${outcome.detail}`);
			const detail = capServerText(outcome.detail);
			throw refusal(outcome.code === "timeout" ? 504 : 502, outcome.code, detail);
		}
		entry.failures = [];
		// D15: the model-facing budget is per-server chars, hard cap, truncation
		// reported honestly. No spill file: untrusted text never lands on disk.
		const full = outcome.text;
		const budget = entry.manifest.limits.maxResultChars;
		const text = full.length <= budget ? full : full.slice(0, budget);
		log(`call ${serverId}.${tool} ok (${full.length} chars${full.length > budget ? `, truncated to ${budget}` : ""}, run ${run.id})`);
		return {
			requestId,
			result: {
				untrusted: true,
				server: serverId,
				tool,
				text,
				truncated: full.length > text.length,
				totalChars: full.length,
			},
			diagnostics: { elapsedMs: now() - started },
		};
	};

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://mcp");
		void (async () => {
			try {
				if (req.method === "GET" && url.pathname === "/health") {
					return json(res, 200, { status: "ok" });
				}
				if (req.method === "GET" && url.pathname === "/status") {
					return json(res, 200, {
						status: "ok",
						control: control.token !== null,
						admission: admission.key !== null,
						servers: servers.size,
						runs: runs.size,
					});
				}
				if (req.method === "GET" && url.pathname === "/servers") {
					guard(req);
					return json(res, 200, {
						servers: [...servers.values()].map((entry) => ({
							id: entry.manifest.id,
							title: entry.manifest.title,
							verified: entry.verified,
							extraTools: entry.extraTools,
							healthy: entry.unhealthyUntil <= now() && entry.failures.length < BREAKER_FAILURES,
							tools: entry.manifest.tools.map((tool) => ({
								name: tool.name,
								tier: tool.tier,
								available: entry.tools.get(tool.name)?.available ?? true,
							})),
						})),
					});
				}
				if (req.method === "POST" && url.pathname === "/mcp/config") {
					guard(req);
					// The manager authenticates with the control token baked into this
					// container's env at create time (X-Control-Token). A node booted
					// without one (tests, standalone) pins the first token it sees.
					const provided = req.headers["x-control-token"];
					if (typeof provided !== "string" || !(32 <= provided.length && provided.length <= 128)) {
						throw new McpGatewayError(400, "invalid_request", "X-Control-Token must be 32-128 characters");
					}
					if (control.token === null) control.token = provided;
					else if (control.token !== provided) {
						throw new McpGatewayError(403, "control_token_mismatch", "this node already holds a control token");
					}
					const configured = await applyConfig(await readJson(req));
					return json(res, 200, { configured });
				}
				if (req.method === "POST" && url.pathname === "/runs") {
					guard(req);
					requireControl(req);
					const runId = requireRunId(req);
					const body = await readJson(req);
					let write = body.write === true;
					if (write) {
						// D7: only a registration that carries the admission key Caddy
						// stamps may hold write. Without it the run registers read-only.
						const provided = req.headers["x-mcp-admission"];
						if (admission.key === null || typeof provided !== "string" || provided !== admission.key) {
							write = false;
							log(`run ${runId} requested write without a valid admission stamp: registered read-only`);
						}
					}
					const runToken = registerRun(runId, write);
					// The effective grant, not the requested one: the agent stores this.
					return json(res, 200, { runToken, write });
				}
				if (req.method === "POST" && url.pathname === "/call") {
					guard(req);
					return json(res, 200, await call(req));
				}
				return json(res, 404, { error: "not_found", message: `${req.method} ${url.pathname}` });
			} catch (error) {
				if (error instanceof McpGatewayError) {
					if (error.code !== "forbidden_peer") log(`refused ${error.code}: ${error.message}`);
					return json(res, error.status, { error: error.code, message: error.message });
				}
				if (error instanceof HttpError) return json(res, error.status, error.body);
				const message = error instanceof Error ? error.message : String(error);
				log(`mcp gateway request failed: ${message}`);
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

// Bootstrap: `node /app/mcp-gateway.ts` starts the node; unit tests import the
// module without triggering it.
const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
	const port = Number(process.env.PORT ?? DEFAULT_PORT);
	const peers = (process.env.MCP_PEERS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value !== "");
	const log: WebsearchLog = (...args) => console.log("[mcp-gateway]", ...args);
	const catalogPath = process.env.MCP_CATALOG ?? MCP_CATALOG_PATH;
	void createMcpGatewayServer({
		port,
		peers,
		catalogPath,
		controlToken: process.env.MCP_CONTROL_TOKEN ?? null,
		log,
	}).then(() =>
		log(`listening on :${port} (MCP node, RFC 0024; peers ${peers.join(",") || "none"}; catalog ${catalogPath})`),
	);
}
