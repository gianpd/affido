// RFC 0020 §6 V1/V2: the judge report over per-attempt state. The fixture is a
// redacted reconstruction of run 8G9lKEW7XFlpFNw0 (conversation 1487): labels,
// scores, latencies, truncation flags and line numbers only — no claim or
// quote text. Five publishes: a gate rejection, two judge rejections that were
// infrastructure (timeouts), one real incoherence, and the answer that shipped.

import assert from "node:assert/strict";
import test from "node:test";
import type { JudgeAttemptRecord, JudgeErrorCause, JudgePairRecord } from "./citation-judge.ts";
import { runReportOf } from "./citation-report.ts";
import type { CitationRunState } from "./citation-run.ts";

const pair = (line: number, citationId: string, verdict: JudgePairRecord["verdict"], score: number, ms = 210, truncated = false): JudgePairRecord => ({
	line,
	citationId,
	verdict,
	score,
	ms,
	truncated,
});

const timeout = (line: number, citationId: string, ms: number): JudgeAttemptRecord["errors"][number] => ({
	line,
	citationId,
	cause: "timeout" satisfies JudgeErrorCause,
	ms,
	message: "judge timed out after 4700ms",
});

const attempt = (over: Partial<JudgeAttemptRecord> & Pick<JudgeAttemptRecord, "attempt" | "verdicts" | "outcome">): JudgeAttemptRecord => ({
	at: 1_760_000_000_000,
	lines: 7,
	errors: [],
	truncated: 0,
	latencyMs: { p50: 221, p95: 351, max: 351 },
	...over,
});

/** The four judged attempts of the motivating trace (§2): B=2, C=3, D=4, E=5. */
const attemptsOfRun = (): JudgeAttemptRecord[] => [
	// B: line 5 split (one supported at 0.52), line 9's pair timed out — the
	// line has no answer, so enforce failed closed on infrastructure.
	attempt({
		attempt: 2,
		lines: 2,
		verdicts: [pair(5, "cit_1000000001", "supported", 0.52, 351), pair(5, "cit_1000000002", "unsupported", 0.61, 206)],
		errors: [timeout(9, "cit_51da329482", 4_700)],
		outcome: "judge_error_unverified",
		latencyMs: { p50: 278, p95: 351, max: 351 },
	}),
	// C: the only pair it tried timed out; a bare counter used to hide this.
	attempt({
		attempt: 3,
		lines: 1,
		verdicts: [],
		errors: [timeout(5, "cit_51da329482", 4_700)],
		outcome: "judge_error_unverified",
		latencyMs: null,
	}),
	// D: reached line 29, the disabled-tools meta-line cited to a real quote,
	// judged unsupported at 0.95 — the layer working as designed.
	attempt({
		attempt: 4,
		lines: 7,
		verdicts: [
			pair(5, "cit_1000000001", "supported", 0.52, 208),
			pair(5, "cit_1000000002", "supported", 0.55, 221),
			pair(9, "cit_1000000003", "supported", 0.71, 214, true),
			pair(13, "cit_1000000004", "supported", 0.83, 219),
			pair(13, "cit_1000000005", "unsupported", 0.77, 230),
			pair(17, "cit_1000000006", "supported", 0.66, 226, true),
			pair(17, "cit_1000000007", "supported", 0.61, 218),
			pair(17, "cit_1000000008", "supported", 0.74, 224),
			pair(17, "cit_1000000009", "unsupported", 0.69, 233),
			pair(21, "cit_1000000010", "supported", 0.88, 221, true),
			pair(21, "cit_1000000011", "supported", 0.79, 228),
			pair(21, "cit_1000000012", "supported", 0.72, 232),
			pair(21, "cit_1000000013", "unsupported", 0.58, 240),
			pair(21, "cit_1000000014", "supported", 0.81, 226),
			pair(25, "cit_1000000015", "supported", 0.84, 222, true),
			pair(25, "cit_1000000016", "supported", 0.77, 229),
			pair(25, "cit_1000000017", "supported", 0.69, 235),
			pair(25, "cit_1000000018", "supported", 0.75, 231),
			pair(25, "cit_1000000019", "unsupported", 0.62, 238),
			pair(25, "cit_1000000020", "supported", 0.91, 227),
			pair(25, "cit_1000000021", "supported", 0.86, 234),
			pair(25, "cit_1000000022", "unsupported", 0.73, 241),
			pair(29, "cit_51da329482", "unsupported", 0.95, 606),
		],
		outcome: "incoherent_citation",
		truncated: 4,
		latencyMs: { p50: 226, p95: 351, max: 606 },
	}),
	// E: the shipped answer — D minus the meta-line; one line leans on a 0.24.
	attempt({
		attempt: 5,
		lines: 6,
		verdicts: [
			pair(5, "cit_1000000001", "supported", 0.52, 206),
			pair(5, "cit_1000000002", "supported", 0.55, 213),
			pair(9, "cit_1000000003", "supported", 0.71, 219, true),
			pair(13, "cit_1000000004", "supported", 0.83, 224),
			pair(13, "cit_1000000005", "unsupported", 0.77, 231),
			pair(17, "cit_1000000006", "supported", 0.66, 228, true),
			pair(17, "cit_1000000007", "supported", 0.61, 222),
			pair(17, "cit_1000000008", "supported", 0.74, 227),
			pair(17, "cit_1000000009", "unsupported", 0.69, 234),
			pair(21, "cit_1000000010", "supported", 0.88, 225, true),
			pair(21, "cit_1000000011", "supported", 0.79, 230),
			pair(21, "cit_1000000012", "supported", 0.72, 236),
			pair(21, "cit_79660bcb12", "supported", 0.24, 1320),
			pair(25, "cit_1000000015", "supported", 0.84, 223),
			pair(25, "cit_1000000016", "supported", 0.77, 229),
			pair(25, "cit_1000000017", "supported", 0.69, 233),
			pair(25, "cit_1000000018", "supported", 0.75, 231),
			pair(25, "cit_1000000019", "unsupported", 0.62, 237),
			pair(25, "cit_1000000020", "supported", 0.91, 226),
			pair(25, "cit_1000000021", "supported", 0.86, 232),
			pair(25, "cit_1000000022", "unsupported", 0.73, 239),
			pair(25, "cit_1000000023", "supported", 0.78, 228),
		],
		outcome: "published",
		truncated: 4,
		latencyMs: { p50: 228, p95: 606, max: 1_320 },
	}),
];

const stateOfRun = (judge: CitationRunState["judge"]): CitationRunState => ({
	runId: "8G9lKEW7XFlpFNw0",
	strict: true,
	prompt: "redacted",
	annotations: {},
	annotateRejections: {},
	publishRejections: { uncited_line: 1, judge_error_unverified: 2, incoherent_citation: 1 },
	corpusCalls: 12,
	published: { markdown: "redacted", citationIds: [] },
	plain: null,
	endedReason: null,
	judge,
});

test("V1: the aggregate describes the published answer, not a sum over attempts", () => {
	const report = runReportOf(stateOfRun({ mode: "enforce", attempts: attemptsOfRun(), spentMs: 12_400 }));
	const judge = report.judge;
	assert.notEqual(judge, null);
	if (judge === null) return;
	assert.equal(judge.mode, "enforce");
	// Four judge attempts, numbered 2..5 (attempt 1 was the gate's uncited_line).
	assert.equal(judge.attempts.length, 4);
	assert.deepEqual(
		judge.attempts.map((summary) => summary.pairs),
		[2, 0, 23, 22],
	);
	// Attempt 3 answered nothing: its single timeout is now visible, with its cause.
	const attempt3 = judge.attempts[1];
	assert.deepEqual({ attempt: attempt3?.attempt, outcome: attempt3?.outcome, errors: attempt3?.errors, causes: attempt3?.errorCauses }, {
		attempt: 3,
		outcome: "judge_error_unverified",
		errors: 1,
		causes: { timeout: 1 },
	});
	// The published attempt is 5, and the run-level numbers are ITS numbers.
	assert.equal(judge.published?.attempt, 5);
	assert.equal(judge.published?.outcome, "published");
	assert.equal(judge.judgeVerdicts, 22);
	assert.deepEqual({ supported: judge.supported, unsupported: judge.unsupported, contradicted: judge.contradicted }, { supported: 18, unsupported: 4, contradicted: 0 });
	assert.equal(Math.min(...(judge.verdicts.map((record) => record.score) ?? [1])), 0.24, "the 0.24 support is in the published trace");
	assert.deepEqual(judge.latencyMs, { p50: 228, p95: 606, max: 1_320 });
	assert.equal(judge.judgeTruncated, 4);
	assert.equal(judge.judgeErrors, 0, "the published attempt had no pair failures");
	// Rejections count attempts, not pairs: B, C and D were rejected.
	assert.equal(judge.judgeRejections, 3);
	// No retired reason name appears anywhere in the report.
	assert.ok(!JSON.stringify(report).includes("judge_unavailable"));
});

test("V1 (line rule visibility): the attempt outcomes name what happened", () => {
	const report = runReportOf(stateOfRun({ mode: "enforce", attempts: attemptsOfRun() }));
	const outcomes = report.judge?.attempts.map((summary) => summary.outcome) ?? [];
	// B and C were infrastructure (§2: two of the three rejections), D was the
	// layer working, E published.
	assert.deepEqual(outcomes, ["judge_error_unverified", "judge_error_unverified", "incoherent_citation", "published"]);
});

test("V2: a version-1 flat judge state reads as one legacy attempt with today's counts", () => {
	// The pre-RFC-0020 sum over attempts: 47 verdicts, 36/11/0, 2 errors, 8
	// truncated, 3 rejections — exactly what the old report showed.
	const flat = stateOfRun({
		mode: "enforce",
		verdicts: attemptsOfRun().flatMap((record) => record.verdicts),
		rejections: 3,
		truncated: 8,
		errors: 2,
	});
	const report = runReportOf(flat);
	const judge = report.judge;
	assert.notEqual(judge, null);
	if (judge === null) return;
	assert.equal(judge.attempts.length, 1);
	assert.deepEqual(
		{ attempt: judge.attempts[0]?.attempt, legacy: judge.attempts[0]?.legacy, outcome: judge.attempts[0]?.outcome },
		{ attempt: 1, legacy: true, outcome: "published" },
	);
	assert.equal(judge.judgeVerdicts, 47);
	assert.deepEqual({ supported: judge.supported, unsupported: judge.unsupported, contradicted: judge.contradicted }, { supported: 36, unsupported: 11, contradicted: 0 });
	assert.equal(judge.judgeRejections, 3);
	assert.equal(judge.judgeTruncated, 8);
	assert.equal(judge.judgeErrors, 2);
});

test("V2 (unpublished legacy run): the derived outcome is incoherent_citation", () => {
	const state = stateOfRun({
		mode: "enforce",
		verdicts: [pair(5, "cit_1000000001", "unsupported", 0.9)],
		rejections: 1,
		truncated: 0,
		errors: 0,
	});
	state.published = null;
	const report = runReportOf(state);
	assert.equal(report.judge?.attempts[0]?.outcome, "incoherent_citation");
	assert.equal(report.judge?.published?.outcome, "incoherent_citation");
});
