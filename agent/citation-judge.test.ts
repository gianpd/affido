// Unit tests of the post-gate coherence layer (RFC 0017 §7): the pure pieces
// (claim extraction, truncation, line walk) and the aggregation rule over a
// scripted judge — supported, unsupported, contradicted, truncation, the
// multi-id line with split support and with an overriding contradiction, judge
// errors and timeouts. No model, no pi-durable: the judge is the fake.

import assert from "node:assert/strict";
import test from "node:test";
import {
	claimOf,
	CLAIM_CAP_CHARS,
	coherenceOf,
	deriveJudgeBudget,
	budgetInvariantHolds,
	judgedLines,
	QUOTE_CAP_CHARS,
	ScriptedJudge,
	truncatePair,
	type CachedVerdict,
	type JudgeCache,
	type JudgeVerdict,
} from "./citation-judge.ts";

const supported = (score = 0.9): JudgeVerdict => ({ verdict: "supported", score });
const unsupported = (score = 0.8): JudgeVerdict => ({ verdict: "unsupported", score });
const contradicted = (score = 0.7): JudgeVerdict => ({ verdict: "contradicted", score });

const A = "cit_aaaaaaaa00";
const B = "cit_bbbbbbbb00";

const markdownOf = (line: string, heading = "## Heading") => `## Blank exempt too\n\n${heading}\n\n${line}`;
const quotes: Record<string, string> = {
	[A]: "La disdetta deve essere comunicata 90 giorni prima.",
	[B]: "Il canone annuo è di 12.000 EUR e si aggiorna ogni anno.",
};

const run = async (
	markdown: string,
	script: (input: { claim: string; quote: string }) => Promise<JudgeVerdict> | JudgeVerdict,
	options: { readonly timeoutMs?: number; readonly quotes?: Record<string, string> } = {},
) =>
	coherenceOf({
		markdown,
		quoteOf: (id) => (options.quotes ?? quotes)[id],
		judge: new ScriptedJudge(script),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});

test("claimOf strips tokens, grouped tokens and extra brackets, then collapses whitespace", () => {
	assert.equal(claimOf("La disdetta va comunicata 90 giorni prima [cit_aaaaaaaa00]."), "La disdetta va comunicata 90 giorni prima .");
	assert.equal(claimOf(`Il canone è 12.000 EUR [${A}; ${B}] e basta`), "Il canone è 12.000 EUR e basta");
	assert.equal(claimOf("  multiple   spaces  [cit_aaaaaaaa00]  "), "multiple spaces");
});

test("judgedLines walks exactly the lines the deterministic gate walks", () => {
	const lines = judgedLines("## Heading\n\ncited [cit_aaaaaaaa00]\nuncited line\nplain");
	assert.equal(lines.length, 1);
	assert.equal(lines[0]?.line, 3);
	assert.equal(lines[0]?.claim, "cited");
	assert.deepEqual(lines[0]?.citationIds, [A]);
	const grouped = judgedLines(`line [${A}; ${B}]`);
	assert.deepEqual(grouped[0]?.citationIds, [A, B]);
});

test("a supported line passes", async () => {
	const result = await run(markdownOf(`La disdetta va comunicata 90 giorni prima [${A}].`), () => supported());
	assert.deepEqual(result.ok, true);
	if (result.ok) {
		assert.equal(result.records.length, 1);
		assert.equal(result.records[0]?.verdict, "supported");
		assert.equal(result.records[0]?.line, 5);
		assert.equal(result.records[0]?.citationId, A);
		assert.equal(result.errors.length, 0);
	}
});

test("an unsupported line fails with incoherent_citation and the line preview", async () => {
	const result = await run(markdownOf(`L'assistenza è inclusa nel canone annuo [${A}].`), () => unsupported());
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "incoherent_citation");
		assert.match(result.detail, /line 5/);
		assert.match(result.detail, /L'assistenza è inclusa/);
		assert.match(result.detail, new RegExp(A));
	}
});

test("a contradicted line fails and names the verdict and score", async () => {
	const result = await run(markdownOf(`La disdetta va comunicata 30 giorni prima [${A}].`), () => contradicted(0.73));
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "incoherent_citation");
		assert.match(result.detail, /\[cit_aaaaaaaa00\] contradicted \(score 0\.73\)/);
	}
});

test("a multi-id line passes when either id supports it (split support)", async () => {
	const result = await run(markdownOf(`Il canone è 12.000 EUR e la disdetta va a 90 giorni [${A}; ${B}].`), ({ quote }) =>
		quote.includes("canone") ? unsupported() : supported(),
	);
	assert.deepEqual(result.ok, true);
	if (result.ok) assert.equal(result.records.length, 2);
});

test("a contradiction on any id of the line overrides support from another", async () => {
	const result = await run(markdownOf(`Il canone è 12.000 EUR [${A}; ${B}].`), ({ quote }) =>
		quote.includes("canone") ? supported() : contradicted(),
	);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "incoherent_citation");
		assert.match(result.detail, /contradicted/);
	}
});

test("a judge that throws is stored with a named cause and fails the line as judge_error_unverified", async () => {
	const result = await run(markdownOf(`La disdetta va comunicata 90 giorni prima [${A}].`), () => {
		throw new Error("onnx session died");
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "judge_error_unverified");
		assert.equal(result.errors.length, 1);
		assert.match(result.detail, /could not be verified/);
		// §4.2: cause, duration and message are stored, not just a counter.
		assert.deepEqual(
			{ line: result.errors[0]?.line, citationId: result.errors[0]?.citationId, cause: result.errors[0]?.cause, message: result.errors[0]?.message },
			{ line: 5, citationId: A, cause: "protocol", message: "onnx session died" },
		);
	}
});

test("failure causes are named from the binding's message vocabulary (RFC 0020 §4.2)", async () => {
	const cases: { error: Error; cause: string }[] = [
		{ error: new Error("judge timed out after 8000ms"), cause: "timeout" },
		{ error: new Error("decisions endpoint HTTP 429: rate limited"), cause: "http_4xx" },
		{ error: new Error("decisions endpoint HTTP 503: upstream down"), cause: "http_5xx" },
		{ error: new Error("fetch failed"), cause: "transport" },
		{ error: new Error("judge returned an unexpected answer: {}"), cause: "protocol" },
	];
	for (const { error, cause } of cases) {
		const result = await run(markdownOf(`La disdetta va comunicata 90 giorni prima [${A}].`), () => {
			throw error;
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.errors[0]?.cause, cause, error.message);
	}
});

test("a judge that hangs past the timeout is counted as an error, not a hang", async () => {
	const result = await run(
		markdownOf(`La disdetta va comunicata 90 giorni prima [${A}].`),
		() => new Promise<JudgeVerdict>(() => {}),
		{ timeoutMs: 50 },
	);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "judge_error_unverified");
		assert.equal(result.errors.length, 1);
		assert.equal(result.errors[0]?.cause, "timeout");
		assert.ok(result.errors[0] !== undefined && result.errors[0].ms >= 50, `ms ${result.errors[0]?.ms} covers the deadline`);
	}
});

test("an error on one id does not fail the line when another id supports it", async () => {
	const result = await run(markdownOf(`Il canone è 12.000 EUR [${A}; ${B}].`), ({ quote }) => {
		if (quote.includes("canone")) throw new Error("half the session is down");
		return supported();
	});
	assert.deepEqual(result.ok, true);
	if (result.ok) assert.equal(result.errors.length, 1);
});

test("truncatePair caps claim and quote separately, at a sentence boundary, and counts it", () => {
	const longClaim = "parola ".repeat(CLAIM_CAP_CHARS);
	const sentences = Array.from({ length: 60 }, (_, index) => `La frase numero ${index} parla del canone annuo. `);
	// The sentence with the lexical overlap with the claim must survive the cut.
	sentences[40] = "Parola parola parola: la frase che parla di parola come la claim. ";
	const quote = sentences.join("");
	const result = truncatePair(longClaim.trim(), quote);
	assert.equal(result.truncated, true);
	assert.ok(result.claim.length <= CLAIM_CAP_CHARS + 1);
	assert.ok(result.quote.length <= QUOTE_CAP_CHARS + 2);
	assert.match(result.quote, /la frase che parla di parola/);
	// A short pair is untouched.
	const short = truncatePair("claim", "quote");
	assert.deepEqual({ claim: short.claim, quote: short.quote, truncated: short.truncated }, {
		claim: "claim",
		quote: "quote",
		truncated: false,
	});
});

test("a truncated pair is flagged in its record", async () => {
	const longQuote = `${"frase senza sovrapposizione. ".repeat(120)}`;
	const result = await run(
		markdownOf(`Un claim corto [${A}].`),
		() => supported(),
		{ quotes: { [A]: longQuote } },
	);
	assert.deepEqual(result.ok, true);
	if (result.ok) assert.equal(result.records[0]?.truncated, true);
});

test("headings and blank lines stay exempt, matching the deterministic gate", async () => {
	const result = await run(`## Solo heading senza token\n\nLa disdetta va comunicata 90 giorni prima [${A}].`, () => supported());
	assert.deepEqual(result.ok, true);
	if (result.ok) assert.equal(result.records.length, 1);
});

// ── RFC 0020: the derived budget, concurrency, the cache, the run budget ────

test("the budget derivation holds its invariant for defaults and overrides, and throws on a violating one (V4)", () => {
	const defaults = deriveJudgeBudget({});
	assert.deepEqual(defaults, { pairDeadlineMs: 8_000, attemptDeadlineMs: 3_850, concurrency: 4, runBudgetMs: 30_000 });
	assert.equal(budgetInvariantHolds(defaults), true);
	for (const env of [
		{ CITATION_JUDGE_PAIR_TIMEOUT_MS: "12000" },
		{ CITATION_JUDGE_PAIR_TIMEOUT_MS: "20000", CITATION_JUDGE_CONCURRENCY: "8", CITATION_JUDGE_RUN_BUDGET_MS: "60000" },
		{ CITATION_JUDGE_PAIR_TIMEOUT_MS: "601" },
	]) {
		const budget = deriveJudgeBudget(env);
		assert.equal(budgetInvariantHolds(budget), true, JSON.stringify(env));
		assert.equal(budget.pairDeadlineMs, Number(env.CITATION_JUDGE_PAIR_TIMEOUT_MS));
	}
	// A deadline too small to hold the 2-attempt ladder plus backoff cannot boot.
	assert.throws(() => deriveJudgeBudget({ CITATION_JUDGE_PAIR_TIMEOUT_MS: "100" }), /cannot hold the 2-attempt/);
	assert.throws(() => deriveJudgeBudget({ CITATION_JUDGE_PAIR_TIMEOUT_MS: "300" }), /cannot hold the 2-attempt/);
	assert.throws(() => deriveJudgeBudget({ CITATION_JUDGE_CONCURRENCY: "x" }), /must be a positive integer/);
});

const lines6 = (ids: string[]): string =>
	`## Heading\n\n${ids.map((id, index) => `Frase numero ${index} del canone [${id}].`).join("\n")}`;

test("pairs are judged concurrently and recorded in line order (V5)", async () => {
	const ids = Array.from({ length: 12 }, (_, index) => `cit_${`${index}`.padStart(10, "0")}`);
	const quotes: Record<string, string> = Object.fromEntries(ids.map((id) => [id, "Il canone annuo e di 12.000 EUR."]));
	let inFlight = 0;
	let maxInFlight = 0;
	const started = performance.now();
	const result = await coherenceOf({
		markdown: lines6(ids),
		quoteOf: (id) => quotes[id],
		judge: new ScriptedJudge(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 200));
			inFlight -= 1;
			return supported();
		}),
		concurrency: 4,
	});
	const wall = performance.now() - started;
	assert.deepEqual(result.ok, true);
	if (result.ok) {
		assert.equal(result.records.length, 12);
		// Deterministic: verdicts follow the markdown's line/id order, not settle order.
		assert.deepEqual(
			result.records.map((record) => record.line),
			Array.from({ length: 12 }, (_, index) => index + 3),
		);
		assert.deepEqual(
			result.records.map((record) => record.citationId),
			ids,
		);
	}
	assert.ok(maxInFlight <= 4, `concurrency ${maxInFlight} exceeded the window`);
	// 12 pairs / 4 in flight = 3 rounds of ~200 ms.
	assert.ok(wall >= 600 && wall < 1_400, `wall clock ${Math.round(wall)} ms not in [600, 1400)`);
});

test("a cached pair is served with cached: true and ms: 0, never re-called (§4.4)", async () => {
	const calls: string[] = [];
	const cache = new Map<string, { verdict: "supported"; score: number }>();
	const quotes: Record<string, string> = { [A]: "La disdetta deve essere comunicata 90 giorni prima." };
	const judge = new ScriptedJudge(({ claim }) => {
		calls.push(claim);
		return supported(0.77);
	});
	const markdown = markdownOf(`La disdetta deve essere comunicata 90 giorni prima [${A}].`);
	const first = await coherenceOf({
		markdown,
		quoteOf: (id) => quotes[id],
		judge,
		cache: { get: (key) => cache.get(key), put: (key, verdict) => cache.set(key, verdict as { verdict: "supported"; score: number }) },
	});
	assert.deepEqual(first.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(cache.size, 1);
	const second = await coherenceOf({
		markdown,
		quoteOf: (id) => quotes[id],
		judge,
		cache: { get: (key) => cache.get(key), put: (key, verdict) => cache.set(key, verdict as { verdict: "supported"; score: number }) },
	});
	assert.deepEqual(second.ok, true);
	assert.equal(calls.length, 1, "the second judgement made no call");
	if (second.ok) {
		const record = second.records[0];
		assert.deepEqual({ cached: record?.cached, ms: record?.ms, score: record?.score }, { cached: true, ms: 0, score: 0.77 });
	}
});

test("the cache key is the judged pair and the model id: a model switch re-judges (§4.4)", async () => {
	const cache = new Map<string, CachedVerdict>();
	const judgeCache: JudgeCache = { get: (key) => cache.get(key), put: (key, verdict) => cache.set(key, verdict) };
	const calls: string[] = [];
	const markdown = markdownOf(`La disdetta deve essere comunicata 90 giorni prima [${A}].`);
	const ofModel = (id: string) =>
		new (class extends ScriptedJudge {
			async modelId() {
				return id;
			}
		})(() => {
			calls.push(id);
			return supported();
		});
	await coherenceOf({ markdown, quoteOf: () => "La disdetta deve essere comunicata 90 giorni prima.", judge: ofModel("liquid/d1.1"), cache: judgeCache });
	assert.equal(calls.length, 1);
	// Same pair, same model: the cache answers, no second call.
	await coherenceOf({ markdown, quoteOf: () => "La disdetta deve essere comunicata 90 giorni prima.", judge: ofModel("liquid/d1.1"), cache: judgeCache });
	assert.equal(calls.length, 1);
	// A different model behind the same judge port invalidates the key.
	await coherenceOf({ markdown, quoteOf: () => "La disdetta deve essere comunicata 90 giorni prima.", judge: ofModel("liquid/d2"), cache: judgeCache });
	assert.deepEqual(calls, ["liquid/d1.1", "liquid/d2"]);
});

test("the run budget names its own exhaustion: unresolved pairs become timeout errors (§4.3)", async () => {
	// Two cited lines: the first answers instantly, the second hangs; the run
	// budget is smaller than the pair deadline, so the hang is a budget death.
	const markdown = `## Heading\n\nLa disdetta deve essere comunicata 90 giorni prima [${A}].\nIl canone ammonta a 12.000 EUR [${B}].`;
	const quotes: Record<string, string> = {
		[A]: "La disdetta deve essere comunicata 90 giorni prima.",
		[B]: "Il canone annuo e di 12.000 EUR.",
	};
	const result = await coherenceOf({
		markdown,
		quoteOf: (id) => quotes[id],
		judge: new ScriptedJudge(({ quote }) =>
			quote.includes("disdetta") ? supported() : new Promise<JudgeVerdict>(() => {}),
		),
		timeoutMs: 500,
		concurrency: 1,
		runBudgetMs: 80,
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "judge_budget_exhausted");
		assert.ok(result.errors.length >= 1);
		assert.ok(result.errors.every((error) => error.cause === "timeout"), "every unresolved pair is a timeout");
		assert.match(result.detail, /run budget of 80 ms/);
	}
});

test("a line that passes carries its margin, and split support keeps it honest (§4.5)", async () => {
	const result = await run(
		markdownOf(`Il canone è 12.000 EUR [${A}; ${B}].`),
		({ quote }) => (quote.includes("canone") ? unsupported(0.9) : supported(0.24)),
	);
	assert.deepEqual(result.ok, true);
	if (result.ok) {
		// best supported (0.24) − best non-supported (0.9)
		assert.ok(Math.abs((result.records[1]?.margin ?? 0) - (0.24 - 0.9)) < 1e-9);
		assert.equal(result.records[0]?.margin, result.records[1]?.margin, "the margin is per line");
		assert.deepEqual(
			{ probabilities: result.records[0]?.probabilities, endpointConfidence: result.records[0]?.endpointConfidence },
			{ probabilities: undefined, endpointConfidence: undefined },
			"absent probabilities stay absent",
		);
	}
});
