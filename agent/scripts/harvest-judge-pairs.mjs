#!/usr/bin/env node
// RFC 0020 §6 V7: harvest (claim, quote) pairs from real runs and measure the
// judge against them. Host-run operator tool, never a sandbox path; the RFC
// 0017 fixtures cannot justify a confidence floor because d1.1 answers them
// perfectly — this is the instrument that can.
//
//   sample   read every stored citation run of a COPIED session DB, rebuild
//            the (claim, quote) pairs of the attempt that published (or the
//            last attempt), and emit a labeling worksheet as JSONL
//   score    read the labeled worksheet back, report accuracy per confidence
//            bin, expected calibration error (ECE), FA/FR, and the measured
//            latency percentiles with the CITATION_JUDGE_PAIR_TIMEOUT_MS they
//            imply
//
// Usage:
//   node agent/scripts/harvest-judge-pairs.mjs sample --db /tmp/session.sqlite --out /tmp/pairs.jsonl [--limit 500]
//   node agent/scripts/harvest-judge-pairs.mjs score --labeled /tmp/pairs-labeled.jsonl
//
// The worksheet's `gold` field is filled by hand with one of
// supported | unrelated | contradicted (the wire labels; `unsupported` maps
// from `unrelated`). Only the published attempt is harvested: earlier attempts
// judge a markdown the run no longer stores. Latency uses non-cached pairs
// only (cached ones answer in 0 ms by construction). Artifacts are untracked
// (agent/judge-harvest/ is gitignored).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { judgedLines, truncatePair } from "../citation-judge.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const arg = (name) => {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
};

const runDocs = async (dbPath) => {
	// Through the storage API, not raw SQL: a document's latest value is a
	// base-plus-deltas chain only the library can materialize.
	const storage = await openNodeSqliteStorage(resolve(dbPath));
	const docs = [];
	try {
		const conversations = await storage.scanConversations({}, 1_000, undefined, BACKGROUND_CONTEXT);
		for (const conversation of conversations.items) {
			const page = await storage.scanDocuments(
				{ scope: { kind: "conversation", conversationId: conversation.id }, at: "current", kind: "citations.run" },
				1_000,
				undefined,
				BACKGROUND_CONTEXT,
			);
			for (const record of page.items) {
				const stored = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
				if (stored !== undefined) docs.push({ runId: String(record.key ?? ""), state: stored.value });
			}
		}
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
	return docs;
};

const LABELS = ["supported", "unrelated", "contradicted"];

const sampleMode = async () => {
	const db = arg("db");
	const out = arg("out") ?? join(HERE, "..", "judge-harvest", "pairs.jsonl");
	const limit = Number(arg("limit") ?? 500);
	if (db === undefined) throw new Error("sample requires --db <session.sqlite> (a copy; the file is opened read-only)");
	const rows = [];
	for (const { runId, state } of await runDocs(db)) {
		const judge = state.judge;
		if (judge === null || judge === undefined || !Array.isArray(judge.attempts)) continue; // no judge, or a legacy flat run (RFC 0020 §4.1 reading rule: not harvestable per attempt)
		const attempt = judge.attempts.find((record) => record.outcome === "published") ?? judge.attempts.at(-1);
		if (attempt === undefined || state.published === null) continue;
		const markdown = state.published.markdown;
		const byKey = new Map(attempt.verdicts.map((record) => [`${record.line}|${record.citationId}`, record]));
		for (const judged of judgedLines(markdown)) {
			for (const citationId of judged.citationIds) {
				const annotation = state.annotations?.[citationId];
				if (annotation === undefined) continue;
				const pair = truncatePair(judged.claim, annotation.quote);
				const verdict = byKey.get(`${judged.line}|${citationId}`);
				if (verdict === undefined) continue;
				rows.push({
					runId,
					attempt: attempt.attempt,
					line: judged.line,
					citationId,
					claim: pair.claim,
					quote: pair.quote,
					truncated: pair.truncated,
					verdict: verdict.verdict,
					score: verdict.score,
					probabilities: verdict.probabilities ?? null,
					margin: verdict.margin ?? null,
					cached: verdict.cached === true,
					ms: verdict.ms,
					gold: null,
				});
			}
		}
		if (rows.length >= limit) break;
	}
	await mkdir(dirname(resolve(out)), { recursive: true });
	await writeFile(resolve(out), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	console.log(`harvested ${rows.length} pairs from ${db} -> ${out}`);
	console.log("fill each row's `gold` with supported | unrelated | contradicted, then run score --labeled");
};

const percentile = (sorted, fraction) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);

const scoreMode = async () => {
	const labeled = arg("labeled");
	if (labeled === undefined) throw new Error("score requires --labeled <pairs.jsonl>");
	const rows = (await readFile(resolve(labeled), "utf8"))
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line))
		.filter((row) => row.gold !== null && row.gold !== "" && LABELS.includes(row.gold));
	if (rows.length === 0) throw new Error("no labeled rows: fill `gold` with supported | unrelated | contradicted");

	const correct = (row) => (row.verdict === "unsupported" ? "unrelated" : row.verdict) === row.gold;
	const bins = Array.from({ length: 10 }, (_, index) => ({ low: index / 10, high: (index + 1) / 10, n: 0, hits: 0, conf: 0 }));
	for (const row of rows) {
		const bin = bins[Math.min(9, Math.max(0, Math.floor(row.score * 10)))];
		bin.n += 1;
		bin.hits += correct(row) ? 1 : 0;
		bin.conf += row.score;
	}
	let ece = 0;
	for (const bin of bins) {
		if (bin.n === 0) continue;
		const accuracy = bin.hits / bin.n;
		const confidence = bin.conf / bin.n;
		ece += (bin.n / rows.length) * Math.abs(accuracy - confidence);
	}
	const falseAccepts = rows.filter((row) => row.gold !== "supported" && row.verdict === "supported").length;
	const falseRejects = rows.filter((row) => row.gold === "supported" && row.verdict !== "supported").length;
	const accuracy = rows.filter(correct).length / rows.length;
	const latencies = rows.filter((row) => row.cached !== true && typeof row.ms === "number").map((row) => row.ms).sort((a, b) => a - b);
	const p999 = percentile(latencies, 0.999);
	const suggested = Math.ceil((p999 * 1.25) / 500) * 500;

	const lines = [
		`pairs labeled: ${rows.length} (of which judged fresh: ${latencies.length})`,
		`accuracy: ${(accuracy * 100).toFixed(1)}%`,
		`false accepts (gold not supported, judged supported): ${falseAccepts} (${((falseAccepts / rows.length) * 100).toFixed(1)}%)`,
		`false rejects (gold supported, judged otherwise): ${falseRejects} (${((falseRejects / rows.length) * 100).toFixed(1)}%)`,
		`expected calibration error over endpoint confidence: ${ece.toFixed(3)}`,
		"accuracy per confidence bin:",
		...bins
			.filter((bin) => bin.n > 0)
			.map((bin) => `  [${bin.low.toFixed(1)}, ${bin.high.toFixed(1)}) n=${bin.n} acc=${(bin.hits / bin.n).toFixed(2)} avg conf=${(bin.conf / bin.n).toFixed(2)}`),
	];
	if (latencies.length > 0) {
		lines.push(
			`latency p50 ${percentile(latencies, 0.5).toFixed(0)} ms · p95 ${percentile(latencies, 0.95).toFixed(0)} ms · p99 ${percentile(latencies, 0.99).toFixed(0)} ms · p99.9 ${p999.toFixed(0)} ms`,
			`suggested CITATION_JUDGE_PAIR_TIMEOUT_MS (p99.9 + 25%, rounded up to 500): ${suggested}`,
		);
	}
	const text = `${lines.join("\n")}\n`;
	console.log(text);
	const outDir = join(HERE, "..", "judge-harvest");
	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, `score-${Date.now()}.txt`), text);
};

const mode = process.argv[2];
if (mode === "sample") await sampleMode();
else if (mode === "score") await scoreMode();
else {
	console.error("usage: harvest-judge-pairs.mjs sample --db <session.sqlite> --out <pairs.jsonl> [--limit N]\n       harvest-judge-pairs.mjs score --labeled <labeled.jsonl>");
	process.exit(1);
}
