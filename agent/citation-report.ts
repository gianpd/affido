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
