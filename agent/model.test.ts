// RFC 0012 M2 tests: buildProvider (built-ins and OpenAI-compatible custom
// endpoints), the fingerprint, configureProvider (§5.4 order: credential ->
// provider upsert), ContainerAgent.configureModel (status + harness pin), and
// the POST /config tool's validation.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ContainerAgent } from "./agent.ts";
import type { HarnessLifecycle, ConversationHandler } from "./harness.ts";
import { buildProvider, configureProvider, createModel, keyFingerprint } from "./model.ts";
import { ConfigTool } from "./tools.ts";
import type { AgentApi, ProviderConfig } from "./types.ts";
import type { TraceSource } from "./trace.ts";

test("keyFingerprint is 12 hex chars of sha256 and never contains the key", () => {
	const key = "sk-fingerprint-source";
	assert.equal(keyFingerprint(key), createHash("sha256").update(key).digest("hex").slice(0, 12));
	assert.match(keyFingerprint(key), /^[0-9a-f]{12}$/);
	assert.ok(!keyFingerprint(key).includes("sk-"));
});

test("buildProvider resolves catalog built-ins to their pi-ai factory", () => {
	for (const id of ["openrouter", "openai", "deepseek", "groq", "together", "fireworks", "xai", "cerebras", "mistral"]) {
		const provider = buildProvider({ id, modelId: "any" });
		assert.equal(provider.id, id, `${id} factory id`);
		assert.ok(provider.getModels().length > 0, `${id} registers its catalog models`);
	}
});

test("buildProvider builds custom OpenAI-compatible endpoints and requires baseUrl", () => {
	const provider = buildProvider({ id: "custom", modelId: "my-model", baseUrl: "https://api.example.com/v1" });
	assert.equal(provider.id, "custom");
	const models = provider.getModels();
	assert.equal(models.length, 1);
	assert.equal(models[0]?.id, "my-model");
	assert.equal(models[0]?.baseUrl, "https://api.example.com/v1");
	assert.throws(() => buildProvider({ id: "custom", modelId: "my-model" }), /baseUrl is required/);
});

test("configureProvider stores the credential, upserts the provider, and reports the fingerprint", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const applied = await configureProvider(models, credentials, {
		id: "custom",
		modelId: "my-model",
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-delivered",
	});
	assert.deepEqual(applied.model, { provider: "custom", modelId: "my-model" });
	assert.equal(applied.fingerprint, keyFingerprint("sk-delivered"));
	// The collection resolves the delivered ModelRef through the upserted provider.
	const resolved = models.getModel("custom", "my-model");
	assert.notEqual(resolved, undefined);
	// The stored credential wins over ambient env (§3.3): it resolves to the delivered key.
	const stored = await credentials.read("custom");
	assert.equal(stored?.type, "api_key");
	assert.equal(stored?.type === "api_key" ? stored.key : undefined, "sk-delivered");
	// Without a key: fingerprint null, provider still upserted (faux / keyless selections).
	const keyless = await configureProvider(models, credentials, { id: "faux", modelId: "faux-1" });
	assert.equal(keyless.fingerprint, null);
	assert.notEqual(models.getModel("faux", "faux-1"), undefined);
});

// A FakeLifecycle that records configureModel calls, mirroring agent.test.ts.
class RecordingLifecycle implements HarnessLifecycle {
	configured: { provider: string; modelId: string }[] = [];
	paused = true;
	conversationId: ConversationId | null = null;
	entries = 0;
	inFlight = 0;

	async activate<T>(_handler: ConversationHandler<T>): Promise<T> {
		throw new Error("not used in this file");
	}
	async trace<T>(handler: (source: TraceSource) => Promise<T>): Promise<T> {
		return handler({} as TraceSource);
	}
	async close(): Promise<void> {}
	async newSession() {
		return { conversationId: 1 as ConversationId, entries: 0 };
	}
	async switchSession(conversationId: number) {
		return { conversationId: conversationId as ConversationId, entries: 0 };
	}
	async configureModel(model: { provider: string; modelId: string }): Promise<void> {
		this.configured.push(model);
	}
	async refreshStats(): Promise<void> {}
}

test("ContainerAgent.configureModel updates status, fingerprint, and pins the harness", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "model-test-"));
	const lifecycle = new RecordingLifecycle();
	const bundle = await createModel();
	const agent = new ContainerAgent({
		name: "test",
		workspace,
		sessionDb: ":memory:",
		idleMs: 60_000,
		models: bundle.models,
		credentials: bundle.credentials,
		model: bundle.model,
		context: BACKGROUND_CONTEXT,
		log: () => {},
		harness: lifecycle,
	});
	assert.equal((agent.status() as Record<string, unknown>).keyFingerprint, null);
	const result = (await agent.configureModel({
		provider: "custom",
		modelId: "my-model",
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-delivered",
	})) as Record<string, unknown>;
	assert.deepEqual(result.model, { provider: "custom", modelId: "my-model" });
	assert.equal(result.keyFingerprint, keyFingerprint("sk-delivered"));
	const status = agent.status() as { model: { provider: string; modelId: string }; keyFingerprint: string | null };
	assert.deepEqual(status.model, { provider: "custom", modelId: "my-model" });
	assert.equal(status.keyFingerprint, keyFingerprint("sk-delivered"));
	// §5.4: the conversation is pinned through the harness serialization chain.
	assert.deepEqual(lifecycle.configured, [{ provider: "custom", modelId: "my-model" }]);
});

test("ConfigTool validates the delivered payload and forwards it to the agent", async () => {
	const tool = new ConfigTool();
	const url = new URL("http://sandbox/config");
	const call = async (body: unknown, agent: AgentApi) =>
		tool.handle({
			req: Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage,
			url,
			agent,
		});
	const captured: ProviderConfig[] = [];
	const credentials = new InMemoryCredentialStore();
	const collection = createModels({ credentials });
	const agent = {
		configureModel: async (config: ProviderConfig) => {
			captured.push(config);
			// The real path: buildProvider runs inside configureModel, so a
			// baseUrl-less custom provider must surface here (mapped to 400 by the tool).
			const applied = await configureProvider(collection, credentials, {
				id: config.provider,
				modelId: config.modelId,
				baseUrl: config.baseUrl,
				apiKey: config.apiKey,
			});
			return { agent: "test", model: applied.model, keyFingerprint: applied.fingerprint };
		},
	} as unknown as AgentApi;

	const ok = (await call({ provider: "e2e-fake", modelId: "e2e-fake-1", apiKey: "sk-x", baseUrl: "http://e2e-fake-upstream:8090/v1" }, agent)) as Record<string, unknown>;
	assert.deepEqual(ok.model, { provider: "e2e-fake", modelId: "e2e-fake-1" });
	assert.deepEqual(captured, [
		{ provider: "e2e-fake", modelId: "e2e-fake-1", apiKey: "sk-x", baseUrl: "http://e2e-fake-upstream:8090/v1", viaSidecar: undefined },
	]);

	await assert.rejects(call({ provider: "FAUX", modelId: "faux-1" }, agent), /invalid_provider/);
	await assert.rejects(call({ provider: "faux", modelId: "" }, agent), /invalid_model/);
	// HttpError's message is the code; the human detail lives in body.message.
	const fauxRejection = async () => {
		try {
			await call({ provider: "faux", modelId: "not-faux-1" }, agent);
		} catch (error) {
			assert.match(String((error as { body?: { message?: string } }).body?.message), /faux-1/);
			return;
		}
		assert.fail("faux with a foreign modelId must be rejected");
	};
	await fauxRejection();
	await assert.rejects(call({ provider: "custom", modelId: "m", apiKey: 42 }, agent), /invalid_api_key/);
	await assert.rejects(call({ provider: "custom", modelId: "m", baseUrl: 7 }, agent), /invalid_base_url/);
	// A baseUrl-less custom provider reaches buildProvider, whose plain Error
	// the tool maps to 400 invalid_provider with the detail in body.message.
	await assert.rejects(
		call({ provider: "custom", modelId: "m" }, agent),
		(error: unknown) => {
			assert.equal((error as { body?: { error?: string } }).body?.error, "invalid_provider");
			assert.match(String((error as { body?: { message?: string } }).body?.message), /baseUrl is required/);
			return true;
		},
	);
});

// The faux fallback delivered by §5.4 step 5 must be a real registration:
// buildProvider("faux") wires the shared scripted factory, not just the id.
test("the faux provider rebuilt through buildProvider registers faux-1", async () => {
	const provider = buildProvider({ id: "faux", modelId: "faux-1" });
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(provider);
	assert.notEqual(models.getModel("faux", "faux-1"), undefined);
});
