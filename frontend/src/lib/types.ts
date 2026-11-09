/** Wire shapes of the sandbox agent's read/write API (see agent/trace.ts). */

export type TraceEntry = {
	id: number;
	kind: string;
	at: number | null;
	summary: string;
	/** Role of the entry's first model message (newer snapshots only). */
	role?: 'user' | 'assistant' | 'toolResult' | 'system';
	/** `assistant`: tool names in call order — the decisions the agent made. */
	tools?: string[];
	stopReason?: string;
	model?: string;
	/** `toolResult`: which tool answered, whether it failed, how long it ran. */
	toolName?: string;
	isError?: boolean;
	durationMs?: number;
};

/** One content block of a stored message; `thinking` is the provider's reasoning. */
export type TraceContentPart =
	| { type: 'text'; text: string }
	| { type: 'thinking'; thinking: string; redacted?: boolean }
	| {
			type: 'toolCall';
			id: string;
			name: string;
			arguments: Record<string, unknown>;
			argumentsError?: string;
	  }
	| { type: 'image'; data: string; mimeType: string };

/** A message exactly as stored, so a tool result is the text the model received. */
export type TraceMessage = {
	role: 'system' | 'user' | 'assistant' | 'toolResult';
	content: string | TraceContentPart[];
	timestamp: number;
	/** `toolResult`: which call this answers, whether it failed, how long it ran. */
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	durationMs?: number;
	/** `assistant`: the model that produced the message. */
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** `system`: the named prompt sections this entry declares or replaces. */
	sections?: Record<string, string | null>;
};

/** `GET /entry`: one entry unprojected: the messages the model saw, tool results included. */
export type TraceEntryDetail = {
	id: number;
	kind: string;
	messages: TraceMessage[];
	data?: unknown;
};

export type TraceTask = {
	id: number;
	kind: string;
	status: string;
	background: boolean;
	startedAt: number | null;
	endedAt: number | null;
};

export type TraceSubmission = {
	id: number;
	requestId: string | null;
	status: string;
	entry: number | null;
	answer: number | null;
	reason: string | null;
};

export type TraceUsage = {
	input: number;
	output: number;
	totalTokens: number;
	cost: number;
};

export type TraceReport = {
	agent: string;
	paused: boolean;
	scheduling: unknown;
	conversationId: number;
	entries: {
		returned: number;
		hasMore: boolean;
		items: TraceEntry[];
	};
	tasks: TraceTask[];
	submissions: TraceSubmission[];
	usage: TraceUsage;
};

/** One (line, citation) pair the post-gate coherence judge classified
 * (RFC 0017 §6). `score` is the endpoint's confidence in `verdict` (0..1) —
 * not the label probability; new consumers read `probabilities` (RFC 0020 R5). */
export type JudgePairVerdict = {
	line: number;
	citationId: string;
	verdict: 'supported' | 'unsupported' | 'contradicted';
	score: number;
	ms: number;
	truncated: boolean;
	/** The full label distribution, wire labels (unrelated, not unsupported). */
	probabilities?: { supported: number; unrelated: number; contradicted: number };
	/** The endpoint confidence, pinned separately from `score`'s legacy meaning. */
	endpointConfidence?: number;
	/** Best supported − best non-supported of the line, −1 when no support. */
	margin?: number;
	/** Served from the run's verdict cache: 0 ms, no endpoint call. */
	cached?: boolean;
};

export type JudgeErrorCause =
	'timeout' | 'transport' | 'http_4xx' | 'http_5xx' | 'protocol' | 'aborted';

export type JudgeOutcome =
	'published' | 'incoherent_citation' | 'judge_error_unverified' | 'judge_budget_exhausted';

/** One judge attempt of a run, summarized (RFC 0020 §4.1): per-pair verdicts
 * exist only for the attempt that published. */
export type JudgeAttempt = {
	attempt: number;
	at: number;
	lines: number;
	pairs: number;
	supported: number;
	unsupported: number;
	contradicted: number;
	errors: number;
	/** cause → count, the named failures of RFC 0020 §4.2. */
	errorCauses: Partial<Record<JudgeErrorCause, number>>;
	truncated: number;
	outcome: JudgeOutcome;
	legacy: boolean;
	latencyMs: { p50: number; p95: number; max: number } | null;
};

/** The stored judge trace of one citation run; null when the judge never ran.
 * The run-level counts and `verdicts` describe the attempt that published —
 * never a sum over attempts (RFC 0020 R1). */
export type CitationRunJudge = {
	mode: 'warn' | 'enforce';
	/** One summary per judge attempt, in publish-attempt order. Absent from
	 * images that predate RFC 0020. */
	attempts?: JudgeAttempt[];
	/** The attempt that published, or the last of an unpublished run. */
	published?: JudgeAttempt | null;
	/** Per-pair verdicts of the published attempt, in call order. */
	verdicts?: JudgePairVerdict[];
	judgeVerdicts: number;
	judgeRejections: number;
	judgeTruncated: number;
	judgeErrors: number;
	supported: number;
	unsupported: number;
	contradicted: number;
	latencyMs: { p50: number; p95: number; max?: number } | null;
};

/** One strict-citations run, as `GET /inspect?report=citations` reports it (RFC 0006 §5.8). */
export type CitationRunReportView = {
	runId: string;
	strict: boolean;
	prompt: string;
	published: boolean;
	plain: boolean;
	used: string[];
	reported: string[];
	exact: boolean;
	unreportedUsed: string[];
	padded: string[];
	repliedWithoutCitations: boolean;
	annotateRejected: Record<string, number>;
	publishRejected: Record<string, number>;
	corpusCalls: number;
	judge?: CitationRunJudge | null;
};

export type CitationsReport = {
	agent: string;
	conversationId: number;
	runs: CitationRunReportView[];
	gatedReplies: number;
	exactReplies: number;
	citationExactness: number | null;
};

/** One citation of an agent reply, as the sandbox envelope reports it (RFC 0006 R6). */
export type Citation = {
	citationId: string;
	docId: string;
	title: string;
	filename: string;
	version: number;
	start: number;
	end: number;
	line: number;
	quote: string;
	textSha256: string;
	status: string;
};

/** One artifact of a run, as the sandbox envelope reports it (RFC 0009 R7). */
export type ArtifactView = {
	path: string;
	bytes: number;
	/** sha256 of the bytes; null above the download cap. */
	sha256: string | null;
	modifiedAt: string;
};

export type PromptResult = {
	agent: string;
	status: string;
	reason: string | null;
	/** The settlement's stored detail, e.g. the provider error behind `model_error`. */
	reasonDetail: string | null;
	answer: string | null;
	submissionId: number;
	requestId: string | null;
	conversationId: number;
	entries: number;
	/** `cited`: published through the gate; `plain`: no document evidence; `none`: strict run ended unpublished. */
	evidence: 'cited' | 'plain' | 'none';
	evidenceReason: string | null;
	citations: Citation[];
	citationsMode: 'required' | 'free';
	/** RFC 0016 §7: the user authorised web search for this run (absent on
	 * pre-RFC images, where web is not available at all). */
	webMode?: 'allowed' | 'off';
	runId: string | null;
	/** Files this run created or changed under `artifacts/` (RFC 0009 R7). */
	artifacts: ArtifactView[];
};

export type SandboxStatus = {
	agent: string;
	paused: boolean;
	model?: unknown;
	/** sha256(key)[:12] of the delivered BYOK key, or null; the only key-derived
	 * value the sandbox reports (RFC 0012 §5.4). */
	keyFingerprint?: string | null;
	/** RFC 0016 §7: the manager's control token landed in this process. A
	 * boolean, never the token itself. */
	webControl?: boolean;
	workspace?: string;
	conversationId: number | null;
	entries: number;
	inFlight: number;
};

/** `GET /storage` (RFC 0022): one sandbox's disk quota, measured over both
 * durable volumes. `availableBytes` is min(quota - used, host free space). */
export type StorageReport = {
	quotaBytes: number;
	usedBytes: number;
	availableBytes: number;
	/** Free bytes of the host filesystem behind the volumes; null if unreadable. */
	hostFreeBytes: number | null;
	usedPercent: number;
	state: 'ok' | 'warning' | 'critical' | 'full';
	/** True when the entry cap cut the scan short; usedBytes is then a lower bound. */
	partial: boolean;
	checkedAt: number;
};

/** One row of the chat's session history (RFC 0008): a conversation with its
 * chat rows, newest activity first. The active conversation appears even when
 * it has no messages yet. */
export type ChatSessionSummary = {
	conversationId: number;
	/** The session's first question, truncated for the list; empty when it has none yet. */
	title: string;
	/** Chat rows in the conversation (user and assistant). */
	messages: number;
	firstAt: Date | null;
	lastAt: Date | null;
};
