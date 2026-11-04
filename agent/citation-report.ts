// The trace-only measurement of RFC 0006 §5.8: used/reported/exact per run,
// recomputed from stored run state with no LLM and no judge. The headline is
// `citationExactness` over gated replies; friction counters make the gate's
// cost visible per reason so prompt regressions show up after every session.

import type { ConversationId } from "@earendil-works/pi-durable";
import { judgeLatencyOf } from "./citation-judge.ts";
import type { JudgeOutcome, JudgePairRecord } from "./citation-judge.ts";
import { isLegacyJudgeState } from "./citation-run.ts";
import type { CitationRunState } from "./citation-run.ts";

export type CitationRunReport = {
	readonly runId: string;
	readonly strict: boolean;
	readonly prompt: string;
	/** The run exited through `answer_publish`. */
	readonly published: boolean;
	/** The run exited through `answer_plain`. */
	readonly plain: boolean;
	/** citationIds of successful annotates. */
	readonly used: readonly string[];
	/** citationIds of the accepted publish. */
	readonly reported: readonly string[];
	/** set(reported) == set(used). Holds by construction after the gate. */
	readonly exact: boolean;
	readonly unreportedUsed: readonly string[];
	readonly padded: readonly string[];
	/** Annotations exist and the run ended unpublished. */
	readonly repliedWithoutCitations: boolean;
	readonly annotateRejected: Readonly<Record<string, number>>;
	readonly publishRejected: Readonly<Record<string, number>>;
	readonly corpusCalls: number;
	/** RFC 0017 §6 / RFC 0020 §4.1: the coherence judge's trace of this run;
	 * null when the judge never ran (mode off, or no credential backed it).
	 * The run-level counts describe the attempt that published — never a sum
	 * over attempts, which would judge a document that does not exist (R1). */
	readonly judge: {
		readonly mode: "warn" | "enforce";
		/** One summary per judge attempt, in publish-attempt order. */
		readonly attempts: readonly JudgeAttemptSummary[];
		/** The attempt that published, or the last attempt of an unpublished run. */
		readonly published: JudgeAttemptSummary | null;
		/** Per-pair verdicts of `published`, in call order. Absent from agents
		 * that predate the field. */
		readonly verdicts: readonly JudgePairRecord[];
		readonly judgeVerdicts: number;
		/** Attempts the judge rejected (run-level: it counts attempts, not pairs). */
		readonly judgeRejections: number;
		readonly judgeTruncated: number;
		readonly judgeErrors: number;
		readonly supported: number;
		readonly unsupported: number;
		readonly contradicted: number;
		readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number } | null;
	} | null;
};

/** One judge attempt as the report summarises it (RFC 0020 §4.1): index,
 * outcome, counts, error causes. Per-pair verdicts exist only for `published`. */
export type JudgeAttemptSummary = {
	readonly attempt: number;
	readonly at: number;
	readonly lines: number;
	readonly pairs: number;
	readonly supported: number;
	readonly unsupported: number;
	readonly contradicted: number;
	readonly errors: number;
	/** cause → count, the named failures of §4.2. */
	readonly errorCauses: Readonly<Record<string, number>>;
	readonly truncated: number;
	readonly outcome: JudgeOutcome;
	readonly legacy: boolean;
	readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number } | null;
};

export type CitationsTraceReport = {
	readonly agent: string;
	readonly conversationId: ConversationId;
	readonly runs: readonly CitationRunReport[];
	/** Replies that exited through the gate. */
	readonly gatedReplies: number;
	readonly exactReplies: number;
	/** exactReplies / gatedReplies; null before the first gated reply. */
	readonly citationExactness: number | null;
};

export const runReportOf = (state: CitationRunState): CitationRunReport => {
	const used = Object.keys(state.annotations);
	const reported = state.published?.citationIds ?? [];
	const usedSet = new Set(used);
	const reportedSet = new Set(reported);
	const judge = judgeReportOf(state);
	return {
		runId: state.runId,
		strict: state.strict,
		prompt: state.prompt,
		published: state.published !== null,
		plain: state.plain !== null,
		used,
		reported,
		exact: usedSet.size === reportedSet.size && reported.every((id) => usedSet.has(id)),
		unreportedUsed: used.filter((id) => !reportedSet.has(id)),
		padded: reported.filter((id) => !usedSet.has(id)),
		repliedWithoutCitations: used.length > 0 && state.published === null,
		annotateRejected: state.annotateRejections,
		publishRejected: state.publishRejections,
		corpusCalls: state.corpusCalls,
		judge,
	};
};
const summarizeVerdicts = (verdicts: readonly JudgePairRecord[]): Pick<JudgeAttemptSummary, "pairs" | "supported" | "unsupported" | "contradicted"> => ({
	pairs: verdicts.length,
	supported: verdicts.filter((record) => record.verdict === "supported").length,
	unsupported: verdicts.filter((record) => record.verdict === "unsupported").length,
	contradicted: verdicts.filter((record) => record.verdict === "contradicted").length,
});

/** RFC 0020 §4.1: the stored judge trace as the report shows it. A version-1
 * flat state reads as one attempt with `legacy: true` and the outcome derived
 * from the run (`published` when the run published, `incoherent_citation`
 * otherwise) — same counts as today, no migration. Runs stored before the
 * field existed read as `undefined`; both mean "no judge ran". */
const judgeReportOf = (
	state: CitationRunState,
): CitationRunReport["judge"] => {
	const judge = state.judge;
	if (judge === undefined || judge === null) return null;
	if (isLegacyJudgeState(judge)) {
		const counts = summarizeVerdicts(judge.verdicts);
		const latencyMs = judgeLatencyOf(judge.verdicts);
		const legacy: JudgeAttemptSummary = {
			attempt: 1,
			at: 0,
			lines: 0,
			...counts,
			errors: judge.errors,
			errorCauses: {},
			truncated: judge.truncated,
			outcome: state.published !== null ? "published" : "incoherent_citation",
			legacy: true,
			latencyMs,
		};
		return {
			mode: judge.mode,
			attempts: [legacy],
			published: legacy,
			verdicts: judge.verdicts,
			judgeVerdicts: judge.verdicts.length,
			judgeRejections: judge.rejections,
			judgeTruncated: judge.truncated,
			judgeErrors: judge.errors,
			...counts,
			latencyMs,
		};
	}
	const attempts: JudgeAttemptSummary[] = judge.attempts.map((record) => ({
		attempt: record.attempt,
		at: record.at,
		lines: record.lines,
		...summarizeVerdicts(record.verdicts),
		errors: record.errors.length,
		errorCauses: record.errors.reduce<Record<string, number>>((causes, error) => {
			causes[error.cause] = (causes[error.cause] ?? 0) + 1;
			return causes;
		}, {}),
		truncated: record.truncated,
		outcome: record.outcome,
		legacy: record.legacy === true,
		latencyMs: record.latencyMs,
	}));
	const publishedRecord =
		judge.attempts.find((record) => record.outcome === "published") ?? judge.attempts.at(-1) ?? null;
	const published = publishedRecord === null ? null : (attempts.find((summary) => summary.attempt === publishedRecord?.attempt) ?? null);
	const publishedVerdicts = publishedRecord?.verdicts ?? [];
	return {
		mode: judge.mode,
		attempts,
		published,
		verdicts: publishedVerdicts,
		judgeVerdicts: publishedVerdicts.length,
		judgeRejections: attempts.filter((summary) => summary.outcome !== "published").length,
		judgeTruncated: publishedRecord?.truncated ?? 0,
		judgeErrors: publishedRecord?.errors.length ?? 0,
		...summarizeVerdicts(publishedVerdicts),
		latencyMs: publishedRecord?.latencyMs ?? null,
	};
};

export const citationsReportOf = (
	agent: string,
	conversationId: ConversationId,
	states: readonly CitationRunState[],
): CitationsTraceReport => {
	const runs = states.map(runReportOf);
	const gated = runs.filter((run) => run.published);
	return {
		agent,
		conversationId,
		runs,
		gatedReplies: gated.length,
		exactReplies: gated.filter((run) => run.exact).length,
		citationExactness: gated.length === 0 ? null : gated.filter((run) => run.exact).length / gated.length,
	};
};
