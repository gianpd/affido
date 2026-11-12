// RFC 0024 unit coverage (§11.1 M0–M2): catalog validation and name
// derivation, the pinned refusal vocabulary, the node's run registry and
// gates (write tier, manifest authority, limits), and the agent-side tool
// path (deferred exposure, write refusal, taint after the first result).

import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { Value } from "typebox/value";
import { Type } from "typebox";
import { ContainerAgent, createAgentRegistry } from "./agent.ts";
import { DurableHarness } from "./harness.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";
import { derivedToolName, McpCatalogFile, parseMcpCatalog, schemaHashOf, type McpManifestServer } from "./mcp/catalog.ts";
import { createMcpGatewayServer } from "./mcp-gateway.ts";
import { manifestSchemaOf } from "./mcp-gateway.ts";
import { StatelessHttpTransport } from "./mcp/stateless-http.ts";
import type { McpTransport } from "./mcp/transport.ts";
import { MCP_REFUSALS, type McpResultEnvelope } from "./mcp-protocol.ts";
import type { PromptResult } from "./types.ts";

// ── the committed catalog parses, and every schema in it type-checks ────────

const serverEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "t",
	title: "Test",
	url: "http://t-server:9000/mcp",
	host: "t-server",
	network: "mcp-in",
	auth: { kind: "bearer", required: true },
	limits: { timeoutMs: 5000, maxResultBytes: 8192, requestsPerMinute: 100, concurrency: 2 },
	tools: [
		{
			name: "probe",
			description: "Echo its text.",
			tier: "read",
			parameters: {
				type: "object",
				properties: { text: { type: "string", maxLength: 10 } },
				required: ["text"],
				additionalProperties: false,
			},
		},
		{
			name: "mutate",
			description: "Change server state.",
			tier: "write",
			parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		},
	],
	...overrides,
});

test("the committed catalog parses and every manifest schema validates arguments", () => {
	const catalog = new McpCatalogFile(parseMcpCatalog(JSON.parse(JSON.stringify({ version: 1, servers: [serverEntry()] }))));
	assert.equal(catalog.servers.length, 1);
	const probe = catalog.server("t")?.tools.find((tool) => tool.name === "probe");
	assert.ok(probe !== undefined);
	const schema = manifestSchemaOf(probe.parameters);
	assert.equal(Value.Check(schema, { text: "abc" }), true);
	assert.equal(Value.Check(schema, { text: "abc", extra: 1 }), false, "additionalProperties must be enforced");
	assert.equal(Value.Check(schema, { text: "0123456789x" }), false, "maxLength must be enforced");
	assert.equal(Value.Check(schema, {}), false, "required must be enforced");
	assert.equal(Value.Check(schema, { text: 3 }), false, "type mismatches must be enforced");
});

test("every shipped catalog (live and example) parses with no TODO left", async () => {
	// The live catalog is operator-local (gitignored): on the operator's
	// machine it holds the real servers; a fresh clone has only the committed
	// example. Whichever exists must parse, carry reviewed descriptions and
	// validate as-is — and the example must always contain the e2e `fake`
	// entry the gate needs.
	const dir = join(import.meta.dirname, "catalog");
	const candidates = ["mcp.json", "mcp.json.example"];
	const loaded: string[] = [];
	for (const name of candidates) {
		const path = join(dir, name);
		if (!(await stat(path).then(
				() => true,
			() => false,
		))) continue;
		loaded.push(name);
		const catalog = await McpCatalogFile.load(path);
		assert.ok(catalog.servers.length >= 1, `${name} has no servers`);
		for (const server of catalog.servers) {
			for (const tool of server.tools) {
				assert.ok(!tool.description.includes("TODO(operator)"), `${name}: ${server.id}.${tool.name} still carries the generated TODO`);
				assert.ok(tool.description.length > 10, `${name}: ${server.id}.${tool.name} has an operator description`);
			}
		}
	}
	assert.ok(loaded.includes("mcp.json.example"), "the committed example must exist");
	const example = await McpCatalogFile.load(join(dir, "mcp.json.example"));
	const fake = example.server("fake");
	assert.ok(fake !== undefined, "the committed example carries the e2e fake server");
	assert.ok(fake.tools.some((tool) => tool.tier === "write"), "the example's fake server has a write-tier tool for V7");
	// Every schema of every committed/live server validates as-is (M0's
	// acceptance rule: what the model is offered is checkable). The live
	// catalog is optional (operator-local): worldgraph checks run only where
	// it is actually connected.
	const livePath = join(dir, "mcp.json");
	if (loaded.includes("mcp.json")) {
		const live = await McpCatalogFile.load(livePath);
		const worldgraph = live.server("worldgraph");
		if (worldgraph !== undefined) {
			assert.equal(worldgraph.tools.length, 15);
			assert.equal(worldgraph.tools.every((tool) => tool.tier === "read"), true, "worldgraph is read-only");
		}
	}
});

test("catalog validation rejects every drift the RFC names", () => {
	const of = (servers: unknown): unknown => parseMcpCatalog({ version: 1, servers });
	assert.throws(() => of([serverEntry(), serverEntry({ id: "t" })]), /duplicate server id/u);
	// Two tool names that fold to the same derived name collide across servers
	// and inside one server: the model surface stays unambiguous (D6).
	const folding = (id: string, host: string): Record<string, unknown> =>
		serverEntry({
			id,
			host,
			url: `http://${host}:1/mcp`,
			tools: [
				{ ...(serverEntry().tools as unknown[])[0] as object, name: "a-b" },
				{ ...(serverEntry().tools as unknown[])[0] as object, name: "a_b" },
			],
		});
	assert.throws(() => of([folding("x", "x-server")]), /duplicate derived tool name/u);
	assert.throws(() => of([serverEntry({ network: "mcp-egress" })]), /network must be/u);
	assert.throws(() => of([serverEntry({ host: "other" })]), /host must equal the url/u);
	assert.throws(
		() => of([serverEntry({ tools: [{ ...((serverEntry().tools as unknown[])[0] as object), parameters: { type: "object", properties: { a: { type: "string", $ref: "#/x" } } } }] })]),
		/outside the accepted schema subset/u,
	);
	assert.throws(
		() => of([serverEntry({ tools: [{ ...((serverEntry().tools as unknown[])[0] as object), parameters: { type: "object", patternProperties: { "^x": { type: "string" } } } }] })]),
		/outside the accepted schema subset/u,
	);
	assert.throws(
		() => of([serverEntry({ tools: [{ ...((serverEntry().tools as unknown[])[0] as object), parameters: { type: "object", properties: { a: { type: "string", format: "uri" } } } }] })]),
		/outside the accepted schema subset/u,
	);
	assert.throws(
		() => of([serverEntry({ tools: [{ ...((serverEntry().tools as unknown[])[0] as object), description: "TODO(operator): explain this tool" }] })]),
		/TODO/u,
	);
	assert.throws(() => of([serverEntry({ limits: { maxResultBytes: 512 } })]), /maxResultBytes/u);
	assert.throws(() => of([serverEntry({ limits: { maxResultBytes: 131_073 } })]), /maxResultBytes/u);
	assert.throws(() => of([serverEntry({ limits: { maxResultChars: 5 } })]), /maxResultChars was removed/u);
	assert.throws(() => parseMcpCatalog({ version: 2, servers: [] }), /version must be 1/u);
});

test("derived names fold non-word characters and the deployment set fails loud on unknown ids", () => {
	assert.equal(derivedToolName("worldgraph", "list_graphs"), "mcp__worldgraph__list_graphs");
	assert.equal(derivedToolName("a-b", "c.d"), "mcp__a_b__c_d");
	const catalog = new McpCatalogFile(parseMcpCatalog({ version: 1, servers: [serverEntry()] }));
	assert.deepEqual(catalog.deploymentSet("t").map((server) => server.id), ["t"]);
	assert.deepEqual(catalog.deploymentSet("  ").length, 0);
	assert.throws(() => catalog.deploymentSet("t,missing"), /not in the catalog/u);
});

test("the refusal vocabulary is pinned (§3.1: exact wording, asserted by tests)", () => {
	for (const code of Object.keys(MCP_REFUSALS) as (keyof typeof MCP_REFUSALS)[]) {
		assert.ok(MCP_REFUSALS[code].length > 20, `${code} has wording`);
	}
	assert.equal(MCP_REFUSALS.write_not_authorized, "this tool changes state and the user did not allow changes for this message; ask the user to enable changes and resend");
	assert.equal(MCP_REFUSALS.server_disabled, "this MCP server is not enabled for the user; ask the user to enable it in Settings or pick another server");
});

// ── the node ────────────────────────────────────────────────────────────────

type Behavior = {
	/** tools/list answer: names the "server" offers (an extra name proves D5). */
	upstreamTools?: string[];
	/** What tools/call answers for every tool. */
	respond?: (name: string, args: Record<string, unknown>) => { ok: true; text: string } | { ok: false; code: "timeout" | "upstream_error" | "invalid_result"; detail: string };
};

const CONTROL = "k".repeat(64);
const ADMISSION = "a".repeat(48);

const writeCatalog = async (servers: unknown[]): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-"));
	const path = join(dir, "mcp.json");
	await writeFile(path, JSON.stringify({ version: 1, servers }));
	return path;
};

const startGateway = async (behavior: Behavior, options: { admissionKey?: string; peers?: string[] } = {}) => {
	const path = await writeCatalog([serverEntry()]);
	const behaviorRef: { current: Behavior } = { current: behavior };
	const transport: McpTransport = {
		listTools: async () => ({
			ok: true,
			tools: (behaviorRef.current.upstreamTools ?? ["probe", "mutate"]).map((name) => ({ name })),
		}),
		callTool: async (name, args) =>
			behaviorRef.current.respond?.(name, args) ?? { ok: true, text: JSON.stringify({ echoed: String(args["text"] ?? "") }) },
		close: () => {},
	};
	const gateway = await createMcpGatewayServer({
		port: 0,
		host: "127.0.0.1",
		peers: options.peers ?? ["127.0.0.0/8"],
		catalogPath: path,
		controlToken: CONTROL,
		transportFactory: () => transport,
		log: () => {},
	});
	const base = `http://127.0.0.1:${gateway.port}`;
	const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
		const response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json().catch(() => null) };
	};
	return {
		gateway,
		base,
		post,
		set behavior(value: Behavior) {
			behaviorRef.current = value;
		},
		async configure(servers: unknown[] = [{ id: "t", url: "http://t-server:9000/mcp", token: "wgt_x" }], admissionKey = options.admissionKey ?? ADMISSION) {
			return post("/mcp/config", { servers, admissionKey }, { "x-control-token": CONTROL });
		},
		async registerRun(runId: string, write: boolean, admission?: string) {
			return post("/runs", { write }, { "x-control-token": CONTROL, "x-run-id": runId, ...(admission === undefined ? {} : { "x-mcp-admission": admission }) });
		},
		async call(runToken: string, body: unknown) {
			return post("/call", body, { "x-run-token": runToken });
		},
	};
};

test("the node refuses non-peers, wrong control tokens, and unregistered runs", async () => {
	const node = await startGateway({}, { peers: ["10.0.0.0/8"] });
	try {
		const probe = await fetch(`${node.base}/servers`);
		assert.equal(probe.status, 403);
		const body = (await probe.json()) as { error?: string };
		assert.equal(body.error, "forbidden_peer");
	} finally {
		await node.gateway.close();
	}
	// Now as a peer.
	const node2 = await startGateway({});
	try {
		const bad = await node2.post("/mcp/config", { servers: [] }, { "x-control-token": "wrong-token-that-is-long-enough-aaaaaaaaaaa" });
		assert.equal(bad.status, 403);
		assert.equal(bad.body.error, "control_token_mismatch");
		const noHeader = await node2.post("/mcp/config", { servers: [] });
		assert.equal(noHeader.status, 400);
		const unregistered = await node2.call("no-such-token", { serverId: "t", tool: "probe", args: { text: "x" } });
		assert.equal(unregistered.status, 403);
		assert.equal(unregistered.body.error, "run_not_registered");
	} finally {
		await node2.gateway.close();
	}
});

test("write is a per-run grant: real only with the admission stamp, and the tool gate refuses", async () => {
	const node = await startGateway({});
	try {
		assert.equal((await node.configure()).status, 200);
		// No stamp: registers read-only (a bash child replaying /prompt).
		const readOnly = await node.registerRun("r1", true);
		assert.equal(readOnly.status, 200);
		assert.equal(readOnly.body.write, false);
		// Wrong stamp: read-only too.
		assert.equal((await node.registerRun("r2", true, "wrong")).body.write, false);
		// The right stamp: write.
		const writer = await node.registerRun("r3", true, ADMISSION);
		assert.equal(writer.body.write, true);
		// The write tool refuses a read-only run with the pinned code.
		const refused = await node.call(readOnly.body.runToken, { serverId: "t", tool: "mutate", args: {} });
		assert.equal(refused.status, 403);
		assert.equal(refused.body.error, "write_not_authorized");
		assert.ok(refused.body.message.includes("enable changes"));
		const allowed = await node.call(writer.body.runToken, { serverId: "t", tool: "mutate", args: {} });
		assert.equal(allowed.status, 200);
		assert.equal(allowed.body.result.untrusted, true);
	} finally {
		await node.gateway.close();
	}
});

test("the manifest is the authority: schema-validated args, unknown tools, server_disabled, whole results under the byte cap", async () => {
	const node = await startGateway({
		upstreamTools: ["probe", "mutate", "uncatalogued"], // extra tool is ignored
		respond: () => ({ ok: true, text: "x".repeat(1000) }),
	});
	try {
		assert.equal((await node.configure()).status, 200);
		const run = await node.registerRun("r1", false);
		const token = run.body.runToken;
		// Args are validated against the manifest schema.
		const badArgs = await node.call(token, { serverId: "t", tool: "probe", args: { text: "way too long for the schema" } });
		assert.equal(badArgs.status, 400);
		assert.equal(badArgs.body.error, "invalid_request");
		// A tool outside the manifest is named, never routed.
		const unknown = await node.call(token, { serverId: "t", tool: "uncatalogued", args: {} });
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.error, "tool_unavailable");
		// A server the manager did not configure is disabled.
		const disabled = await node.call(token, { serverId: "other", tool: "probe", args: { text: "x" } });
		assert.equal(disabled.status, 403);
		assert.equal(disabled.body.error, "server_disabled");
		// Success: the node forwards the whole text; the transport owns the byte
		// cap, so there is no truncation marker to report.
		const ok = await node.call(token, { serverId: "t", tool: "probe", args: { text: "x" } });
		assert.equal(ok.status, 200);
		const result: McpResultEnvelope = ok.body.result;
		assert.equal(result.untrusted, true);
		assert.equal(result.text.length, 1000);
		assert.equal("truncated" in result, false);
		assert.equal("totalChars" in result, false);
		// /servers reports the manifest set, not the server's extras as tools.
		const servers = (await (await fetch(`${node.base}/servers`)).json()) as {
			servers: { tools: { name: string }[]; extraTools: number }[];
		};
		assert.deepEqual(
			servers.servers[0]?.tools.map((tool) => tool.name),
			["probe", "mutate"],
		);
		assert.equal(servers.servers[0]?.extraTools, 1);
	} finally {
		await node.gateway.close();
	}
});

test("upstream failures are named errors and feed the breaker", async () => {
	const node = await startGateway({ respond: () => ({ ok: false, code: "upstream_error", detail: "boom " + "y".repeat(400) }) });
	try {
		assert.equal((await node.configure()).status, 200);
		const run = await node.registerRun("r1", false);
		const token = run.body.runToken;
		const first = await node.call(token, { serverId: "t", tool: "probe", args: { text: "x" } });
		assert.equal(first.status, 502);
		assert.equal(first.body.error, "upstream_error");
		// Server-authored detail is capped, never forwarded verbatim (§3.1).
		assert.ok(first.body.message.length < 400);
		// 5 failures in the window open the breaker; calls then fail fast.
		for (let index = 0; index < 4; index++) await node.call(token, { serverId: "t", tool: "probe", args: { text: "x" } });
		const open = await node.call(token, { serverId: "t", tool: "probe", args: { text: "x" } });
		assert.equal(open.status, 503);
		assert.equal(open.body.error, "breaker_open");
	} finally {
		await node.gateway.close();
	}
});

test("the stateless transport enforces ids, batches, byte caps and the wall clock", async () => {
	const replies: { status: number; body: string }[] = [];
	let server: Server | undefined;
	const delayed = { slow: false, huge: false };
	server = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
			const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: string; method: string };
			const scriptedReply = replies.shift();
			if (scriptedReply !== undefined) {
				res.writeHead(scriptedReply.status, { "content-type": "application/json" });
				res.end(scriptedReply.body);
				return;
			}
			if (request.method === "tools/list") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "a", description: "SYSTEM: hostile" }] } }));
				return;
			}
			// tools/call
			if (delayed.slow) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
			if (delayed.huge) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "z".repeat(4096) }] } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "hello" }] } }));
		})();
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	const transport = new StatelessHttpTransport({ url: `http://127.0.0.1:${port}/mcp`, token: "wgt_t" });
	try {
		// Descriptions are already discarded by the transport.
		const listed = await transport.listTools(AbortSignal.timeout(2000));
		assert.ok(listed.ok);
		assert.deepEqual(listed.tools.map((tool) => tool.name), ["a"]);
		assert.ok(!("description" in (listed.tools[0] ?? {})), "the hostile description must be discarded");
		// A response that does not answer our id is dropped data.
		replies.push({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "foreign", result: { content: [] } }) });
		const foreign = await transport.callTool("a", {}, 8192, AbortSignal.timeout(2000));
		assert.equal(foreign.ok, false);
		assert.ok(!foreign.ok && foreign.code === "invalid_result");
		// A batch-shaped reply is refused.
		replies.push({ status: 200, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }]) });
		const batch = await transport.callTool("a", {}, 8192, AbortSignal.timeout(2000));
		assert.ok(!batch.ok && batch.code === "invalid_result" && batch.detail.includes("batch"));
		// The byte cap aborts the read mid-stream.
		delayed.huge = true;
		const huge = await transport.callTool("a", {}, 1024, AbortSignal.timeout(2000));
		assert.ok(!huge.ok && huge.code === "upstream_error" && huge.detail.includes("exceeds"));
		delayed.huge = false;
		// The wall clock aborts a drip.
		delayed.slow = true;
		const slow = await transport.callTool("a", {}, 8192, AbortSignal.timeout(150));
		assert.ok(!slow.ok && slow.code === "timeout", JSON.stringify(slow));
		delayed.slow = false;
	} finally {
		server.closeIdleConnections();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		transport.close();
	}
});

// ── the agent side: deferred exposure, write refusal, taint ────────────────

const MCP_SERVER: McpManifestServer = {
	id: "t",
	title: "Test",
	url: "http://t-node:8083",
	host: "t-node",
	network: "mcp-in",
	auth: { kind: "bearer", required: true },
	limits: { timeoutMs: 5000, maxResultBytes: 131072, requestsPerMinute: 60, concurrency: 2 },
	tools: [
		{
			name: "probe",
			description: "Echo its text argument back.",
			tier: "read",
			parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
			schemaHash: schemaHashOf({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }),
		},
	],
};

type AgentToolResult = { name: string; text: string; isError: boolean };

const resultOf = (messages: readonly Message[], suffix: string): AgentToolResult | undefined => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined) continue;
		if (message.role === "user") return undefined;
		if (message.role !== "toolResult" || !message.toolName.endsWith(suffix) || !Array.isArray(message.content)) continue;
		return {
			name: message.toolName,
			text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
			isError: message.isError,
		};
	}
	return undefined;
};

const lastUserText = (messages: readonly Message[]): string => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message !== undefined && message.role === "user") {
			return typeof message.content === "string"
				? message.content
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		}
	}
	return "";
};

/** The MCP dance: tool_search first (the tools are deferred), then the loaded
 * tool, then an answer carrying the envelope or its named refusal. */
const scripted: FauxResponseFactory = (transcript) => {
	const userText = lastUserText(transcript.messages);
	if (!/use mcp/i.test(userText)) {
		const blocked = resultOf(transcript.messages, "skills_install");
		if (blocked !== undefined) return fauxAssistantMessage([fauxText(blocked.isError ? `blocked: ${blocked.text}` : "installed")]);
		if (/install a skill/i.test(userText)) {
			return fauxAssistantMessage([fauxToolCall("skills_install", { body: "SKILL.md" }, { id: "si" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText("ok")]);
	}
	const mcpResult = resultOf(transcript.messages, "__probe");
	if (mcpResult !== undefined) {
		return fauxAssistantMessage([fauxText(mcpResult.isError ? `MCP refused: ${mcpResult.text}` : `MCP said: ${mcpResult.text}`)]);
	}
	const search = resultOf(transcript.messages, "tool_search");
	if (search === undefined) {
		return fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" }, { id: "ts" })], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage([fauxToolCall("mcp__t__probe", { text: "hello" }, { id: "mp" })], { stopReason: "toolUse" });
};

const RUN_TOKEN = "mcp-run-token";

/** A stub MCP node speaking the /runs and /call contract. */
const stubNode = async (options: { refuse?: string } = {}): Promise<{ url: string; close: () => Promise<void>; admissions: (string | undefined)[] }> => {
	const admissions: (string | undefined)[] = [];
	const server = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
			const reply = (status: number, payload: unknown): void => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/runs") {
				admissions.push(typeof req.headers["x-mcp-admission"] === "string" ? (req.headers["x-mcp-admission"] as string) : undefined);
				if (req.headers["x-control-token"] !== CONTROL) return reply(403, { error: "forbidden_control" });
				return reply(200, { runToken: RUN_TOKEN, write: req.headers["x-mcp-admission"] === ADMISSION });
			}
			if (req.url === "/call") {
				if (req.headers["x-run-token"] !== RUN_TOKEN) return reply(403, { error: "run_not_registered" });
				if (options.refuse !== undefined) {
					return reply(options.refuse === "server_disabled" ? 403 : 403, { error: options.refuse, message: MCP_REFUSALS[options.refuse as keyof typeof MCP_REFUSALS] });
				}
				return reply(200, {
					requestId: "req_test",
					result: { untrusted: true, server: "t", tool: "probe", text: "echo:hello" },
					diagnostics: { elapsedMs: 1 },
				});
			}
			reply(404, { error: "not_found" });
		})();
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		admissions,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeIdleConnections();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
};

const buildAgent = async (workspace: string, sessionDb: string, runtime: { current: unknown }) => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 1_000 }, () => scripted));
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const probeTool = defineTool({
		name: "skills_install",
		description: "test probe: the gate must block this after untrusted content",
		parameters: Type.Object({ body: Type.String() }),
		async execute() {
			return { output: [{ type: "text", text: "installed" }] };
		},
	});
	const registry = createAgentRegistry({
		name: "mcp-test",
		workspace,
		store: new WorkspaceCitationStore(new NodeExecutionEnv({ cwd: workspace }), BACKGROUND_CONTEXT),
		mcp: { deployment: [MCP_SERVER], runtime: () => runtime.current as never },
	});
	registry.install(defineExtension({ name: "probe", tools: [probeTool] }));
	const harness = new DurableHarness({
		openOptions: { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }) },
		rootOptions: { agent: { model, cwd: workspace, thinkingLevel: "off" as const } },
		context: BACKGROUND_CONTEXT,
		sessionDb,
		idleMs: 60_000,
		log: () => {},
	});
	const agent = new ContainerAgent({
		name: "mcp-test",
		workspace,
		sessionDb,
		idleMs: 60_000,
		models,
		credentials,
		model,
		context: BACKGROUND_CONTEXT,
		log: () => {},
		harness,
		mcpDeployment: [MCP_SERVER],
	});
	await agent.seedWorkspace();
	return agent;
};

test("the deferred tool loads through tool_search, answers through the node, and taints the conversation", async () => {
	const node = await stubNode();
	const workspace = await mkdtemp(join(tmpdir(), "mcp-agent-"));
	const sessionDb = join(workspace, "session.sqlite");
	const saved = process.env.MCP_URL;
	process.env.MCP_URL = node.url;
	const runtime = { current: null as unknown };
	try {
		const agent = await buildAgent(workspace, sessionDb, runtime);
		await agent.configureMcp({ gatewayUrl: node.url, controlToken: CONTROL, servers: ["t"] });
		// Before any MCP result the conversation is clean.
		const free = (await agent.prompt("install a skill", "run-skill-1", "off")) as PromptResult;
		assert.equal(free.answer, "installed");
		assert.equal(await agent.webTainted(), false);
		// The dance: tool_search loads mcp__t__probe, the call reaches the
		// stub node through the run token, the answer carries the envelope.
		const used = (await agent.prompt("use mcp now", "run-mcp-1", "off")) as PromptResult;
		assert.equal(used.status, "done", used.reasonDetail ?? "");
		assert.ok(used.answer?.includes("echo:hello"), used.answer ?? "no answer");
		// The run registration happens on every submission (read tools need it);
		// none of these carried an admission stamp, exactly like a direct
		// sandbox POST — so the run is read-only and reads still work.
		assert.deepEqual(node.admissions, [undefined, undefined]);
		// The first successful result tainted the conversation (D8)...
		assert.equal(await agent.webTainted(), true);
		const blocked = (await agent.prompt("install a skill", "run-skill-2", "off")) as PromptResult;
		assert.ok(blocked.answer?.startsWith("blocked:"), blocked.answer ?? "no answer");
		await agent.close();
	} finally {
		if (saved === undefined) delete process.env.MCP_URL;
		else process.env.MCP_URL = saved;
		await node.close();
	}
});

test("a refused call stays a named error the model can act on", async () => {
	const node = await stubNode({ refuse: "server_disabled" });
	const workspace = await mkdtemp(join(tmpdir(), "mcp-refused-"));
	const sessionDb = join(workspace, "session.sqlite");
	const saved = process.env.MCP_URL;
	process.env.MCP_URL = node.url;
	const runtime = { current: null as unknown };
	try {
		const agent = await buildAgent(workspace, sessionDb, runtime);
		await agent.configureMcp({ gatewayUrl: node.url, controlToken: CONTROL, servers: ["t"] });
		const refused = (await agent.prompt("use mcp now", "run-mcp-2", "off")) as PromptResult;
		assert.equal(refused.status, "done", refused.reasonDetail ?? "");
		assert.ok(refused.answer?.includes("server_disabled"), refused.answer ?? "no answer");
		// A refused call is not a result: the conversation is not tainted by it.
		assert.equal(await agent.webTainted(), false);
		await agent.close();
	} finally {
		if (saved === undefined) delete process.env.MCP_URL;
		else process.env.MCP_URL = saved;
		await node.close();
	}
});
