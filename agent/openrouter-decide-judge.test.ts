// RFC 0018 §7: the d1.1 judge runtime — verdict mapping, the frozen request
// shape, retry/no-retry, availability, and endpoint resolution from live
// credential state. The decisions endpoint is a local fake server; no network.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { SIDECAR_PLACEHOLDER_KEY } from "./model.ts";
import { D1_MODEL_ID, OpenRouterDecideJudge, resolveJudgeEndpoint, type JudgeEndpoint } from "./openrouter-decide-judge.ts";

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

const directAt = (port: number): JudgeEndpoint => ({ kind: "direct", url: `http://127.0.0.1:${port}/alpha/decisions`, apiKey: "sk-judge-test" });

test("judge maps the three choices to verdicts and reads the confidence score", async () => {
	const api = await startDecisionsApi();
	const judge = new OpenRouterDecideJudge(async () => directAt(api.port));
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
		await assert.rejects(judge.judge({ claim: "a", quote: "b" }), /unexpected choice/);
	} finally {
		api.close();
	}
});

test("the request is the frozen typed-choice form, bearer-stamped in direct mode, key-less in sidecar mode", async () => {
	const api = await startDecisionsApi();
	try {
		await new OpenRouterDecideJudge(async () => directAt(api.port)).judge({ claim: "Il canone e di 12.000 EUR.", quote: "Il canone annuo e di 12.000 EUR." });
		await new OpenRouterDecideJudge(async () => ({ kind: "sidecar", url: `http://127.0.0.1:${api.port}/judge/decisions` })).judge({ claim: "x", quote: "y" });
		assert.equal(api.seen.length, 2);
		for (const record of api.seen) {
			assert.equal(record.method, "POST");
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

test("a 5xx is retried once, a 401 fails immediately, a null endpoint is unavailable", async () => {
	const api = await startDecisionsApi();
	const judge = new OpenRouterDecideJudge(async () => directAt(api.port));
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
	const absent = new OpenRouterDecideJudge(async () => null);
	assert.equal(await absent.available(), false);
	await assert.rejects(absent.judge({ claim: "a", quote: "b" }), /no OpenRouter credential/);
});

test("resolveJudgeEndpoint follows the live provider state (RFC 0018 §3)", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openrouter", async () => ({ type: "api_key", key: "sk-real" }));
	const savedSidecar = process.env.SIDECAR_URL;
	try {
		delete process.env.SIDECAR_URL;
		// faux and other providers: absent
		assert.equal(await resolveJudgeEndpoint({ provider: "faux", keyVia: null, credentials }), null);
		assert.equal(await resolveJudgeEndpoint({ provider: "openai", keyVia: "direct", credentials }), null);
		// openrouter with a stored real key: direct, whatever keyVia says at boot
		const direct = await resolveJudgeEndpoint({ provider: "openrouter", keyVia: null, credentials });
		assert.deepEqual(direct, { kind: "direct", url: "https://openrouter.ai/api/alpha/decisions", apiKey: "sk-real" });
		assert.deepEqual(await resolveJudgeEndpoint({ provider: "openrouter", keyVia: "direct", credentials }), direct);
		// sidecar delivery: the fixed route, no key here
		process.env.SIDECAR_URL = "http://sidecar:8081";
		assert.deepEqual(await resolveJudgeEndpoint({ provider: "openrouter", keyVia: "sidecar", credentials }), {
			kind: "sidecar",
			url: "http://sidecar:8081/judge/decisions",
		});
		// a stale placeholder without a sidecar deployed: absent, never a fake key
		const placeholderStore = new InMemoryCredentialStore();
		await placeholderStore.modify("openrouter", async () => ({ type: "api_key", key: SIDECAR_PLACEHOLDER_KEY }));
		delete process.env.SIDECAR_URL;
		assert.equal(await resolveJudgeEndpoint({ provider: "openrouter", keyVia: null, credentials: placeholderStore }), null);
		// no key at all: absent
		const empty = new InMemoryCredentialStore();
		assert.equal(await resolveJudgeEndpoint({ provider: "openrouter", keyVia: null, credentials: empty }), null);
	} finally {
		if (savedSidecar === undefined) delete process.env.SIDECAR_URL;
		else process.env.SIDECAR_URL = savedSidecar;
	}
});
