// RFC 0024 §6: the operator-managed catalog. Committed at
// `agent/catalog/mcp.json`, shipped in the image at /app/catalog/mcp.json,
// read by the node from its own filesystem (no mount) and by the agent for
// tool registration. `MCP_SERVERS` selects the subset a deployment offers;
// the user can only enable servers from that set (D4).
//
// The manifest is the authority (D5): descriptions and per-tool tiers are
// operator-written, generated once by `scripts/mcp-manifest.mjs` and reviewed
// in a diff. Everything the server says at runtime — descriptions, titles,
// annotations, schemas — is discarded; `tools/list` only verifies.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { MCP_DEFAULT_LIMITS, MCP_MAX_RESULT_BYTES, MCP_SERVER_ID_RE, type McpLimits } from "../mcp-protocol.ts";

export type McpToolTier = "read" | "write";

export type McpManifestTool = {
	readonly name: string;
	readonly description: string;
	readonly tier: McpToolTier;
	readonly parameters: Record<string, unknown>;
	/** sha256 of the canonical parameters JSON: the drift detector §6.4 compares. */
	readonly schemaHash: string;
};

export type McpManifestServer = {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly host: string;
	readonly network: "mcp-in" | "mcp-out";
	readonly auth: { readonly kind: "bearer"; readonly required: boolean };
	readonly limits: McpLimits;
	readonly tools: readonly McpManifestTool[];
};

export type McpCatalog = {
	readonly version: 1;
	readonly servers: readonly McpManifestServer[];
};

export class McpCatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpCatalogError";
	}
}

/** `mcp__<server>__<tool>`, non-word characters folded to `_` (D6). */
export const derivedToolName = (serverId: string, tool: string): string =>
	`mcp__${serverId.replace(/[^A-Za-z0-9_]/g, "_")}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`;

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

export const schemaHashOf = (parameters: Record<string, unknown>): string =>
	createHash("sha256").update(canonicalJson(parameters)).digest("hex");

// ── the accepted JSON Schema subset (§6.2) ──────────────────────────────────
// The model is offered the manifest schema and the node validates arguments
// against it, so the two cannot be allowed to drift through a construct only
// one side understands. `$ref`, `oneOf`/`anyOf`/`allOf`, `patternProperties`
// and `format` are rejected outright.

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean", "null"]);
const KEY_BASE = new Set(["type", "description", "title", "default", "enum", "const"]);
const KEY_STRING = new Set(["minLength", "maxLength", "pattern"]);
const KEY_NUMBER = new Set(["minimum", "maximum"]);
const KEY_OBJECT = new Set(["properties", "required", "additionalProperties"]);
const KEY_ARRAY = new Set(["items"]);

const validateSubset = (schema: unknown, where: string, depth: number): void => {
	if (depth > 8) throw new McpCatalogError(`${where}: schema nesting exceeds depth 8`);
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		throw new McpCatalogError(`${where}: every schema must be an object`);
	}
	const record = schema as Record<string, unknown>;
	const type = record["type"];
	if (typeof type !== "string") throw new McpCatalogError(`${where}: "type" is required`);
	const known = new Set([...KEY_BASE, ...KEY_STRING, ...KEY_NUMBER, ...KEY_OBJECT, ...KEY_ARRAY]);
	for (const key of Object.keys(record)) {
		if (!known.has(key)) {
			throw new McpCatalogError(`${where}: "${key}" is outside the accepted schema subset`);
		}
	}
	if (type === "object") {
		if (record["properties"] !== undefined) {
			if (typeof record["properties"] !== "object" || record["properties"] === null || Array.isArray(record["properties"])) {
				throw new McpCatalogError(`${where}.properties: must be an object`);
			}
			for (const [name, child] of Object.entries(record["properties"] as Record<string, unknown>)) {
				validateSubset(child, `${where}.properties.${name}`, depth + 1);
			}
		}
		if (record["required"] !== undefined) {
			if (
				!Array.isArray(record["required"]) ||
				record["required"].some((name) => typeof name !== "string")
			) {
				throw new McpCatalogError(`${where}.required: must be an array of property names`);
			}
		}
		if (record["additionalProperties"] !== undefined && typeof record["additionalProperties"] !== "boolean") {
			throw new McpCatalogError(`${where}.additionalProperties: must be a boolean`);
		}
		return;
	}
	if (type === "array") {
		if (record["items"] !== undefined) validateSubset(record["items"], `${where}.items`, depth + 1);
		return;
	}
	if (!SCALAR_TYPES.has(type)) {
		throw new McpCatalogError(`${where}: type "${type}" is not in the accepted subset`);
	}
	for (const key of Object.keys(record)) {
		if (KEY_OBJECT.has(key) || KEY_ARRAY.has(key)) {
			throw new McpCatalogError(`${where}: "${key}" only applies to object/array schemas`);
		}
	}
};

const isHttpUrl = (value: string): boolean => {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
};

const parseLimits = (raw: unknown, where: string): McpLimits => {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	// Removed in D15: a stale catalog must fail loud, not silently deliver
	// 128 KiB where the operator expected a 6k-character cut.
	if (record["maxResultChars"] !== undefined) {
		throw new McpCatalogError(
			`${where}.limits.maxResultChars was removed: maxResultBytes (<= ${MCP_MAX_RESULT_BYTES}) is the only size cap, refused over it, never truncated`,
		);
	}
	const int = (key: keyof McpLimits, min: number, max: number, fallback: number): number => {
		const value = record[key];
		if (value === undefined) return fallback;
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
			throw new McpCatalogError(`${where}.limits.${key}: must be an integer between ${min} and ${max}`);
		}
		return value;
	};
	return {
		timeoutMs: int("timeoutMs", 1_000, 120_000, MCP_DEFAULT_LIMITS.timeoutMs),
		maxResultBytes: int("maxResultBytes", 1_024, MCP_MAX_RESULT_BYTES, MCP_DEFAULT_LIMITS.maxResultBytes),
		requestsPerMinute: int("requestsPerMinute", 1, 600, MCP_DEFAULT_LIMITS.requestsPerMinute),
		concurrency: int("concurrency", 1, 16, MCP_DEFAULT_LIMITS.concurrency),
	};
};

const parseServer = (raw: unknown): McpManifestServer => {
	if (typeof raw !== "object" || raw === null) throw new McpCatalogError("every catalog entry must be an object");
	const record = raw as Record<string, unknown>;
	const id = record["id"];
	if (typeof id !== "string" || !MCP_SERVER_ID_RE.test(id)) {
		throw new McpCatalogError(`server id must match ${MCP_SERVER_ID_RE.source}`);
	}
	const where = `server "${id}"`;
	const title = record["title"];
	if (typeof title !== "string" || title === "" || title.length > 120) {
		throw new McpCatalogError(`${where}: title must be 1-120 characters`);
	}
	const url = record["url"];
	if (typeof url !== "string" || !isHttpUrl(url)) {
		throw new McpCatalogError(`${where}: url must be an http(s) URL`);
	}
	const host = record["host"];
	if (typeof host !== "string" || host === "" || new URL(url).hostname !== host) {
		throw new McpCatalogError(`${where}: host must equal the url's hostname`);
	}
	const network = record["network"];
	if (network !== "mcp-in" && network !== "mcp-out") {
		throw new McpCatalogError(`${where}: network must be "mcp-in" or "mcp-out"`);
	}
	const auth = record["auth"];
	if (typeof auth !== "object" || auth === null || (auth as Record<string, unknown>)["kind"] !== "bearer") {
		throw new McpCatalogError(`${where}: auth.kind must be "bearer"`);
	}
	const authRequired = (auth as Record<string, unknown>)["required"];
	if (typeof authRequired !== "boolean") {
		throw new McpCatalogError(`${where}: auth.required must be a boolean`);
	}
	const toolsRaw = record["tools"];
	if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) {
		throw new McpCatalogError(`${where}: tools must be a non-empty array`);
	}
	const tools: McpManifestTool[] = [];
	for (const toolRaw of toolsRaw) {
		if (typeof toolRaw !== "object" || toolRaw === null) throw new McpCatalogError(`${where}: every tool must be an object`);
		const tool = toolRaw as Record<string, unknown>;
		const name = tool["name"];
		if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
			throw new McpCatalogError(`${where}: tool name must be 1-64 chars of [A-Za-z0-9_-]`);
		}
		const description = tool["description"];
		if (typeof description !== "string" || description === "" || description.length > 2000) {
			throw new McpCatalogError(`${where}.${name}: description must be 1-2000 characters`);
		}
		if (description.includes("TODO(operator)")) {
			throw new McpCatalogError(`${where}.${name}: the description is still the generated TODO; review it before shipping (§6.3)`);
		}
		const tier = tool["tier"];
		if (tier !== "read" && tier !== "write") {
			throw new McpCatalogError(`${where}.${name}: tier must be "read" or "write"`);
		}
		const parameters = tool["parameters"];
		if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
			throw new McpCatalogError(`${where}.${name}: parameters must be a JSON Schema object`);
		}
		validateSubset(parameters, `${where}.${name}.parameters`, 0);
		tools.push({
			name,
			description,
			tier,
			parameters: parameters as Record<string, unknown>,
			schemaHash: schemaHashOf(parameters as Record<string, unknown>),
		});
	}
	return {
		id,
		title,
		url,
		host,
		network,
		auth: { kind: "bearer", required: authRequired },
		limits: parseLimits(record["limits"], where),
		tools,
	};
};

/** Parse and validate a catalog document. Rejects duplicate server ids,
 * duplicate derived tool names across servers, and every schema outside the
 * accepted subset. The unit test pins each refusal. */
export const parseMcpCatalog = (raw: unknown): McpCatalog => {
	if (typeof raw !== "object" || raw === null) throw new McpCatalogError("the catalog must be a JSON object");
	const record = raw as Record<string, unknown>;
	if (record["version"] !== 1) throw new McpCatalogError("catalog.version must be 1");
	const serversRaw = record["servers"];
	if (!Array.isArray(serversRaw)) throw new McpCatalogError("catalog.servers must be an array");
	const servers = serversRaw.map(parseServer);
	const ids = new Set<string>();
	const derived = new Set<string>();
	for (const server of servers) {
		if (ids.has(server.id)) throw new McpCatalogError(`duplicate server id "${server.id}"`);
		ids.add(server.id);
		for (const tool of server.tools) {
			const name = derivedToolName(server.id, tool.name);
			if (derived.has(name)) throw new McpCatalogError(`duplicate derived tool name "${name}"`);
			derived.add(name);
		}
	}
	return { version: 1, servers };
};

export class McpCatalogFile {
	readonly #catalog: McpCatalog;
	readonly #byId: Map<string, McpManifestServer>;

	constructor(catalog: McpCatalog) {
		this.#catalog = catalog;
		this.#byId = new Map(catalog.servers.map((server) => [server.id, server]));
	}

	static async load(path: string): Promise<McpCatalogFile> {
		const text = await readFile(path, "utf8");
		return new McpCatalogFile(parseMcpCatalog(JSON.parse(text)));
	}

	/** The boot path is synchronous: server.ts resolves the deployment subset
	 * before constructing the agent and its registry. */
	static loadSync(path: string): McpCatalogFile {
		return new McpCatalogFile(parseMcpCatalog(JSON.parse(readFileSync(path, "utf8"))));
	}

	get servers(): readonly McpManifestServer[] {
		return this.#catalog.servers;
	}

	server(id: string): McpManifestServer | undefined {
		return this.#byId.get(id);
	}

	/** The deployment subset: `MCP_SERVERS` (csv) intersected with the catalog.
	 * An id that is not in the catalog is a configuration error: it fails loud,
	 * never silently (D12). */
	deploymentSet(raw: string): readonly McpManifestServer[] {
		const wanted = raw
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value !== "");
		if (wanted.length === 0) return [];
		const unknown = wanted.filter((id) => !this.#byId.has(id));
		if (unknown.length > 0) {
			throw new McpCatalogError(`MCP_SERVERS lists servers not in the catalog: ${unknown.join(", ")}`);
		}
		return wanted.flatMap((id) => {
			const server = this.#byId.get(id);
			return server === undefined ? [] : [server];
		});
	}
}
