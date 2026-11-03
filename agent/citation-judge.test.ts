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
	judgedLines,
	QUOTE_CAP_CHARS,
	ScriptedJudge,
	truncatePair,
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
		assert.equal(result.errors, 0);
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

test("a judge that throws is counted as an error and fails the line as judge_error", async () => {
	const result = await run(markdownOf(`La disdetta va comunicata 90 giorni prima [${A}].`), () => {
		throw new Error("onnx session died");
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "judge_error");
		assert.equal(result.errors, 1);
		assert.match(result.detail, /could not be verified/);
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
		assert.equal(result.reason, "judge_error");
		assert.equal(result.errors, 1);
	}
});

test("an error on one id does not fail the line when another id supports it", async () => {
	const result = await run(markdownOf(`Il canone è 12.000 EUR [${A}; ${B}].`), ({ quote }) => {
		if (quote.includes("canone")) throw new Error("half the session is down");
		return supported();
	});
	assert.deepEqual(result.ok, true);
	if (result.ok) assert.equal(result.errors, 1);
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
