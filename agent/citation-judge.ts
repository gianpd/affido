// The post-gate coherence judge of RFC 0017, with the audit-grade record
// keeping of RFC 0020: a probabilistic layer that runs after the deterministic
// gate of RFC 0006 §5.4 accepted a publish, and asks one question per (line,
// citation) pair: is the claim the model wrote coherent with the quote behind
// its [cit_...] id?
//
// The port is one method. The gate and the tools depend on `CitationJudge`
// only; the runtime lives behind `Judge` (`judge.ts`) on pi-ai's classifier
// contract, its model binding in `judge-model.ts`, and tests drive a fake.
//
// RFC 0020 changed the record keeping, not the decision: the labels, the
// frozen question and the per-line aggregation rule (`supported` passes,
// `contradicted` vetoes, a line with no answer fails closed under `enforce`)
// are exactly RFC 0017's.

import { createHash } from "node:crypto";
import { JUDGE_QUESTION_VERSION } from "./judge.ts";

/** One coherence verdict over a (claim, quote) pair. `verdict` is the judge's
 * decision; `score` is the endpoint's confidence in that decision (0..1),
 * which is not the label probability (RFC 0020 R5). `probabilities`, when the
 * runtime provides them, is the full label distribution. */
export type JudgeVerdict = {
	readonly verdict: "supported" | "unsupported" | "contradicted";
	readonly score: number;
	readonly probabilities?: { readonly supported: number; readonly unrelated: number; readonly contradicted: number };
};

/** The port. Input is state the run already stored: the published line with
 * tokens stripped (the claim) and the annotation's exact quote. Implementations
 * must not read the corpus and must not re-locate any span. */
export interface CitationJudge {
	judge(input: { readonly claim: string; readonly quote: string }): Promise<JudgeVerdict>;
	/** RFC 0018: whether the runtime can currently judge at all. Absent means
	 * always available (`ScriptedJudge`); `Judge` answers from its target
	 * resolver. A judge that is not available is *absent*, not
	 * erroring: the publish path skips the layer, so `enforce` never rejects
	 * a publish merely because no credential backs the judge. A judge that is
	 * available and then fails still rejects under `enforce` (the attempt's
	 * outcome becomes `judge_error_unverified`). */
	available?(): Promise<boolean>;
	/** RFC 0020 §4.4: the model id behind the next call, part of the verdict
	 * cache key so a model switch invalidates cached verdicts. Absent means
	 * "not model-addressed" (the scripted fake). */
	modelId?(): Promise<string | null>;
}

/** RFC 0017 §3: the deployment mode of the coherence check.
 * - `off` (default): the layer is absent; behavior is exactly RFC 0006.
 * - `warn`: verdicts, latencies and truncations are recorded, never a rejection.
 * - `enforce`: an incoherent line rejects the publish with `incoherent_citation`. */
export type JudgeMode = "off" | "warn" | "enforce";

/** A claim or quote longer than this many characters is cut before judging
 * (RFC 0017 §4.3): the 512-token budget is shared by the question, the labels
 * and both fields, so both are capped separately, the quote at a sentence
 * boundary, and every cut pair is counted as truncated. */
export const CLAIM_CAP_CHARS = 600;
export const QUOTE_CAP_CHARS = 1400;

/** RFC 0020 §4.2: every judge failure carries a named cause. The binding's
 * distinguishable messages (`decisions endpoint HTTP 429: …`, timeout
 * aborts, `judge returned an unexpected answer`) map onto these; nothing but
 * the message and the elapsed time is stored — never a key, URL or body. */
export type JudgeErrorCause = "timeout" | "transport" | "http_4xx" | "http_5xx" | "protocol" | "aborted";

export type JudgeErrorRecord = {
	readonly line: number;
	readonly citationId: string;
	readonly cause: JudgeErrorCause;
	readonly ms: number;
	/** The binding's own error text, capped at 200 characters. */
	readonly message: string;
};

/** RFC 0020 §4.1: what happened to one publish attempt that reached the judge. */
export type JudgeOutcome = "published" | "incoherent_citation" | "judge_error_unverified" | "judge_budget_exhausted";

/** One (line, citation) pair the layer judged, as stored in the attempt.
 * `score` keeps its RFC 0017 meaning — the endpoint's confidence — because old
 * records carry it; new consumers that need the label probability read
 * `probabilities` (R5: one real call had confidence 0.3768 with
 * probabilities.supported 0.5845). `margin` is the line's best supported score
 * minus its best non-supported score, written on every record of a passing
 * line (RFC 0020 §4.5). */
export type JudgePairRecord = {
	/** 1-based line of the attempt's published markdown. */
	readonly line: number;
	readonly citationId: string;
	readonly verdict: JudgeVerdict["verdict"];
	readonly score: number;
	readonly ms: number;
	readonly truncated: boolean;
	readonly probabilities?: JudgeVerdict["probabilities"];
	readonly endpointConfidence?: number;
	readonly margin?: number;
	/** RFC 0020 §4.4: served from the run's verdict cache, `ms: 0`, never re-called. */
	readonly cached?: boolean;
};

/** RFC 0020 §4.1: one record per publish attempt that reached the judge,
 * including one that answered no pair at all. */
export type JudgeAttemptRecord = {
	/** 1-based publish attempt of this run (gate-rejected attempts count too). */
	readonly attempt: number;
	/** Epoch ms the judgement started. */
	readonly at: number;
	/** Judged (cited, non-heading) lines in this attempt's markdown. */
	readonly lines: number;
	verdicts: JudgePairRecord[];
	errors: JudgeErrorRecord[];
	readonly truncated: number;
	readonly outcome: JudgeOutcome;
	readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number } | null;
	/** A pre-RFC-0020 flat judge state folded into one attempt by the reader
	 * (§4.1 reading rule) or by the first post-upgrade write. */
	readonly legacy?: true;
};

/** RFC 0020 §4.4: a verdict worth re-serving, per run. Truncation is not
 * cached: the key is the truncated pair, so the flag is a function of the
 * pair and is recomputed on every hit. */
export type CachedVerdict = {
	readonly verdict: JudgeVerdict["verdict"];
	readonly score: number;
	readonly probabilities?: JudgeVerdict["probabilities"];
};

export type JudgeCache = {
	readonly get: (key: string) => CachedVerdict | undefined;
	readonly put: (key: string, verdict: CachedVerdict) => void;
};

export const judgeCacheKey = (claim: string, quote: string, modelId: string, questionVersion: number): string =>
	`j_${createHash("sha256").update(`${claim}\u241f${quote}\u241f${modelId}\u241f${questionVersion}`).digest("hex").slice(0, 24)}`;

/** The published line as a claim: `[cit_...]` tokens (and their bracket group)
 * removed, whitespace collapsed. The claim is what the judge reads, never the
 * raw markdown line. */
export const claimOf = (line: string): string =>
	line
		.replace(/\[[^\[\]\n]*cit_[0-9a-f]{6,}[^\[\]\n]*\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Sentences of a quote, for the sentence-boundary cut. ASCII and Italian
 * terminal punctuation; no abbreviations table — a mid-cut is still valid
 * input, the boundary only avoids slicing a clause in half. */
const sentencesOf = (text: string): string[] => text.match(/[^.!?;]+[.!?;]*\s*/g) ?? [text];

export type Truncation = { readonly claim: string; readonly quote: string; readonly truncated: boolean };

/** Cap claim and quote separately. The claim keeps its head; the quote keeps
 * whole sentences, preferring the one that overlaps the claim most (the
 * sentence that carries the annotation match), then extends forward. */
export const truncatePair = (claim: string, quote: string): Truncation => {
	const cutClaim = [...claim].slice(0, CLAIM_CAP_CHARS).join("").trim();
	let truncated = cutClaim.length < claim.trim().length;
	let working = quote.trim();
	if (working.length > QUOTE_CAP_CHARS) {
		truncated = true;
		const sentences = sentencesOf(working);
		const claimWords = new Set(cutClaim.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
		let best = 0;
		let bestScore = -1;
		sentences.forEach((sentence, index) => {
			const overlap = ([...sentence.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)]).filter((match) =>
				claimWords.has(match[0]),
			).length;
			if (overlap > bestScore) {
				bestScore = overlap;
				best = index;
			}
		});
		let kept = sentences[best] ?? working.slice(0, QUOTE_CAP_CHARS);
		let index = best + 1;
		while (kept.length < QUOTE_CAP_CHARS && index < sentences.length) {
			kept += sentences[index] ?? "";
			index++;
		}
		working = [...kept].slice(0, QUOTE_CAP_CHARS).join("").trim();
	}
	return { claim: cutClaim, quote: working, truncated };
};

/** One judged line: the claim and the ids the deterministic gate saw on it. */
export type JudgedLine = {
	readonly line: number;
	readonly raw: string;
	readonly claim: string;
	readonly citationIds: readonly string[];
};

/** Every citation id token on the line, grouped tokens included (the same
 * scan the deterministic gate uses). */
const lineTokens = (line: string): string[] => {
	const tokens: string[] = [];
	for (const group of line.matchAll(/\[([^\[\]\n]*)\]/g)) {
		for (const token of group[1]?.matchAll(/cit_[0-9a-f]{6,}/g) ?? []) {
			if (!tokens.includes(token[0])) tokens.push(token[0]);
		}
	}
	return tokens;
};

/** The non-heading, non-blank lines of a publish, with their claim and ids —
 * the same line set the deterministic gate's `uncited_line` check walks. */
export const judgedLines = (markdown: string): readonly JudgedLine[] => {
	const lines: JudgedLine[] = [];
	markdown.split("\n").forEach((raw, index) => {
		const trimmed = raw.trim();
		if (trimmed === "" || trimmed.startsWith("#")) return;
		const citationIds = lineTokens(trimmed);
		if (citationIds.length === 0) return; // the deterministic gate already rejected it
		lines.push({ line: index + 1, raw: trimmed, claim: claimOf(trimmed), citationIds });
	});
	return lines;
};

// ── RFC 0020 §4.3: the derived budget ────────────────────────────────────────

/** The retry ladder inside the per-pair envelope. It lives here, beside the
 * envelope it must fit in, because the motivating defect (R3) was the two
 * drifting apart: the binding consumed these as its own hand-set constants
 * while the outer timeout was set elsewhere. `judge-model.ts` imports them. */
export const JUDGE_LADDER = { attempts: 2, backoffMs: 300 } as const;

export type JudgeBudget = {
	/** Per-pair deadline: the envelope. Covers the measured 5.65 s cold path
	 * absorbed by attempt 1 plus one warm retry (§4.3). */
	readonly pairDeadlineMs: number;
	/** Per-attempt deadline inside the binding's retry ladder, derived so the
	 * ladder can never exceed the envelope. */
	readonly attemptDeadlineMs: number;
	/** Pairs in flight; results stay in line order regardless of settle order. */
	readonly concurrency: number;
	/** Wall clock shared by every attempt of one run. */
	readonly runBudgetMs: number;
};

const positiveIntEnv = (env: Record<string, string | undefined>, name: string, fallback: number): number => {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
	}
	return value;
};

/** The one invariant of §4.3: the ladder fits inside the envelope. Pure, so a
 * unit test can check defaults and overrides and a violating value can throw
 * at module load (and therefore at container boot). */
export const budgetInvariantHolds = (budget: JudgeBudget): boolean =>
	JUDGE_LADDER.attempts * budget.attemptDeadlineMs + JUDGE_LADDER.backoffMs <= budget.pairDeadlineMs &&
	budget.attemptDeadlineMs > 0;

export const deriveJudgeBudget = (env: Record<string, string | undefined>): JudgeBudget => {
	const pairDeadlineMs = positiveIntEnv(env, "CITATION_JUDGE_PAIR_TIMEOUT_MS", 8_000);
	const concurrency = positiveIntEnv(env, "CITATION_JUDGE_CONCURRENCY", 4);
	const runBudgetMs = positiveIntEnv(env, "CITATION_JUDGE_RUN_BUDGET_MS", 30_000);
	const attemptDeadlineMs = Math.floor((pairDeadlineMs - JUDGE_LADDER.backoffMs) / JUDGE_LADDER.attempts);
	const budget: JudgeBudget = { pairDeadlineMs, attemptDeadlineMs, concurrency, runBudgetMs };
	if (!budgetInvariantHolds(budget)) {
		throw new Error(
			`CITATION_JUDGE_PAIR_TIMEOUT_MS=${pairDeadlineMs} cannot hold the ${JUDGE_LADDER.attempts}-attempt ` +
				`retry ladder plus ${JUDGE_LADDER.backoffMs} ms backoff (derived attempt deadline ${attemptDeadlineMs} ms)`,
		);
	}
	return budget;
};

/** The deployed budget, derived once at load. An inconsistent override throws
 * here, which — through the server's static imports — refuses to boot. */
export const JUDGE_BUDGET: JudgeBudget = deriveJudgeBudget(process.env);

// ── The judgement walk ───────────────────────────────────────────────────────

const percentile = (sorted: readonly number[], fraction: number): number => {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
	return sorted[index] ?? 0;
};

/** Latency of one attempt over its non-cached verdicts (cached pairs answer in
 * 0 ms and would read as an invented speedup); null when nothing was called. */
export const judgeLatencyOf = (
	records: readonly JudgePairRecord[],
): { readonly p50: number; readonly p95: number; readonly max: number } | null => {
	const sorted = records.filter((record) => record.cached !== true).map((record) => record.ms).sort((a, b) => a - b);
	return sorted.length === 0 ? null : { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0 };
};

const messageOf = (error: unknown): string => {
	const text = error instanceof Error ? error.message : String(error);
	return text.slice(0, 200);
};

/** Map a thrown error to its named cause. The binding's messages are the
 * contract: HTTP statuses are embedded as `HTTP 4xx:`/`HTTP 5xx:`, timeouts
 * surface as abort/timeout errors, transport failures as `fetch failed` and
 * friends; everything else (unexpected answers, missing fields) is protocol. */
const causeOfJudgeError = (error: unknown): JudgeErrorCause => {
	const name = error instanceof Error ? error.name : "";
	const message = messageOf(error);
	if (name === "TimeoutError") return "timeout";
	if (/timed? ?out|timeout/i.test(message)) return "timeout";
	if (name === "AbortError" || /^judge aborted/.test(message)) return "aborted";
	if (/HTTP 4\d\d/.test(message)) return "http_4xx";
	if (/HTTP 5\d\d/.test(message)) return "http_5xx";
	if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|unreachable|network/i.test(message)) return "transport";
	return "protocol";
};

type Settled =
	| {
			readonly kind: "verdict";
			readonly citationId: string;
			readonly verdict: JudgeVerdict;
			readonly ms: number;
			readonly truncated: boolean;
			readonly cached: boolean;
	  }
	| { readonly kind: "error"; readonly citationId: string; readonly cause: JudgeErrorCause; readonly ms: number; readonly message: string; readonly fromBudget: boolean };

export type CoherenceResult =
	| { readonly ok: true; readonly records: readonly JudgePairRecord[]; readonly errors: readonly JudgeErrorRecord[] }
	| {
			readonly ok: false;
			readonly reason: Exclude<JudgeOutcome, "published">;
			readonly detail: string;
			readonly records: readonly JudgePairRecord[];
			readonly errors: readonly JudgeErrorRecord[];
	  };

/** The aggregation rule of RFC 0017 §4.2, unchanged: a line passes only if at
 * least one of its (claim, quote) pairs is `supported` and none is
 * `contradicted`; the first failing line wins the rejection detail; a judge
 * that errors answers nothing, and in `enforce` mode that rejects the publish
 * too. RFC 0020 changes how the walk is paid for and recorded, not the rule:
 *
 * - pairs run with bounded concurrency, results recorded in line order;
 * - the cache is consulted before the endpoint (a hit is `cached`, `ms: 0`);
 * - the run budget caps the whole attempt: at exhaustion every unresolved pair
 *   becomes a `timeout` error and the outcome is `judge_budget_exhausted`;
 * - every failure is stored with cause, duration and message.
 *
 * Fail-fast is preserved: the walk stops at the first failing line, and pairs
 * of later lines already in flight (at most `concurrency` − 1) settle but are
 * not recorded — the attempt record ends where the attempt ended. */
export const coherenceOf = async (input: {
	readonly markdown: string;
	readonly quoteOf: (citationId: string) => string | undefined;
	readonly judge: CitationJudge;
	/** Per-pair deadline override (tests); default the deployed envelope. */
	readonly timeoutMs?: number;
	readonly concurrency?: number;
	readonly runBudgetMs?: number;
	readonly cache?: JudgeCache;
}): Promise<CoherenceResult> => {
	const {
		markdown,
		quoteOf,
		judge,
		timeoutMs: pairDeadlineMs = JUDGE_BUDGET.pairDeadlineMs,
		concurrency = JUDGE_BUDGET.concurrency,
		runBudgetMs = JUDGE_BUDGET.runBudgetMs,
		cache,
	} = input;
	const modelId = (await judge.modelId?.()) ?? "unversioned";
	const deadlineAt = performance.now() + runBudgetMs;
	const records: JudgePairRecord[] = [];
	const errors: JudgeErrorRecord[] = [];

	type Pair = { readonly line: number; readonly citationId: string; readonly claim: string; readonly quote: string; readonly truncated: boolean };
	const pairs: Pair[] = [];
	const groups: { readonly judged: JudgedLine; readonly indices: number[] }[] = [];
	for (const judged of judgedLines(markdown)) {
		const indices: number[] = [];
		for (const citationId of judged.citationIds) {
			const quote = quoteOf(citationId);
			if (quote === undefined) continue; // unknown here too: the deterministic gate owns that reason
			const pair = truncatePair(judged.claim, quote);
			indices.push(pairs.length);
			pairs.push({ line: judged.line, citationId, claim: pair.claim, quote: pair.quote, truncated: pair.truncated });
		}
		groups.push({ judged, indices });
	}

	const settled: (Settled | undefined)[] = [];
	const pending = new Map<number, Promise<void>>();
	const recorded = new Set<number>(); // indices already pushed into records/errors
	let scheduleIndex = 0;
	let budgetExhausted = false;

	/** Keep the window full, in walk order. A cache hit never counts against
	 * the window or the budget; a pair met with an exhausted budget becomes a
	 * `timeout` error on the spot (RFC 0020 §4.3). */
	const schedule = (): void => {
		while (pending.size < concurrency && scheduleIndex < pairs.length) {
			const index = scheduleIndex++;
			const pair = pairs[index];
			if (pair === undefined) continue;
			const key = judgeCacheKey(pair.claim, pair.quote, modelId, JUDGE_QUESTION_VERSION);
			const hit = cache?.get(key);
			if (hit !== undefined) {
				settled[index] = { kind: "verdict", citationId: pair.citationId, verdict: hit, ms: 0, truncated: pair.truncated, cached: true };
				continue;
			}
			const remaining = deadlineAt - performance.now();
			if (remaining <= 0) {
				budgetExhausted = true;
				settled[index] = {
					kind: "error",
					citationId: pair.citationId,
					cause: "timeout",
					ms: 0,
					message: `judge run budget of ${runBudgetMs} ms exhausted before the pair was judged`,
					fromBudget: true,
				};
				continue;
			}
			const effectiveDeadline = Math.min(pairDeadlineMs, remaining);
			const fromBudget = remaining < pairDeadlineMs;
			const started = performance.now();
			const call = withTimeout(() => judge.judge({ claim: pair.claim, quote: pair.quote }), effectiveDeadline).then(
				(verdict: JudgeVerdict) => {
					settled[index] = { kind: "verdict", citationId: pair.citationId, verdict, ms: performance.now() - started, truncated: pair.truncated, cached: false };
					cache?.put(key, { verdict: verdict.verdict, score: verdict.score, ...(verdict.probabilities === undefined ? {} : { probabilities: verdict.probabilities }) });
				},
				(error: unknown) => {
					const cause = causeOfJudgeError(error);
					settled[index] = {
						kind: "error",
						citationId: pair.citationId,
						cause,
						ms: performance.now() - started,
						message: messageOf(error),
						// A budget cap only explains a timeout, never an HTTP or protocol failure.
						fromBudget: cause === "timeout" && fromBudget,
					};
				},
			);
			pending.set(
				index,
				(async () => {
					try {
						await call;
					} finally {
						pending.delete(index);
					}
				})(),
			);
		}
	};

	for (const group of groups) {
		schedule();
		for (const index of group.indices) {
			const promise = pending.get(index);
			if (promise !== undefined) await promise;
		}
		const line = group.judged.line;
		const preview = group.judged.claim.slice(0, 120);
		const lineRecords: JudgePairRecord[] = [];
		const lineErrors: JudgeErrorRecord[] = [];
		let supported = false;
		let contradiction: { readonly citationId: string; readonly score: number } | null = null;
		let lineBudgetHit = false;
		for (const index of group.indices) {
			const outcome = settled[index];
			if (outcome === undefined) continue;
			if (outcome.kind === "verdict") {
				lineRecords.push({
					line,
					citationId: outcome.citationId,
					verdict: outcome.verdict.verdict,
					score: outcome.verdict.score,
					ms: outcome.ms,
					truncated: outcome.truncated,
					...(outcome.verdict.probabilities === undefined
						? {}
						: { probabilities: outcome.verdict.probabilities, endpointConfidence: outcome.verdict.score }),
					...(outcome.cached ? { cached: true } : {}),
				});
				if (outcome.verdict.verdict === "supported") supported = true;
				if (outcome.verdict.verdict === "contradicted" && contradiction === null) {
					contradiction = { citationId: outcome.citationId, score: outcome.verdict.score };
				}
			} else {
				lineErrors.push({ line, citationId: outcome.citationId, cause: outcome.cause, ms: Math.round(outcome.ms), message: outcome.message });
				if (outcome.fromBudget) lineBudgetHit = true;
			}
		}
		for (const index of group.indices) recorded.add(index);
		if (contradiction !== null) {
			records.push(...lineRecords);
			errors.push(...lineErrors);
			return {
				ok: false,
				reason: "incoherent_citation",
				detail: `line ${line}: ${preview} [${contradiction.citationId}] contradicted (score ${contradiction.score.toFixed(2)})`,
				records,
				errors,
			};
		}
		if (lineErrors.length > 0 && !supported) {
			records.push(...lineRecords);
			errors.push(...lineErrors);
			const first = lineErrors[0];
			if (lineBudgetHit) {
				return {
					ok: false,
					reason: "judge_budget_exhausted",
					detail: `line ${line}: ${preview} [${first?.citationId}] unresolved: the judge run budget of ${runBudgetMs} ms was exhausted`,
					records,
					errors,
				};
			}
			return {
				ok: false,
				reason: "judge_error_unverified",
				detail: `line ${line}: ${preview} [${first?.citationId}] could not be verified (judge ${first?.cause}: ${first?.message})`,
				records,
				errors,
			};
		}
		if (!supported) {
			records.push(...lineRecords);
			errors.push(...lineErrors);
			return {
				ok: false,
				reason: "incoherent_citation",
				detail: `line ${line}: ${preview} [${group.judged.citationIds.join("; ")}] not supported by any cited quote`,
				records,
				errors,
			};
		}
		// The line passes: record it with its margin (§4.5) — best supported
		// score minus best non-supported score of the same line.
		const supportedScores = lineRecords.filter((record) => record.verdict === "supported").map((record) => record.score);
		const otherScores = lineRecords.filter((record) => record.verdict !== "supported").map((record) => record.score);
		const margin = supportedScores.length === 0 ? -1 : Math.max(...supportedScores) - (otherScores.length === 0 ? 0 : Math.max(...otherScores));
		records.push(...lineRecords.map((record) => ({ ...record, margin })));
		errors.push(...lineErrors);
		if (performance.now() >= deadlineAt) budgetExhausted = true;
		if (budgetExhausted && scheduleIndex < pairs.length) {
			// In-flight calls are already capped at the run deadline, so they
			// settle within it; every pair that still has no verdict becomes the
			// `timeout` error that names the exhaustion (§4.3). Verdicts that did
			// land are recorded as facts, without a line rule the walk never ran.
			const inFlight = [...pending.values()];
			if (inFlight.length > 0) await Promise.all(inFlight);
			for (let index = 0; index < pairs.length; index++) {
				if (recorded.has(index)) continue;
				const pair = pairs[index];
				if (pair === undefined) continue;
				const outcome = settled[index];
				if (outcome === undefined) {
						errors.push({
							line: pair.line,
							citationId: pair.citationId,
							cause: "timeout",
							ms: 0,
							message: `judge run budget of ${runBudgetMs} ms exhausted before the pair was judged`,
						});
					} else if (outcome.kind === "verdict") {
						records.push({
							line: pair.line,
							citationId: outcome.citationId,
							verdict: outcome.verdict.verdict,
							score: outcome.verdict.score,
							ms: outcome.ms,
							truncated: outcome.truncated,
							...(outcome.verdict.probabilities === undefined
								? {}
								: { probabilities: outcome.verdict.probabilities, endpointConfidence: outcome.verdict.score }),
							...(outcome.cached ? { cached: true } : {}),
						});
					} else {
						errors.push({ line: pair.line, citationId: outcome.citationId, cause: outcome.cause, ms: Math.round(outcome.ms), message: outcome.message });
					}
			}
			return {
				ok: false,
				reason: "judge_budget_exhausted",
				detail: `line ${line}: ${preview} passed, but the judge run budget of ${runBudgetMs} ms is exhausted`,
				records,
				errors,
			};
		}
	}
	return { ok: true, records, errors };
};

const withTimeout = <T>(start: () => Promise<T>, ms: number): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		let promise: Promise<T>;
		try {
			promise = start();
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const timer = setTimeout(() => reject(new Error(`judge timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});

/** A scripted fake for tests and demos: answers by match order or by a
 * predicate over the pair. Never reads anything. */
export class ScriptedJudge implements CitationJudge {
	readonly #script: (input: { claim: string; quote: string }) => Promise<JudgeVerdict> | JudgeVerdict;

	constructor(script: (input: { claim: string; quote: string }) => Promise<JudgeVerdict> | JudgeVerdict) {
		this.#script = script;
	}

	judge(input: { readonly claim: string; readonly quote: string }): Promise<JudgeVerdict> {
		return Promise.resolve(this.#script(input));
	}
}
