// The trace-only measurement of RFC 0006 §5.8: used/reported/exact per run,
// recomputed from stored run state with no LLM and no judge. The headline is
// `citationExactness` over gated replies; friction counters make the gate's
// cost visible per reason so prompt regressions show up after every session.

import type { ConversationId } from "@earendil-works/pi-durable";
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
	/** RFC 0017 §6: the coherence judge's trace of this run; null when the
	 * judge never ran (`CITATION_JUDGE=off`, the default). */
	readonly judge: {
		readonly mode: "warn" | "enforce";
		/** Judged (line, citation) pairs. */
		readonly judgeVerdicts: number;
		readonly judgeRejections: number;
		readonly judgeTruncated: number;
		readonly judgeErrors: number;
		readonly supported: number;
		readonly unsupported: number;
		readonly contradicted: number;
		/** Per-pair latency in ms; null when nothing was judged. */
		readonly latencyMs: { readonly p50: number; readonly p95: number } | null;
	} | null;
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
	const judge = judgeReportOf(state.judge);
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

const percentile = (sorted: readonly number[], fraction: number): number => {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
	return sorted[index] ?? 0;
};

/** RFC 0017 §6: the stored judge trace as the report shows it. Runs stored
 * before the field existed read as `undefined`; both mean "no judge ran". */
const judgeReportOf = (
	judge: CitationRunState["judge"],
): CitationRunReport["judge"] => {
	if (judge === undefined || judge === null) return null;
	const sorted = [...judge.verdicts].map((record) => record.ms).sort((a, b) => a - b);
	return {
		mode: judge.mode,
		judgeVerdicts: judge.verdicts.length,
		judgeRejections: judge.rejections,
		judgeTruncated: judge.truncated,
		judgeErrors: judge.errors,
		supported: judge.verdicts.filter((record) => record.verdict === "supported").length,
		unsupported: judge.verdicts.filter((record) => record.verdict === "unsupported").length,
		contradicted: judge.verdicts.filter((record) => record.verdict === "contradicted").length,
		latencyMs: sorted.length === 0 ? null : { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) },
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
