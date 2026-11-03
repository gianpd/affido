#!/usr/bin/env node
// Zero-shot classification experiment (host-run research script, never a
// sandbox/product path): score the RFC 0017 citation-coherence fixtures with
// the candidate zero-shot classifiers under the same modality —
//
//   systemone  Typesafe System One (Jev) hosted API, one typed choice question
//   d1         LiquidAI d1-2B-GGUF, a local lfm2-d1 *decision model* (no text
//              generation) served by llama.cpp's native /v1/systemone endpoint
//              — the same typed-choice request/response shape as the Typesafe
//              API
//   d1vllm     the same d1-2B decision model served by vLLM (llm-server repo)
//              through the OpenAI completions API: the adapter renders the
//              reference systemone prompt (prompt.py render: bos, state,
//              QUESTION:, A/B/C option lines, ChatML assistant turn with the
//              <think></think> lead) and reads the answer slot's next-token
//              logprobs, so the decision is still one forward pass with no
//              generation — llama.cpp replaced by vLLM, judge unchanged
//   d1or       LiquidAI d1.1, the hosted decision model on OpenRouter
//              (/api/alpha/decisions, model id liquid/d1.1): the same
//              typed-choice request/response shape as the systemone adapter,
//              zero local serving
//
// Same dataset (agent/scripts/judge-eval-fixtures.json), same state text
// (CLAIM:/EVIDENCE:), same frozen question, same truncation (truncatePair),
// same aggregation (multi lines: pass iff >=1 supported and 0 contradicted)
// and the same metrics (FA/FR, accuracy, macro-F1, per-class P/R/F1,
// per-language, confusion, latency).
//
// The GLiNER2.5-Decide arm was removed with the RFC 0018 runtime switch: the
// local ONNX artifact it measured is no longer shipped (see RFC 0017 §8 for
// the frozen outcomes). The remaining models get one neutral definition per
// label; the definitions describe the dataset's gold semantics, they do not
// leak pairs.
//
// Usage:
//   node agent/scripts/eval-zero-shot-judges.mjs [--models systemone,d1,d1vllm,d1or]
//        [--limit N] [--out dir] [--typesafe-env path/to/.env]
//        [--d1-url http://127.0.0.1:8080/v1]
//        [--d1-vllm-url http://127.0.0.1:8000/v1]
//        [--openrouter-env path/to/.env]
//
// Prerequisites (host only):
//   systemone  TYPESAFE_API_KEY (or --typesafe-env pointing at a .env with
//              TYPESAFE_KEY=...; the key is never printed or stored)
//   d1         a running llama-server with the GGUF at --d1-url, or set
//              LLAMA_SERVER_BIN + D1_GGUF and this script spawns/kills it
//   d1or       OPENROUTER_API_KEY (or --openrouter-env pointing at a .env
//              with OPENROUTER_API_KEY=...; optional D1_OR_MODEL, default
//              liquid/d1.1, and OPENROUTER_DECISIONS_URL; the key is never
//              printed or stored)
//
// Writes report.json + SUMMARY.md under agent/judge-eval/zero-shot-<ts>/.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { hostname, cpus, totalmem } from "node:os";
import { truncatePair } from "../citation-judge.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(HERE, "..", "..");
const DEFAULT_OUT_ROOT = join(ROOT, "agent", "judge-eval");

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const argOf = (flag) => {
	const at = argv.indexOf(flag);
	return at === -1 ? null : (argv[at + 1] ?? null);
};
const modelsWanted = (argOf("--models") ?? "systemone,d1").split(",").map((s) => s.trim());
const limit = argOf("--limit") !== null ? Number(argOf("--limit")) : null;
const typesafeEnvPath = argOf("--typesafe-env");
const d1Url = (argOf("--d1-url") ?? process.env.D1_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
const d1VllmUrl = (argOf("--d1-vllm-url") ?? process.env.D1_VLLM_BASE_URL ?? "http://127.0.0.1:8000/v1").replace(/\/+$/, "");
const openrouterEnvPath = argOf("--openrouter-env");
const outDir = argOf("--out") ?? join(DEFAULT_OUT_ROOT, `zero-shot-${new Date().toISOString().replace(/[:.]/g, "-")}`);

// ------------------------------------------------------------ shared modality
const QUESTION = "How does the evidence relate to the claim?";
const stateOf = (claim, quote) => `CLAIM:\n${claim}\n\nEVIDENCE:\n${quote}`;
const LABEL_DEFINITIONS = {
	supported: "the evidence states what the claim says; wording, numbers and dates may be written differently as long as the meaning is the same",
	unrelated: "the evidence is about a different clause or subject; it neither supports nor contradicts the claim",
	contradicted: "the evidence states the opposite of the claim, including by negation or by a different number, date or value",
};
const mapVerdict = (label) => (label === "unrelated" ? "unsupported" : label);

// ------------------------------------------------------------------ fixtures
const fixtures = JSON.parse(await readFile(join(HERE, "judge-eval-fixtures.json"), "utf8"));
const allPairs = fixtures.pairs;
const pick = (split) => {
	const set = allPairs.filter((p) => p.split === split);
	return limit === null ? set : set.slice(0, limit);
};
const dev = pick("dev");
const test = pick("test");

// ------------------------------------------------------------------ adapters
/** Minimal .env parser (KEY=VALUE lines, optional quotes). Never logs values. */
const parseEnvFile = async (path) => {
	const found = {};
	for (const line of (await readFile(path, "utf8")).split("\n")) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (match) found[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return found;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const systemOneAdapter = async () => {
	const envFile = typesafeEnvPath ? await parseEnvFile(typesafeEnvPath) : {};
	const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_KEY ?? envFile.TYPESAFE_API_KEY ?? envFile.TYPESAFE_KEY;
	if (!apiKey) throw new Error("systemone: no API key (set TYPESAFE_API_KEY or pass --typesafe-env with TYPESAFE_KEY)");
	const apiUrl = process.env.TYPESAFE_URL ?? envFile.TYPESAFE_URL ?? "https://api.typesafe.ai/v1/systemone";
	const model = process.env.JEV_MODEL ?? envFile.JEV_MODEL ?? "jev-latest";
	const questions = {
		relation: {
			type: "choice",
			instructions: `${QUESTION} Answer with exactly one label.`,
			criteria: LABEL_DEFINITIONS,
		},
	};
	const judge = async ({ claim, quote }) => {
		let lastError = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const response = await fetch(apiUrl, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({ state: stateOf(claim, quote), model, questions }),
					signal: AbortSignal.timeout(60_000),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
				const data = await response.json();
				const answer = data.answers?.relation;
				const label = answer?.choice;
				if (!label || !(label in LABEL_DEFINITIONS)) throw new Error(`unexpected choice ${JSON.stringify(label)}`);
				return {
					verdict: mapVerdict(label),
					score: Number(answer.confidence ?? answer.probabilities?.[label] ?? 0),
					probabilities: answer.probabilities ?? null,
				};
			} catch (error) {
				lastError = error;
				if (attempt < 3) await sleep(400 * attempt);
			}
		}
		throw new Error(`systemone: ${lastError?.message ?? "unreachable"}`);
	};
	return { id: "systemone", meta: { artifact: `Typesafe System One (${model})`, form: "typed choice question over the same state text", remote: true }, judge, close: async () => {} };
};

// d1 is a decision model: no chat prompt, no generation, no parsing. It is
// scored through llama.cpp's /v1/systemone with the same typed-choice payload
// as the systemone adapter (see d1Adapter).

const d1Adapter = async () => {
	let server = null;
	let base = d1Url;
	if (process.env.LLAMA_SERVER_BIN && process.env.D1_GGUF) {
		const port = Number(new URL(base).port || 8080);
		const extra = (process.env.D1_EXTRA_ARGS ?? "").split(" ").filter(Boolean);
		server = spawn(process.env.LLAMA_SERVER_BIN, ["-m", process.env.D1_GGUF, "--host", "127.0.0.1", "--port", String(port), "-ngl", "99", "-c", "8192", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
		const log = [];
		server.stdout.on("data", (d) => log.push(d.toString()));
		server.stderr.on("data", (d) => log.push(d.toString()));
		console.log(`d1: spawning llama-server (pid ${server.pid}) …`);
		const health = new URL(`http://127.0.0.1:${port}/health`);
		for (let i = 0; i < 240; i++) {
			try {
				const probe = await fetch(health, { signal: AbortSignal.timeout(2000) });
				if (probe.ok) break;
			} catch {
				/* not up yet */
			}
			if (server.exitCode !== null) throw new Error(`llama-server exited (${server.exitCode}):\n${log.join("").split("\n").slice(-15).join("\n")}`);
			await sleep(1000);
			if (i === 239) throw new Error(`llama-server not healthy after 240 s:\n${log.join("").split("\n").slice(-15).join("\n")}`);
		}
	}
	// Model id from the server itself when available.
	let modelId = process.env.D1_MODEL ?? "d1-2B";
	try {
		const listed = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
		const first = listed?.data?.[0]?.id;
		if (first && !process.env.D1_MODEL) modelId = first;
	} catch {
		/* keep default */
	}
	// Same typed-choice question as systemone: d1 is a decision model with no
	// text generation, scored through llama.cpp's /v1/systemone.
	const questions = {
		relation: {
			type: "choice",
			instructions: `${QUESTION} Answer with exactly one label.`,
			criteria: LABEL_DEFINITIONS,
		},
	};
	const judge = async ({ claim, quote }) => {
		const response = await fetch(`${base}/systemone`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ state: stateOf(claim, quote), model: modelId, questions }),
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
		const data = await response.json();
		const answer = data.answers?.relation;
		const label = answer?.choice;
		if (!label || !(label in LABEL_DEFINITIONS)) throw new Error(`unexpected choice ${JSON.stringify(label)}`);
		return {
			verdict: mapVerdict(label),
			score: Number(answer.confidence ?? answer.probabilities?.[label] ?? 0),
			probabilities: answer.probabilities ?? null,
		};
	};
	return {
		id: "d1",
		meta: { artifact: `LiquidAI d1-2B-GGUF (lfm2-d1 decision model) via llama.cpp ${base}`, form: "typed choice question over the same state text (native /v1/systemone), calibrated softmax" },
		judge,
		close: async () => {
			if (server && server.exitCode === null) {
				server.kill("SIGTERM");
				await sleep(1500);
				if (server.exitCode === null) server.kill("SIGKILL");
			}
		},
	};
};

// The same d1-2B decision model as the d1 adapter, served by vLLM instead of
// llama.cpp. vLLM has no /v1/systemone endpoint, so the adapter reproduces the
// reference serving contract on the OpenAI completions API:
//
//   - the prompt is the exact render() of LiquidAI's prompt.py for one choice
//     question over a text state (defaults: no system turn, json_only state,
//     option_style "desc", the lfm3 lead "<think></think>"), which is also the
//     prompt behind the GGUF's tokenizer.chat_template.systemone that llama.cpp
//     serves — same tokens either way;
//   - the answer slot for a single-choice question is the next token after the
//     lead (suffix_layout returns slot 0), so max_tokens=1 + logprobs reads it;
//   - the readout follows prompt.py: each option scores the best of its code
//     forms ("A" and " A"), the scores go through the served calibration
//     temperature (calibration.json default 1.3374; scales probabilities, never
//     the argmax) and softmax over the options gives the answer.
const D1_VLLM_LOGPROBS = 100; // enough to hold every A/B/C form of three options
const d1VllmAdapter = async () => {
	let model = process.env.D1_VLLM_MODEL ?? null;
	if (!model) {
		const listed = await fetch(`${d1VllmUrl}/models`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
		model = listed?.data?.[0]?.id;
		if (!model) throw new Error(`d1vllm: no models listed at ${d1VllmUrl}/models — is the server up?`);
	}
	const imStart = "<|im_start|>";
	const imEnd = "<|im_end|>";
	const bos = "<|startoftext|>";
	const lead = "<think></think>";
	const optionCodes = ["A", "B", "C"];
	const labels = Object.keys(LABEL_DEFINITIONS); // supported, unrelated, contradicted — criteria order
	const calibrationTemperature = 1.337398453966105; // calibration.json "default" (temperatures holds no choice:small entry)
	const instructions = `${QUESTION} Answer with exactly one label.`;
	const optionLines = labels.map((label, i) => `${optionCodes[i]} ${LABEL_DEFINITIONS[label]}`).join("\n");
	// prompt.py prefix_text + suffix_layout for one Choice question, no media.
	const promptOf = ({ claim, quote }) =>
		`${bos}${imStart}user\n${stateOf(claim, quote)}\n\n\nQUESTION:\n${instructions}\n\nOptions:\n${optionLines}\n\nReply with the option code only.${imEnd}\n${imStart}assistant\n${lead}`;
	const judge = async (pair) => {
		let lastError = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const response = await fetch(`${d1VllmUrl}/completions`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model,
						prompt: promptOf(pair),
						max_tokens: 1,
						logprobs: D1_VLLM_LOGPROBS,
						temperature: 0,
					}),
					signal: AbortSignal.timeout(60_000),
					});
				if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
				const data = await response.json();
				const top = data.choices?.[0]?.logprobs?.top_logprobs?.[0];
				if (!top) throw new Error("no top_logprobs at the answer slot");
				const logprobOf = (form) => {
					const entry = top[form];
					return entry === undefined ? null : Number(typeof entry === "number" ? entry : entry.logprob);
				};
				const floor = Math.min(...Object.values(top).map((e) => Number(typeof e === "number" ? e : e.logprob)));
				const scores = optionCodes.map((code) => Math.max(logprobOf(code) ?? floor, logprobOf(` ${code}`) ?? floor));
				const tempered = scores.map((s) => s / calibrationTemperature);
				const topScore = Math.max(...tempered);
				const exps = tempered.map((s) => Math.exp(s - topScore));
				const total = exps.reduce((a, b) => a + b, 0);
				const probabilities = Object.fromEntries(labels.map((label, i) => [label, exps[i] / total]));
				const picked = tempered.indexOf(topScore);
				const label = labels[picked];
				return { verdict: mapVerdict(label), score: probabilities[label], probabilities };
			} catch (error) {
				lastError = error;
				if (attempt < 3) await sleep(400 * attempt);
			}
		}
		throw new Error(`d1vllm: ${lastError?.message ?? "unreachable"}`);
	};
	return {
		id: "d1vllm",
		meta: { artifact: `LiquidAI d1-2B (bf16) served by vLLM at ${d1VllmUrl} (llm-server repo)`, form: "reference systemone prompt (prompt.py render) on the OpenAI completions API; one forward pass, answer-slot logprobs, tempered softmax over the option codes" },
		judge,
		close: async () => {},
	};
};

// d1.1 on OpenRouter is the same product shape as the Typesafe API: a hosted
// decision model behind one typed-choice endpoint. The adapter mirrors
// systemOneAdapter (same state text, same question, same retries) against
// https://openrouter.ai/api/alpha/decisions.
const d1OpenRouterAdapter = async () => {
	const envFile = openrouterEnvPath ? await parseEnvFile(openrouterEnvPath) : {};
	const apiKey = process.env.OPENROUTER_API_KEY ?? envFile.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("d1or: no API key (set OPENROUTER_API_KEY or pass --openrouter-env with OPENROUTER_API_KEY)");
	const apiUrl = (process.env.OPENROUTER_DECISIONS_URL ?? envFile.OPENROUTER_DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions").replace(/\/+$/, "");
	const model = process.env.D1_OR_MODEL ?? envFile.D1_OR_MODEL ?? "liquid/d1.1";
	const questions = {
		relation: {
			type: "choice",
			instructions: `${QUESTION} Answer with exactly one label.`,
			criteria: LABEL_DEFINITIONS,
		},
	};
	let servedModel = null;
	const judge = async ({ claim, quote }) => {
		let lastError = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const response = await fetch(apiUrl, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({ model, state: stateOf(claim, quote), questions }),
					signal: AbortSignal.timeout(60_000),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
				const data = await response.json();
				if (data.model) meta.served = data.model;
				const answer = data.answers?.relation;
				const label = answer?.choice;
				if (!label || !(label in LABEL_DEFINITIONS)) throw new Error(`unexpected choice ${JSON.stringify(label)}`);
				return {
					verdict: mapVerdict(label),
					score: Number(answer.confidence ?? answer.probabilities?.[label] ?? 0),
					probabilities: answer.probabilities ?? null,
				};
			} catch (error) {
				lastError = error;
				if (attempt < 3) await sleep(400 * attempt);
			}
		}
		throw new Error(`d1or: ${lastError?.message ?? "unreachable"}`);
	};
	const meta = { artifact: `${model} (LiquidAI d1.1 decision model) via OpenRouter ${apiUrl}`, form: "typed choice question over the same state text (decisions endpoint), served calibration", remote: true, served: null };
	return { id: "d1or", meta, judge, close: async () => {} };
};

// ------------------------------------------------------------------- metrics
// Same helpers as eval-citation-judge.mjs (kept duplicated on purpose: this is
// a research script; the RFC-pinned eval stays untouched).
const confusion = (results) => {
	const matrix = {};
	for (const result of results) {
		const row = (matrix[result.label] ??= {});
		row[result.outcome] = (row[result.outcome] ?? 0) + 1;
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
const goldOf = (label) => (label === "unrelated" ? "unsupported" : label);
const CLASSES = ["supported", "unsupported", "contradicted"];
const classificationMetrics = (results) => {
	const matrix = Object.fromEntries(CLASSES.map((c) => [c, Object.fromEntries(CLASSES.map((p) => [p, 0]))]));
	for (const result of results) if (CLASSES.includes(result.outcome)) matrix[goldOf(result.label)][result.outcome] += 1;
	const total = results.length;
	const correct = CLASSES.reduce((sum, c) => sum + matrix[c][c], 0);
	const perClass = {};
	const f1s = [];
	for (const c of CLASSES) {
		const tp = matrix[c][c];
		const fp = CLASSES.reduce((sum, o) => sum + matrix[o][c], 0) - tp;
		const fn = CLASSES.reduce((sum, p) => sum + matrix[c][p], 0) - tp;
		const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
		const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
		const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
		perClass[c] = { precision, recall, f1 };
		f1s.push(f1);
	}
	return { n: total, accuracy: total === 0 ? 0 : correct / total, macroF1: f1s.reduce((a, b) => a + b, 0) / f1s.length, perClass };
};
const percentile = (sorted, fraction) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
const summarize = (name, results, latencies, truncatedCount) => ({
	name,
	n: results.length,
	confusion: confusion(results),
	classification: classificationMetrics(results),
	...rates(results),
	perLanguage: ["en", "it"].map((lang) => {
		const subset = results.filter((r) => r.lang === lang);
		return { lang, ...rates(subset), confusion: confusion(subset) };
	}),
	unparsed: results.filter((r) => r.outcome === "unparsed").length,
	truncated: truncatedCount,
	latencyMs: { p50: percentile([...latencies].sort((a, b) => a - b), 0.5), p95: percentile([...latencies].sort((a, b) => a - b), 0.95) },
});

/** Same aggregation as the RFC 0017 layer: pass iff >=1 supported and no
 * contradicted across the line's ids. */
const judgeFixture = async (adapter, pair) => {
	const quotes = pair.kind === "multi" ? pair.quotes : [pair.quote];
	const started = performance.now();
	let supported = false;
	let contradiction = null;
	const verdicts = [];
	let truncated = false;
	for (const quote of quotes) {
		const prepared = truncatePair(pair.claim, quote);
		truncated ||= prepared.truncated;
		const verdict = await adapter.judge({ claim: prepared.claim, quote: prepared.quote });
		verdicts.push(verdict);
		if (verdict.verdict === "supported") supported = true;
		if (verdict.verdict === "contradicted" && contradiction === null) contradiction = verdict;
	}
	const outcome = contradiction !== null ? "contradicted" : supported ? "supported" : verdicts.every((v) => v.verdict === "unparsed") ? "unparsed" : "unsupported";
	return { outcome, verdicts, truncated, ms: performance.now() - started };
};

// ---------------------------------------------------------------------- run
console.log(`zero-shot judge experiment — fixtures ${allPairs.length} (dev ${dev.length}, test ${test.length}); models: ${modelsWanted.join(", ")}${limit !== null ? `; limit ${limit}/split` : ""}`);

const report = {
	date: new Date().toISOString(),
	machine: { hostname: hostname(), cpus: cpus().length, totalmemMb: Math.round(totalmem / 1048576), node: process.version },
	dataset: { file: "agent/scripts/judge-eval-fixtures.json", total: allPairs.length, dev: dev.length, test: test.length, limitPerSplit: limit },
	modality: { question: QUESTION, stateFormat: "CLAIM:\\n<claim>\\n\\nEVIDENCE:\\n<quote>", labelDefinitions: LABEL_DEFINITIONS, alignment: "gold unrelated == verdict unsupported; unparsed counts as a reject (never supported)" },
	models: {},
};

for (const id of modelsWanted) {
	const adapter = id === "systemone" ? await systemOneAdapter() : id === "d1" ? await d1Adapter() : id === "d1vllm" ? await d1VllmAdapter() : id === "d1or" ? await d1OpenRouterAdapter() : null;
	if (!adapter) throw new Error(`unknown model id ${id}`);
	console.log(`\n=== ${id} (${adapter.meta.artifact}) ===`);
	try {
		const runSplit = async (split, set) => {
			const results = [];
			const latencies = [];
			let truncated = 0;
			for (const pair of set) {
				const outcome = await judgeFixture(adapter, pair);
				latencies.push(outcome.ms);
				if (outcome.truncated) truncated += 1;
				results.push({ id: pair.id, lang: pair.lang, label: pair.label, outcome: outcome.outcome, verdicts: outcome.verdicts, truncated: outcome.truncated, ms: outcome.ms });
				process.stdout.write(`  ${split} ${results.length}/${set.length}: ${pair.id} gold=${pair.label} -> ${outcome.outcome} (${outcome.ms.toFixed(0)} ms)\r\n`);
			}
			return { split, ...summarize(`${id}/${split}`, results, latencies, truncated), results };
		};
		const devRun = await runSplit("dev", dev);
		const testRun = await runSplit("test", test);
		report.models[id] = { meta: adapter.meta, dev: devRun, test: testRun };
	} finally {
		await adapter.close();
	}
}

// ------------------------------------------------------------------- output
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 1));

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
const tableRow = (id, run) => `| ${id}/${run.name.split("/")[1] ?? run.split} | ${run.n} | ${run.classification.accuracy.toFixed(2)} | ${run.classification.macroF1.toFixed(2)} | ${pct(run.falseAcceptRate)} (${run.falseAccepts}/${run.nonSupported}) | ${pct(run.falseRejectRate)} (${run.falseRejects}/${run.supported}) | ${run.latencyMs.p50.toFixed(0)}/${run.latencyMs.p95.toFixed(0)} | ${run.unparsed} |`;

let summary = `# Zero-shot judge experiment — ${report.date}

Dataset: RFC 0017 fixtures (${report.dataset.total} pairs, dev ${report.dataset.dev} / test ${report.dataset.test}${limit !== null ? `, limited to ${limit} per split` : ""}). Same state text, question, truncation and aggregation for every model, one neutral label definition each (d1 is an lfm2-d1 decision model scored through llama.cpp's /v1/systemone, d1or is the hosted d1.1 on OpenRouter's decisions endpoint, both the same typed-choice shape as systemone). Alignment: gold unrelated == unsupported.
Bar for reference (RFC 0017): FA cut >= 60%, FR on supported <= 10%.

| Model/split | n | Acc | Macro-F1 | FA | FR | p50/p95 ms | unparsed |
|---|---|---|---|---|---|---|---|
`;
for (const [id, model] of Object.entries(report.models)) {
	summary += `${tableRow(id, model.dev)}\n${tableRow(id, model.test)}\n`;
}
summary += `\n`;
for (const [id, model] of Object.entries(report.models)) {
	summary += `## ${id} — ${model.meta.artifact}\n\nForm: ${model.meta.form}\n\n`;
	for (const run of [model.dev, model.test]) {
		const it = run.perLanguage.find((l) => l.lang === "it");
		summary += `### ${run.name} (n=${run.n})\n\n* confusion (gold -> outcome): \`${JSON.stringify(run.confusion)}\`\n* Italian subset: FA ${pct(it?.falseAcceptRate ?? null)} (${it?.falseAccepts ?? 0}/${it?.nonSupported ?? 0}), FR ${pct(it?.falseRejectRate ?? null)} (${it?.falseRejects ?? 0}/${it?.supported ?? 0})\n* supported P/R/F1: ${run.classification.perClass.supported.precision.toFixed(2)}/${run.classification.perClass.supported.recall.toFixed(2)}/${run.classification.perClass.supported.f1.toFixed(2)}; truncated pairs ${run.truncated}\n* errors (gold != outcome):\n`;
		for (const result of run.results.filter((r) => r.outcome !== r.label)) {
			const pair = allPairs.find((p) => p.id === result.id);
			const quote = pair.kind === "multi" ? pair.quotes.join(" | ") : pair.quote;
			summary += `  * ${result.id} [${result.lang}] gold=${result.label} -> ${result.outcome}: "${pair.claim}" vs "${quote.slice(0, 140)}${quote.length > 140 ? "…" : ""}"\n`;
		}
		summary += `\n`;
	}
}
summary += `Raw per-fixture outcomes: ${join(outDir, "report.json")}\n`;
await writeFile(join(outDir, "SUMMARY.md"), summary);
console.log(`\n${summary}\nresults: ${outDir}`);
