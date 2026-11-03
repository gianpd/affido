// The post-gate coherence judge of RFC 0017: a probabilistic layer that runs
// after the deterministic gate of RFC 0006 §5.4 accepted a publish, and asks
// one question per (line, citation) pair: is the claim the model wrote
// coherent with the quote behind its [cit_...] id?
//
// The port is one method. The gate and the tools depend on `CitationJudge`
// only; the GLiNER runtime (model, tokenizer, ONNX) lives behind
// `GlinerDecideJudge` in its own file, and tests drive a scripted fake.

/** One coherence verdict over a (claim, quote) pair.
 * `verdict` is the judge's decision; `score` is the probability the judge
 * assigned to that decision (0..1). */
export type JudgeVerdict = {
	readonly verdict: "supported" | "unsupported" | "contradicted";
	readonly score: number;
};

/** The port. Input is state the run already stored: the published line with
 * tokens stripped (the claim) and the annotation's exact quote. Implementations
 * must not read the corpus and must not re-locate any span. */
export interface CitationJudge {
	judge(input: { readonly claim: string; readonly quote: string }): Promise<JudgeVerdict>;
	/** RFC 0018: whether the runtime can currently judge at all. Absent means
	 * always available (ScriptedJudge, GlinerDecideJudge — whose boot check
	 * already fails loudly). A judge that is not available is *absent*, not
	 * erroring: the publish path skips the layer, so `enforce` never rejects
	 * a publish merely because no credential backs the judge. A judge that is
	 * available and then fails still rejects under `enforce` (`judge_error`). */
	available?(): Promise<boolean>;
}

/** RFC 0017 §3: the deployment mode of the coherence check.
 * - `off` (default): the layer is absent; behavior is exactly RFC 0006.
 * - `warn`: verdicts, latencies and truncations are recorded, never a rejection.
 * - `enforce`: an incoherent line rejects the publish with `incoherent_citation`. */
export type JudgeMode = "off" | "warn" | "enforce";

export const JUDGE_TIMEOUT_MS = 5_000;

/** A claim or quote longer than this many characters is cut before judging
 * (RFC 0017 §4.3): the 512-token budget is shared by the question, the labels
 * and both fields, so both are capped separately, the quote at a sentence
 * boundary, and every cut pair is counted as truncated. */
export const CLAIM_CAP_CHARS = 600;
export const QUOTE_CAP_CHARS = 1400;

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

/** One (line, citation) pair the layer judged, as stored in the run. */
export type JudgePairRecord = {
	/** 1-based line of the published markdown. */
	readonly line: number;
	readonly citationId: string;
	readonly verdict: JudgeVerdict["verdict"];
	readonly score: number;
	readonly ms: number;
	readonly truncated: boolean;
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

export type CoherenceResult =
	| { readonly ok: true; readonly records: readonly JudgePairRecord[]; readonly errors: number }
	| { readonly ok: false; readonly reason: "incoherent_citation" | "judge_error"; readonly detail: string; readonly records: readonly JudgePairRecord[]; readonly errors: number };

/** The aggregation rule of RFC 0017 §4.2: a line passes only if at least one
 * of its (claim, quote) pairs is `supported` and none is `contradicted` —
 * support is split across the line's ids, a contradiction overrides it. The
 * first failing line wins the rejection detail. A judge that errors or times
 * out answers nothing: the pair counts as unverified (`errors`), and in
 * `enforce` mode that rejects the publish too — there is no publish without a
 * pass, the same rule the deterministic gate applies to itself. */
export const coherenceOf = async (input: {
	readonly markdown: string;
	readonly quoteOf: (citationId: string) => string | undefined;
	readonly judge: CitationJudge;
	readonly timeoutMs?: number;
}): Promise<CoherenceResult> => {
	const { markdown, quoteOf, judge, timeoutMs = JUDGE_TIMEOUT_MS } = input;
	const records: JudgePairRecord[] = [];
	let errors = 0;
	for (const judged of judgedLines(markdown)) {
		let supported = false;
		let contradiction: { citationId: string; verdict: JudgeVerdict } | null = null;
		let unverified: string | null = null;
		for (const citationId of judged.citationIds) {
			const quote = quoteOf(citationId);
			if (quote === undefined) continue; // unknown here too: the deterministic gate owns that reason
			const pair = truncatePair(judged.claim, quote);
			const started = performance.now();
			try {
				const verdict = await withTimeout(judge.judge({ claim: pair.claim, quote: pair.quote }), timeoutMs);
				records.push({
					line: judged.line,
					citationId,
					verdict: verdict.verdict,
					score: verdict.score,
					ms: performance.now() - started,
					truncated: pair.truncated,
				});
				if (verdict.verdict === "supported") supported = true;
				if (verdict.verdict === "contradicted" && contradiction === null) contradiction = { citationId, verdict };
			} catch {
				errors++;
				unverified = citationId;
			}
		}
		if (contradiction !== null) {
			return {
				ok: false,
				reason: "incoherent_citation",
				detail: `line ${judged.line}: ${judged.claim.slice(0, 120)} [${contradiction.citationId}] contradicted (score ${contradiction.verdict.score.toFixed(2)})`,
				records,
				errors,
			};
		}
		if (unverified !== null && !supported) {
			return {
				ok: false,
				reason: "judge_error",
				detail: `line ${judged.line}: ${judged.claim.slice(0, 120)} [${unverified}] could not be verified (judge error or timeout)`,
				records,
				errors,
			};
		}
		if (!supported) {
			return {
				ok: false,
				reason: "incoherent_citation",
				detail: `line ${judged.line}: ${judged.claim.slice(0, 120)} [${judged.citationIds.join("; ")}] not supported by any cited quote`,
				records,
				errors,
			};
		}
	}
	return { ok: true, records, errors };
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
	new Promise<T>((resolve, reject) => {
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
