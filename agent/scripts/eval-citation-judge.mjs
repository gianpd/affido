#!/usr/bin/env node
// The RFC 0017 §8 eval: baseline (deterministic gate only) vs gate + mobile
// ONNX judge vs gate + 523 MB non-mobile judge, over hand-labeled fixtures.
// One command, deterministic: pinned weights, no sampling, argmax decisions.
//
//   node agent/scripts/eval-citation-judge.mjs [cache-root]
//
// Writes raw JSON and a Markdown summary under agent/judge-eval/ (gitignored)
// and prints the summary. Requires both caches (decide-mobile, decide) under
// the cache root (default agent/judge-models, see fetch-judge-model.mjs).

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hostname, cpus, totalmem } from "node:os";
import { evaluatePublish } from "../citation-store.ts";
import { truncatePair } from "../citation-judge.ts";
import { GlinerDecideJudge, FULL_MANIFEST, MOBILE_MANIFEST } from "../gliner-decide-judge.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(HERE, "..", "..");
const CACHE = resolve(process.argv[2] ?? process.env.CITATION_JUDGE_MODEL_DIR ?? join(ROOT, "agent", "judge-models"));
const OUT_DIR = join(ROOT, "agent", "judge-eval");

const fixtures = JSON.parse(await readFile(join(HERE, "judge-eval-fixtures.json"), "utf8"));
const pairs = fixtures.pairs;
const dev = pairs.filter((pair) => pair.split === "dev");
const test = pairs.filter((pair) => pair.split === "test");

/** The deterministic gate over a fixture-shaped publish: the quote is stored
 * state, the line carries its token, so the gate accepts by construction —
 * which is exactly the false-accept baseline being measured. */
const gateAccepts = (pair) => {
	const id = "cit_0000000000";
	const quote = pair.kind === "multi" ? (pair.quotes[0] ?? "") : pair.quote;
	const markdown = `## Heading\n\n${pair.claim} [${id}].`;
	const annotation = {
		citationId: id,
		runId: "eval",
		docId: "doc_eval",
		docVersion: 1,
		start: 0,
		end: quote.length,
		line: 1,
		quote,
		textSha256: "0".repeat(64),
		status: "verified",
		at: 0,
	};
	return evaluatePublish({ markdown, declared: [id], annotations: [annotation], runId: "eval" }).ok;
};

const percentile = (sorted, fraction) =>
	sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];

/** One judged fixture: multi fixtures aggregate over their quotes (RFC 0017
 * §4.2: pass iff at least one pair supported and none contradicted). */
const judgeFixture = async (judge, pair) => {
	const quotes = pair.kind === "multi" ? pair.quotes : [pair.quote];
	const started = performance.now();
	let supported = false;
	let contradiction = null;
	const verdicts = [];
	let truncated = false;
	for (const quote of quotes) {
		const prepared = truncatePair(pair.claim, quote);
		truncated ||= prepared.truncated;
		const verdict = await judge.judge({ claim: prepared.claim, quote: prepared.quote });
		verdicts.push(verdict);
		if (verdict.verdict === "supported") supported = true;
		if (verdict.verdict === "contradicted" && contradiction === null) contradiction = verdict;
	}
	// The gate-level outcome: a line the layer lets through ("supported") or
	// rejects. For per-class confusion the distinguishing verdict is kept.
	const outcome = contradiction !== null ? "contradicted" : supported ? "supported" : "unsupported";
	return { outcome, verdicts, truncated, ms: performance.now() - started };
};

const confusion = (results) => {
	const matrix = {};
	for (const result of results) {
		const row = (matrix[result.label] ??= { supported: 0, unsupported: 0, contradicted: 0 });
		row[result.outcome] += 1;
	}
	return matrix;
};

const rates = (results) => {
	const nonSupported = results.filter((r) => r.label !== "supported");
	const supported = results.filter((r) => r.label === "supported");
	const falseAccepts = nonSupported.filter((r) => r.outcome === "supported").length;
	const falseRejects = supported.filter((r) => r.outcome !== "supported").length;
	return {
		falseAcceptRate: nonSupported.length === 0 ? null : falseAccepts / nonSupported.length,
		falseAccepts,
		nonSupported: nonSupported.length,
		falseRejectRate: supported.length === 0 ? null : falseRejects / supported.length,
		falseRejects,
		supported: supported.length,
	};
};

const summarize = (name, results, latencies, truncatedCount, rssPeak) => ({
	name,
	n: results.length,
	confusion: confusion(results),
	...rates(results),
	perLanguage: ["en", "it"].map((lang) => {
		const subset = results.filter((r) => r.lang === lang);
		return { lang, ...rates(subset), confusion: confusion(subset) };
	}),
	truncated: truncatedCount,
	latencyMs: { p50: percentile([...latencies].sort((a, b) => a - b), 0.5), p95: percentile([...latencies].sort((a, b) => a - b), 0.95) },
	rssPeakMb: rssPeak,
});

const runJudge = async (name, dir, manifest) => {
	const judge = new GlinerDecideJudge(join(CACHE, dir), manifest);
	const started = performance.now();
	// cold start measured on the first judge call
	let coldStartMs = null;
	const run = async (split, set) => {
		const results = [];
		const latencies = [];
		let truncated = 0;
		for (const pair of set) {
			const before = performance.now();
			const outcome = await judgeFixture(judge, pair);
			if (coldStartMs === null) coldStartMs = performance.now() - started;
			latencies.push(outcome.ms);
			if (outcome.truncated) truncated += 1;
			results.push({ id: pair.id, lang: pair.lang, label: pair.label, outcome: outcome.outcome, verdicts: outcome.verdicts, truncated: outcome.truncated, ms: outcome.ms });
		}
		return { split, ...summarize(`${name}/${split}`, results, latencies, truncated, process.memoryUsage().rss / 1048576), results };
	};
	const devRun = await run("dev", dev);
	const testRun = await run("test", test);
	await judge.close();
	return { name, coldStartMs, dev: devRun, test: testRun };
};

console.log(`fixtures: ${pairs.length} (${dev.length} dev, ${test.length} test; ${pairs.filter((p) => p.lang === "it").length} Italian)`);
console.log(`cache: ${CACHE}`);

// 1. Baseline: the deterministic gate alone.
const baselineResults = [...dev, ...test].map((pair) => ({
	id: pair.id,
	split: pair.split,
	lang: pair.lang,
	label: pair.label,
	outcome: gateAccepts(pair) ? "supported" : "unsupported",
}));
const baseline = {
	name: "baseline (deterministic gate only)",
	dev: { split: "dev", ...summarize("baseline/dev", baselineResults.filter((r) => r.split === "dev"), [], 0, process.memoryUsage().rss / 1048576) },
	test: { split: "test", ...summarize("baseline/test", baselineResults.filter((r) => r.split === "test"), [], 0, process.memoryUsage().rss / 1048576) },
};

// 2/3. Gate + judge, mobile and non-mobile.
const mobile = await runJudge("mobile-q4f16-345MB", "decide-mobile", MOBILE_MANIFEST);
const full = await runJudge("full-q4f16-523MB", "decide", FULL_MANIFEST);

// Mobile vs non-mobile verdict agreement per split.
const agreement = (a, b) => {
	const byId = new Map(b.results.map((r) => [r.id, r.outcome]));
	const same = a.results.filter((r) => byId.get(r.id) === r.outcome).length;
	return { agree: same, n: a.results.length, ratio: same / a.results.length };
};
const mobileFullAgreement = {
	dev: agreement(mobile.dev, full.dev),
	test: agreement(mobile.test, full.test),
};

const report = {
	date: new Date().toISOString(),
	machine: { hostname: hostname(), cpus: cpus().length, totalmemMb: Math.round(totalmem / 1048576), node: process.version },
	artifacts: {
		mobile: { repo: MOBILE_MANIFEST.repo, revision: MOBILE_MANIFEST.revision, dtype: MOBILE_MANIFEST.dtype },
		full: { repo: "onnx-community/GLiNER2.5-Decide-ONNX", revision: "18271032588167fe9a3fbb8c5a4900b1231f8119", dtype: "q4f16" },
	},
	threshold: fixtures.threshold,
	fixtures: { total: pairs.length, dev: dev.length, test: test.length, italian: pairs.filter((p) => p.lang === "it").length },
	baseline,
	mobile,
	full,
	mobileFullAgreement,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, `judge-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(report, null, 1));

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
const line = (run) =>
	`| ${run.name} | ${run.n} | ${pct(run.falseAcceptRate)} (${run.falseAccepts}/${run.nonSupported}) | ${pct(run.falseRejectRate)} (${run.falseRejects}/${run.supported}) | ${run.latencyMs.p50.toFixed(0)}/${run.latencyMs.p95.toFixed(0)} |`;
const confusionRow = (run) =>
	`\t${JSON.stringify(run.confusion)} it: FA ${pct(run.perLanguage.find((l) => l.lang === "it")?.falseAcceptRate ?? null)} FR ${pct(
		run.perLanguage.find((l) => l.lang === "it")?.falseRejectRate ?? null,
	)}`;

const summary = `# Citation coherence judge — eval ${report.date}

Machine: ${report.machine.hostname}, ${report.machine.cpus} CPUs, ${report.machine.totalmemMb} MB RAM, node ${report.machine.node}.
Weights: ${report.artifacts.mobile.repo}@${report.artifacts.mobile.revision} (mobile) and ${report.artifacts.full.repo}@${report.artifacts.full.revision} (full), both q4f16, local cache, remote models disabled.
Decision rule: ${report.threshold}. Fixtures: ${report.fixtures.total} (${report.fixtures.dev} dev, ${report.fixtures.test} test, ${report.fixtures.italian} Italian), hand-labeled.

## False accepts / false rejects (the agreed bar: FA cut >= 60%, FR <= 10%)

| Run | n | FA unrelated+contradicted | FR supported | latency p50/p95 ms |
|---|---|---|---|---|
${line(baseline.dev)}
${line(mobile.dev)}
${line(full.dev)}
${line(baseline.test)}
${line(mobile.test)}
${line(full.test)}

## Confusion (label -> outcome), with the Italian subset rates

* ${mobile.dev.name}: ${confusionRow(mobile.dev)}
* ${mobile.test.name}: ${confusionRow(mobile.test)}
* ${full.test.name}: ${confusionRow(full.test)}

Truncated pairs: mobile dev ${mobile.dev.truncated}, mobile test ${mobile.test.truncated}; cold start ${mobile.coldStartMs?.toFixed(0)} ms; peak RSS ${Math.max(mobile.dev.rssPeakMb, mobile.test.rssPeakMb).toFixed(0)} MB (full: ${Math.max(full.dev.rssPeakMb, full.test.rssPeakMb).toFixed(0)} MB).

## Mobile vs non-mobile verdict agreement

* dev: ${mobileFullAgreement.dev.agree}/${mobileFullAgreement.dev.n} (${(mobileFullAgreement.dev.ratio * 100).toFixed(1)}%)
* test: ${mobileFullAgreement.test.agree}/${mobileFullAgreement.test.n} (${(mobileFullAgreement.test.ratio * 100).toFixed(1)}%)

Raw JSON and per-fixture outcomes: agent/judge-eval/.
`;
await writeFile(join(OUT_DIR, "SUMMARY.md"), summary);
console.log("\n" + summary);
