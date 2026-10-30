// RFC 0016 §5/§6 from the agent side: the two web tools are thin clients over
// the node, the first successful web_read marks the conversation tainted, and
// the taint blocks the persistence tools that a fetched page could hijack. Uses
// the real durable lifecycle, a local stub node, and the scripted faux model.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { ContainerAgent, createAgentRegistry } from "./agent.ts";
import { DurableHarness } from "./harness.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";
import type { PromptResult } from "./types.ts";

type ToolResult = { name: string; text: string; isError: boolean };

const lastUserText = (messages: readonly Message[]): string => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message !== undefined && message.role === "user") {
			return typeof message.content === "string"
				? message.content
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		}
	}
	return "";
};

const resultOf = (messages: readonly Message[], name: string): ToolResult | undefined => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined) continue;
		// The current submission only: an earlier prompt's result must not
		// satisfy a later one.
		if (message.role === "user") return undefined;
		if (message.role !== "toolResult" || message.toolName !== name || !Array.isArray(message.content)) continue;
		return {
			name,
			text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
			isError: message.isError,
		};
	}
	return undefined;
};

/** Drives the web dance and a probe tool that must be blocked after the read.
 * Keyed on named tool results: the taint section flips after web_read and
 * inserts a system entry, so the last message is no longer the tool result. */
const scripted: FauxResponseFactory = (transcript) => {
	const userText = lastUserText(transcript.messages);
	if (/search the web/i.test(userText)) {
		const read = resultOf(transcript.messages, "web_read");
		if (read !== undefined && !read.isError) {
			return fauxAssistantMessage([fauxText(`Read the page: ${read.text}`)]);
		}
		const search = resultOf(transcript.messages, "web_search");
		if (search !== undefined && !search.isError) {
			const parsed = JSON.parse(search.text) as { sourceId?: string }[];
			const sourceId = parsed[0]?.sourceId ?? "";
			return fauxAssistantMessage([fauxToolCall("web_read", { sourceId }, { id: "wr" })], { stopReason: "toolUse" });
		}
		if (search !== undefined && search.isError) return fauxAssistantMessage([fauxText(`Web failed: ${search.text}`)]);
		return fauxAssistantMessage([fauxToolCall("web_search", { query: "renewal" }, { id: "ws" })], { stopReason: "toolUse" });
	}
	if (/install a skill/i.test(userText)) {
		const install = resultOf(transcript.messages, "skills_install");
		if (install === undefined) {
			return fauxAssistantMessage([fauxToolCall("skills_install", { body: "SKILL.md" }, { id: "si" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(install.isError ? `blocked: ${install.text}` : "installed")]);
	}
	return fauxAssistantMessage([fauxText("ok")]);
};

const CONTROL = "c".repeat(64);
const RUN_TOKEN = "run-token-1";

const stubNode = async (): Promise<{ url: string; close: () => Promise<void>; runIds: string[] }> => {
	const runIds: string[] = [];
	const server = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
			const runId = String(req.headers["x-run-id"] ?? "");
			runIds.push(runId);
			const body = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
			const reply = (status: number, payload: unknown): void => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/runs") {
				if (req.headers["x-control-token"] !== CONTROL) return reply(403, { error: "forbidden_control" });
				return reply(200, { runToken: RUN_TOKEN });
			}
			if (req.url === "/search" || req.url === "/read") {
				if (req.headers["x-run-token"] !== RUN_TOKEN) return reply(403, { error: "not_authorized" });
			}
			if (req.url === "/search") {
				reply(200, [{ sourceId: "web_abcdefgh", title: "Renewal", domain: "example.com", snippet: "renewal" }]);
				return;
			}
			if (req.url === "/read") {
				if (body.url !== undefined) return reply(400, { error: "no_url_in_arguments", message: "no url" });
				reply(200, {
					untrusted: true,
					url: "https://example.com/renewal",
					title: "Renewal",
					text: "The contract renews on 1 March 2027.",
					sha256: "0".repeat(64),
				});
				return;
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
		runIds,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeIdleConnections();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
};

/** A tool the taint gate must refuse: RFC 0016 §6's "skills install" row. */
const probeTool = defineTool({
	name: "skills_install",
	description: "test probe: the gate must block this after web content",
	parameters: Type.Object({ body: Type.String() }),
	async execute() {
		return { output: [{ type: "text", text: "installed" }] };
	},
});

type Fixture = { agent: ContainerAgent; workspace: string; sessionDb: string };

const buildAgent = async (workspace: string, sessionDb: string): Promise<Fixture> => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 1_000 }, () => scripted));
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const registry = createAgentRegistry({
		name: "web-test",
		workspace,
		store: new WorkspaceCitationStore(new NodeExecutionEnv({ cwd: workspace }), BACKGROUND_CONTEXT),
	});
	registry.install(defineExtension({ name: "probe", tools: [probeTool] }));
	const harness = new DurableHarness({
		openOptions: {
			models,
			registry,
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
		},
		rootOptions: { agent: { model, cwd: workspace, thinkingLevel: "off" as const } },
		context: BACKGROUND_CONTEXT,
		sessionDb,
		idleMs: 60_000,
		log: () => {},
	});
	const agent = new ContainerAgent({
		name: "web-test",
		workspace,
		sessionDb,
		idleMs: 60_000,
		models,
		credentials,
		model,
		context: BACKGROUND_CONTEXT,
		log: () => {},
		harness,
	});
	await agent.seedWorkspace();
	return { agent, workspace, sessionDb };
};

test("web_search and web_read reach the node, and the first read taints the conversation durably", async () => {
	const node = await stubNode();
	const workspace = await mkdtemp(join(tmpdir(), "web-tools-"));
	const sessionDb = join(workspace, "session.sqlite");
	const saved = process.env.WEBSEARCH_URL;
	process.env.WEBSEARCH_URL = node.url;
	try {
		const first = await buildAgent(workspace, sessionDb);
		await first.agent.configureWeb(CONTROL);
		assert.equal(await first.agent.webTainted(), false);
		const result = (await first.agent.prompt("search the web for the renewal date", "run-web-1", "off", "allowed")) as PromptResult;
		assert.equal(result.status, "done", result.reasonDetail ?? "");
		assert.ok(result.answer?.includes("The contract renews on 1 March 2027."), result.answer ?? "no answer");
		// The trusted admission path registered the run, then the two tools
		// carried the same run id and the token the node returned.
		assert.deepEqual(node.runIds, ["run-web-1", "run-web-1", "run-web-1"]);
		// The taint is already recorded in this process...
		assert.equal(await first.agent.webTainted(), true);
		// ...and in the conversation document, not in a run-scoped bit.
		await first.agent.close();

		const restarted = await buildAgent(workspace, sessionDb);
		assert.equal(await restarted.agent.webTainted(), true, "the taint survives a restart");
		await restarted.agent.close();
	} finally {
		if (saved === undefined) delete process.env.WEBSEARCH_URL;
		else process.env.WEBSEARCH_URL = saved;
		await node.close();
	}
});

test("after web content the taint gate blocks the persistence tools it reserves", async () => {
	const node = await stubNode();
	const workspace = await mkdtemp(join(tmpdir(), "web-taint-"));
	const sessionDb = join(workspace, "session.sqlite");
	const saved = process.env.WEBSEARCH_URL;
	process.env.WEBSEARCH_URL = node.url;
	try {
		const { agent } = await buildAgent(workspace, sessionDb);
		await agent.configureWeb(CONTROL);
		// Before any web read, the probe is allowed.
		const free = (await agent.prompt("install a skill", "run-skill-1", "off")) as PromptResult;
		assert.equal(free.answer, "installed");
		// Read a page, then the same tool is blocked by the durable taint.
		await agent.prompt("search the web for the renewal date", "run-web-2", "off", "allowed");
		const blocked = (await agent.prompt("install a skill", "run-skill-2", "off")) as PromptResult;
		assert.equal(blocked.status, "done");
		assert.ok(blocked.answer?.startsWith("blocked:"), blocked.answer ?? "no answer");
		assert.ok(blocked.answer?.includes("web content"), blocked.answer ?? "");
		await agent.close();
	} finally {
		if (saved === undefined) delete process.env.WEBSEARCH_URL;
		else process.env.WEBSEARCH_URL = saved;
		await node.close();
	}
});

test("web is off unless the user allowed it for the run", async () => {
	const node = await stubNode();
	const workspace = await mkdtemp(join(tmpdir(), "web-off-"));
	const sessionDb = join(workspace, "session.sqlite");
	const saved = process.env.WEBSEARCH_URL;
	process.env.WEBSEARCH_URL = node.url;
	try {
		const { agent } = await buildAgent(workspace, sessionDb);
		await agent.configureWeb(CONTROL);
		const result = (await agent.prompt("search the web for the renewal date", "run-off-1", "off")) as PromptResult;
		assert.equal(result.status, "done");
		assert.equal(result.webMode, "off");
		assert.ok(result.answer?.includes("web_not_authorized"), result.answer ?? "no answer");
		// The model's call never reached the node: no registration, no search.
		assert.deepEqual(node.runIds, []);
		assert.equal(await agent.webTainted(), false);
		await agent.close();
	} finally {
		if (saved === undefined) delete process.env.WEBSEARCH_URL;
		else process.env.WEBSEARCH_URL = saved;
		await node.close();
	}
});

test("web tools report a missing node without breaking the run", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "web-missing-"));
	const sessionDb = join(workspace, "session.sqlite");
	const saved = process.env.WEBSEARCH_URL;
	delete process.env.WEBSEARCH_URL;
	try {
		const { agent } = await buildAgent(workspace, sessionDb);
		await agent.configureWeb(CONTROL);
		const result = (await agent.prompt("search the web for anything", "run-web-3", "off", "allowed")) as PromptResult;
		assert.equal(result.status, "done");
		assert.ok(result.answer?.includes("websearch_unavailable"), result.answer ?? "no answer");
		assert.equal(await agent.webTainted(), false);
		await agent.close();
	} finally {
		if (saved !== undefined) process.env.WEBSEARCH_URL = saved;
	}
});
