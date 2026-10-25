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
	workspace?: string;
	conversationId: number | null;
	entries: number;
	inFlight: number;
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
