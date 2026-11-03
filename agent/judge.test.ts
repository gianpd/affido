// RFC 0018 §7: the judge over pi-ai's classifier contract — verdict mapping,
// the frozen request shape, retry/no-retry, absence, target resolution from
// live credential state, and provider agnosticism (a second provider + model
// id served by the same class). The decisions endpoint is a local fake server;
// no network.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { Judge, type JudgeTarget } from "./judge.ts";
import {
	D1_MODEL_ID,
	JUDGE_PROVIDER,
	OPENROUTER_DECISIONS_API,
	openRouterDecisionsApi,
	judgeTargetOf,
	registerJudgeProvider,
} from "./judge-model.ts";
import { SIDECAR_PLACEHOLDER_KEY } from "./model.ts";

type Seen = { method: string; path: string; auth: string; body: string; contentType: string };

type FakeDecisionsApi = {
	readonly seen: Seen[];
	readonly port: number;
	/** Queue one response for the next request (consumed in order; when the
	 * queue runs dry the last response repeats). */
	enqueue: (status: number, body: unknown) => void;
	close: () => void;
};

const startDecisionsApi = async (): Promise<FakeDecisionsApi> => {
	const seen: Seen[] = [];
	const queue: { status: number; body: unknown }[] = [];
	let last: { status: number; body: unknown } = {
		status: 200,
		body: { answers: { relation: { choice: "supported", probabilities: { supported: 0.9, unrelated: 0.07, contradicted: 0.03 }, confidence: 0.85 } } },
	};
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", "http://fake");
			seen.push({
				method: req.method ?? "",
				path: url.pathname,
				auth: req.headers.authorization ?? "",
				body,
				contentType: String(req.headers["content-type"] ?? ""),
			});
			const next = queue.length > 0 ? (last = queue.shift() ?? last) : last;
			res.writeHead(next.status, { "content-type": "application/json" });
			res.end(JSON.stringify(next.body));
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
		enqueue: (status, body) => queue.push({ status, body }),
		close: () => {
			server.closeIdleConnections();
			server.closeAllConnections();
			server.close();
		},
	};
};

const classifierModel = (input: { readonly provider: string; readonly id: string; readonly baseUrl: string }): ClassifierModel<ClassifierApi> => ({
	type: "classifier",
	id: input.id,
	name: input.id,
	provider: input.provider,
	api: OPENROUTER_DECISIONS_API,
	baseUrl: input.baseUrl,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4_096,
});

/** The judge collection the server builds: one in-memory credential store and
 * the decisions provider. Tests only add models pointing at the fake server. */
const judgeModels = () => {
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	registerJudgeProvider(models);
	return models;
};

test("judge maps the three choices to verdicts and reads the confidence score", async () => {
	const api = await startDecisionsApi();
	const models = judgeModels();
	const target = (): JudgeTarget => ({ model: classifierModel({ provider: JUDGE_PROVIDER, id: D1_MODEL_ID, baseUrl: `http://127.0.0.1:${api.port}` }), apiKey: "sk-judge-test" });
	const judge = new Judge(models, target);
	try {
		const cases: { choice: string; verdict: string }[] = [
			{ choice: "supported", verdict: "supported" },
			{ choice: "unrelated", verdict: "unsupported" },
			{ choice: "contradicted", verdict: "contradicted" },
		];
		for (const [index, expected] of cases.entries()) {
			api.enqueue(200, {
				answers: { relation: { choice: expected.choice, probabilities: { [expected.choice]: 0.9 }, confidence: 0.91 } },
			});
			const verdict = await judge.judge({ claim: "Il canone e di 12.000 EUR.", quote: "Il canone annuo e di 12.000 EUR." });
			assert.equal(verdict.verdict, expected.verdict, `case ${index}`);
			assert.equal(verdict.score, 0.91, `case ${index}`);
		}
		// confidence absent: the choice's own probability is the score
		api.enqueue(200, { answers: { relation: { choice: "supported", probabilities: { supported: 0.64 } } } });
		const fallback = await judge.judge({ claim: "a", quote: "b" });
		assert.equal(fallback.score, 0.64);
		assert.equal(await judge.available(), true);
		// an unexpected choice is an error, never a guess
		api.enqueue(200, { answers: { relation: { choice: "banana" } } });
		await assert.rejects(judge.judge({ claim: "a", quote: "b" }), /unexpected answer/);
	} finally {
		api.close();
	}
});

test("the request is the frozen typed-choice form, bearer-stamped in direct mode, key-less in sidecar mode", async () => {
	const api = await startDecisionsApi();
	const models = judgeModels();
	try {
		const at = (key?: string) => ({ model: classifierModel({ provider: JUDGE_PROVIDER, id: D1_MODEL_ID, baseUrl: `http://127.0.0.1:${api.port}` }), ...(key === undefined ? {} : { apiKey: key }) });
		await new Judge(models, () => at("sk-judge-test")).judge({ claim: "Il canone e di 12.000 EUR.", quote: "Il canone annuo e di 12.000 EUR." });
		await new Judge(models, () => at()).judge({ claim: "x", quote: "y" });
		assert.equal(api.seen.length, 2);
		for (const record of api.seen) {
			assert.equal(record.method, "POST");
			assert.equal(record.path, "/decisions");
			assert.equal(record.contentType, "application/json");
			const body = JSON.parse(record.body) as Record<string, unknown>;
			assert.equal(body.model, D1_MODEL_ID);
			assert.match(String(body.state), /^CLAIM:\n[\s\S]*\n\nEVIDENCE:\n/);
			const relation = (body.questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>).relation;
			if (relation === undefined) throw new Error("request body carries no relation question");
			assert.equal(relation.type, "choice");
			assert.match(relation.instructions, /How does the evidence relate to the claim\?/);
			assert.deepEqual(Object.keys(relation.criteria), ["supported", "unrelated", "contradicted"]);
		}
		assert.equal(api.seen[0]?.auth, "Bearer sk-judge-test", "direct mode stamps the key");
		assert.equal(api.seen[1]?.auth, "", "sidecar mode carries no key: the sidecar stamps it");
	} finally {
		api.close();
	}
});

test("a 5xx is retried once, a 401 fails immediately, a null target is unavailable", async () => {
	const api = await startDecisionsApi();
	const models = judgeModels();
	const judge = new Judge(models, () => ({
		model: classifierModel({ provider: JUDGE_PROVIDER, id: D1_MODEL_ID, baseUrl: `http://127.0.0.1:${api.port}` }),
		apiKey: "sk-judge-test",
	}));
	try {
		api.enqueue(500, { error: { message: "boom" } });
		api.enqueue(200, { answers: { relation: { choice: "supported", probabilities: { supported: 1 }, confidence: 1 } } });
		const verdict = await judge.judge({ claim: "a", quote: "b" });
		assert.equal(verdict.verdict, "supported");
		assert.equal(api.seen.length, 2, "one retry after the 5xx");

		api.seen.length = 0;
		api.enqueue(401, { error: { message: "bad key" } });
		await assert.rejects(judge.judge({ claim: "a", quote: "b" }), /HTTP 401/);
		assert.equal(api.seen.length, 1, "4xx answers are not retried");
	} finally {
		api.close();
	}
	const absent = new Judge(models, () => null);
	assert.equal(await absent.available(), false);
	await assert.rejects(absent.judge({ claim: "a", quote: "b" }), /no classifier model backs this run/);
});

test("the class is provider-agnostic: any registered classifier model and id work", async () => {
	const api = await startDecisionsApi();
	const models = judgeModels();
	models.setProvider(
		createProvider({
			id: "local-judge",
			name: "Local judge",
			baseUrl: `http://127.0.0.1:${api.port}`,
			auth: { apiKey: { name: "local", resolve: async () => ({ auth: {} }) } },
			models: [],
			classifiers: { [OPENROUTER_DECISIONS_API]: openRouterDecisionsApi() },
		}),
	);
	try {
		const judge = new Judge(models, () => ({
			model: classifierModel({ provider: "local-judge", id: "local/encoder-v1", baseUrl: `http://127.0.0.1:${api.port}` }),
		}));
		await judge.judge({ claim: "a", quote: "b" });
		const body = JSON.parse(api.seen[0]?.body ?? "{}") as { model?: string };
		assert.equal(body.model, "local/encoder-v1", "the model id comes from the target, not from the judge");
	} finally {
		api.close();
	}
});

test("judgeTargetOf follows the live provider state (RFC 0018 §3)", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openrouter", async () => ({ type: "api_key", key: "sk-real" }));
	const savedSidecar = process.env.SIDECAR_URL;
	try {
		delete process.env.SIDECAR_URL;
		// faux and other providers: absent
		assert.equal(await judgeTargetOf({ provider: "faux", keyVia: null, credentials }), null);
		assert.equal(await judgeTargetOf({ provider: "openai", keyVia: "direct", credentials }), null);
		// openrouter with a stored real key: direct, whatever keyVia says at boot
		const direct = await judgeTargetOf({ provider: "openrouter", keyVia: null, credentials });
		assert.equal(direct?.apiKey, "sk-real");
		assert.equal(direct?.model.baseUrl, "https://openrouter.ai/api/alpha");
		assert.equal(direct?.model.id, D1_MODEL_ID);
		assert.deepEqual(await judgeTargetOf({ provider: "openrouter", keyVia: "direct", credentials }), direct);
		// sidecar delivery: the fixed route, no key here
		process.env.SIDECAR_URL = "http://sidecar:8081";
		const viaSidecar = await judgeTargetOf({ provider: "openrouter", keyVia: "sidecar", credentials });
		assert.equal(viaSidecar?.apiKey, undefined);
		assert.equal(viaSidecar?.model.baseUrl, "http://sidecar:8081/judge");
		// a stale placeholder without a sidecar deployed: absent, never a fake key
		const placeholderStore = new InMemoryCredentialStore();
		await placeholderStore.modify("openrouter", async () => ({ type: "api_key", key: SIDECAR_PLACEHOLDER_KEY }));
		delete process.env.SIDECAR_URL;
		assert.equal(await judgeTargetOf({ provider: "openrouter", keyVia: null, credentials: placeholderStore }), null);
		// no key at all: absent
		const empty = new InMemoryCredentialStore();
		assert.equal(await judgeTargetOf({ provider: "openrouter", keyVia: null, credentials: empty }), null);
	} finally {
		if (savedSidecar === undefined) delete process.env.SIDECAR_URL;
		else process.env.SIDECAR_URL = savedSidecar;
	}
});
