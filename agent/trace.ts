// Trace inspection: the read side of one sandbox.
//
// `TraceSource` is the port over the durable runtime: three read-only calls.
// `TraceReader` turns them into the wire report `GET /inspect` returns, and it
// is the only place that knows how a trace is shaped. The HTTP tool, the agent,
// and the tests see only the types declared here, so the report can change
// without touching the lifecycle.

import type { Context, JsonValue } from "@earendil-works/chord";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type {
	Conversation,
	ConversationId,
	EntryId,
	EntryRecord,
	HarnessInspection,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	TaskInspection,
	UsageState,
} from "@earendil-works/pi-durable";
import { citationsReportOf, type CitationsTraceReport } from "./citation-report.ts";
import type { CitationRunState } from "./citation-run.ts";

export const DEFAULT_TRACE_LIMIT = 50;
export const MAX_TRACE_LIMIT = 500;

// Long enough to recognize a turn in a terminal, short enough that a page of
// entries stays readable.
const MAX_SUMMARY = 160;

/** What `GET /inspect` asks for: one conversation, a bounded page of its newest entries. */
export type TraceQuery = {
	readonly conversationId?: ConversationId;
	readonly limit: number;
	/** `"citations"`: return the citation report instead of the trace report. */
	readonly report?: "citations";
};

export type TraceEntry = {
	readonly id: EntryId;
	readonly kind: string;
	/** Wall-clock milliseconds of the entry's first model message, when it has one. */
	readonly at: number | null;
	/** Collapsed text and tool-call names, truncated to 160 characters. */
	readonly summary: string;
	/** Role of the entry's first model message, when it has one. */
	readonly role?: "user" | "assistant" | "toolResult" | "system";
	/** `assistant`: tool names in call order — the decisions the agent made. */
	readonly tools?: readonly string[];
	/** `assistant`: why the response ended, and which model produced it. */
	readonly stopReason?: string;
	readonly model?: string;
	/** `toolResult`: which tool answered, whether it failed, how long it ran. */
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly durationMs?: number;
};

/**
 * One entry unprojected: `messages` is the transcript the model saw, so a tool
 * result is the exact text it received and a thinking block is not summarized.
 * `data` is the entry's application payload, such as tool diagnostics.
 */
export type TraceEntryDetail = {
	readonly id: EntryId;
	readonly kind: string;
	readonly messages: readonly Message[];
	readonly data?: JsonValue;
};

export type TraceTask = {
	readonly id: TaskId;
	readonly kind: string;
	readonly status: TaskInspection["record"]["state"]["status"];
	readonly background: boolean;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
};

export type TraceSubmission = {
	readonly id: SubmissionId;
	readonly requestId: string | null;
	readonly status: SubmissionRecord["status"];
	readonly entry: EntryId | null;
	readonly answer: EntryId | null;
	readonly reason: string | null;
};

export type TraceUsage = {
	readonly input: number;
	readonly output: number;
	readonly totalTokens: number;
	readonly cost: number;
};

export type TraceReport = {
	readonly agent: string;
	/** Whether the sandbox was paused when the request arrived, before `/inspect` activated it. */
	readonly paused: boolean;
	/** Scheduler state read from the open runtime. */
	readonly scheduling: HarnessInspection["scheduling"];
	readonly conversationId: ConversationId;
	/**
	 * The newest entries of that conversation. `returned` is this page, not the
	 * conversation size: the entries API counts by scanning, and the report will
	 * not pretend it knows a total it did not read.
	 */
	readonly entries: {
		readonly returned: number;
		readonly hasMore: boolean;
		readonly items: readonly TraceEntry[];
	};
	/** Live tasks only; settled work is in `entries`. */
	readonly tasks: readonly TraceTask[];
	/** Queued and placed submissions only; resolved ones are in `entries`. */
	readonly submissions: readonly TraceSubmission[];
	readonly usage: TraceUsage;
};

/**
 * Read-only access to one session's durable trace. Three trace methods, plus
 * the run-state read the citation report needs. Nothing here writes, so a
 * trace read can never change what it reports.
 */
export interface TraceSource {
	conversation(id: ConversationId): Promise<Conversation | undefined>;
	inspect(): Promise<HarnessInspection>;
	usage(): Promise<UsageState>;
	/** One citation run's stored state; `undefined` when the run id never existed. */
	runState(conversationId: ConversationId, runId: string, context: Context): Promise<CitationRunState | undefined>;
}

export class UnknownConversationError extends Error {
	readonly conversationId: ConversationId;

	constructor(conversationId: ConversationId) {
		super(`conversation ${conversationId} does not exist`);
		this.name = "UnknownConversationError";
		this.conversationId = conversationId;
	}
}

export class UnknownEntryError extends Error {
	readonly entryId: EntryId;

	constructor(entryId: EntryId) {
		super(`entry ${entryId} is not in this conversation`);
		this.name = "UnknownEntryError";
		this.entryId = entryId;
	}
}

export class InvalidTraceQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidTraceQueryError";
	}
}

export type TraceReaderOptions = {
	readonly source: TraceSource;
	readonly context: Context;
	readonly agent: string;
	/** Paused state at request arrival; `/inspect` itself activates the sandbox. */
	readonly paused: boolean;
	readonly defaultConversationId: ConversationId;
};

export class TraceReader {
	#source: TraceSource;
	#context: Context;
	#agent: string;
	#paused: boolean;
	#defaultConversationId: ConversationId;

	constructor({ source, context, agent, paused, defaultConversationId }: TraceReaderOptions) {
		this.#source = source;
		this.#context = context;
		this.#agent = agent;
		this.#paused = paused;
		this.#defaultConversationId = defaultConversationId;
	}

	async report(query: TraceQuery): Promise<TraceReport | CitationsTraceReport> {
		const conversationId = query.conversationId ?? this.#defaultConversationId;
		const conversation = await this.#source.conversation(conversationId);
		if (conversation === undefined) throw new UnknownConversationError(conversationId);
		if (query.report === "citations") return this.#citationReport(conversation, conversationId);

		const [page, inspection, usage] = await Promise.all([
			conversation.entries({}, query.limit, undefined, this.#context),
			this.#source.inspect(),
			this.#source.usage(),
		]);

		return {
			agent: this.#agent,
			paused: this.#paused,
			scheduling: inspection.scheduling,
			conversationId,
			entries: {
				returned: page.items.length,
				hasMore: page.next !== undefined,
				items: page.items.map(projectEntry),
			},
			tasks: inspection.tasks
				.filter((task) => task.record.conversationId === conversationId)
				.map(projectTask),
			submissions: inspection.submissions
				.filter((submission) => submission.conversationId === conversationId)
				.map(projectSubmission),
			usage: foldUsage(usage),
		};
	}

	/**
	 * One entry of the default conversation, unprojected. `minEntryId` and
	 * `maxEntryId` both equal `id`, so the scan stays inside this conversation's
	 * visible history: an id from a forked-away entry is not found here.
	 */
	async entry(id: EntryId): Promise<TraceEntryDetail> {
		const conversation = await this.#source.conversation(this.#defaultConversationId);
		if (conversation === undefined) throw new UnknownConversationError(this.#defaultConversationId);
		const page = await conversation.entries(
			{ minEntryId: id, maxEntryId: id },
			1,
			undefined,
			this.#context,
		);
		const found = page.items[0];
		if (found === undefined) throw new UnknownEntryError(id);
		return { id: found.id, kind: found.kind, messages: found.model ?? [], data: found.data };
	}

	/** The citation report (§5.8): every strict run of the conversation, newest first. */
	async #citationReport(conversation: Conversation, conversationId: ConversationId): Promise<CitationsTraceReport> {
		const page = await conversation.entries({}, MAX_TRACE_LIMIT, undefined, this.#context);
		const runIds: string[] = [];
		for (const item of page.items) {
			if (item.kind !== "citations.strict") continue;
			const requestId = (item.data as { requestId?: unknown } | undefined)?.requestId;
			if (typeof requestId === "string" && !runIds.includes(requestId)) runIds.push(requestId);
		}
		const states: CitationRunState[] = [];
		for (const runId of runIds) {
			const state = await this.#source.runState(conversationId, runId, this.#context);
			if (state !== undefined) states.push(state);
		}
		return citationsReportOf(this.#agent, conversationId, states);
	}
}

/** Parse `?conversation=`, `?limit=`, and `?report=`; `limit` is clamped, invalid ids are refused. */
export const parseTraceQuery = (params: URLSearchParams): TraceQuery => {
	const conversation = positiveInteger("conversation", params.get("conversation"), null);
	const limit = positiveInteger("limit", params.get("limit"), DEFAULT_TRACE_LIMIT);
	const report = params.get("report");
	if (report !== null && report !== "citations") {
		throw new InvalidTraceQueryError('report must be "citations" when present');
	}
	return {
		conversationId: conversation === null ? undefined : (conversation as ConversationId),
		limit: Math.min(limit ?? DEFAULT_TRACE_LIMIT, MAX_TRACE_LIMIT),
		...(report === null ? {} : { report: "citations" as const }),
	};
};

const positiveInteger = (name: string, raw: string | null, fallback: number | null): number | null => {
	if (raw === null || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) throw new InvalidTraceQueryError(`${name} must be a positive integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) throw new InvalidTraceQueryError(`${name} must be a positive integer`);
	return value;
};

const summarizeMessage = (message: Message): string => {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.map((part) => {
						switch (part.type) {
							case "text":
								return part.text;
							case "thinking":
								return "[thinking]";
							case "image":
								return "[image]";
							case "toolCall":
								return `tool:${part.name}`;
						}
					})
					.join(" ");
	// A system entry's text is empty; its named sections are what changed.
	if (message.role === "system" && message.sections !== undefined) {
		return `${text} | sections: ${Object.keys(message.sections).join(",")}`.trim();
	}
	return text;
};

const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

const projectEntry = (entry: EntryRecord): TraceEntry => {
	const text = flatten((entry.model ?? []).map(summarizeMessage).join(" | "));
	const fallback = entry.data === undefined ? "" : flatten(JSON.stringify(entry.data));
	const summary = text === "" ? fallback : text;
	return {
		id: entry.id,
		kind: entry.kind,
		at: entry.model?.[0]?.timestamp ?? null,
		summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY)}...` : summary,
		...projectDecisions(entry.model?.[0]),
	};
};

/** The structured side of a decision node: what the graph view needs, from the first model message. */
const projectDecisions = (message: Message | undefined): Partial<TraceEntry> => {
	if (message === undefined) return {};
	switch (message.role) {
		case "assistant": {
			const tools = message.content
				.filter((part): part is ToolCall => part.type === "toolCall")
				.map((part) => part.name);
			return {
				role: "assistant",
				...(tools.length === 0 ? {} : { tools }),
				stopReason: message.stopReason,
				model: message.model,
			};
		}
		case "toolResult":
			return {
				role: "toolResult",
				toolName: message.toolName,
				isError: message.isError,
				durationMs: message.durationMs,
			};
		default:
			return { role: message.role };
	}
};

const projectTask = (inspection: TaskInspection): TraceTask => {
	const record = inspection.record;
	return {
		id: record.id,
		kind: record.kind,
		status: record.state.status,
		background: record.background,
		startedAt: record.startedAt ?? null,
		endedAt: record.endedAt ?? null,
	};
};

const projectSubmission = (record: SubmissionRecord): TraceSubmission => ({
	id: record.id,
	requestId: record.requestId ?? null,
	status: record.status,
	entry: "entry" in record ? (record.entry ?? null) : null,
	answer: "answer" in record ? (record.answer ?? null) : null,
	reason: "reason" in record ? (record.reason ?? null) : null,
});

// The counters `/inspect` reports. `UsageState` is a JSON representation of
// `Usage`; every bucket carries these four numbers.
type UsageCounters = {
	readonly input: number;
	readonly output: number;
	readonly totalTokens: number;
	readonly cost: { readonly total: number };
};

const foldUsage = (state: UsageState): TraceUsage => {
	const total = { input: 0, output: 0, totalTokens: 0, cost: 0 };
	const buckets = [state.models, state.tools] as readonly Readonly<Record<string, UsageCounters>>[];
	for (const bucket of buckets) {
		for (const usage of Object.values(bucket)) {
			total.input += usage.input;
			total.output += usage.output;
			total.totalTokens += usage.totalTokens;
			total.cost += usage.cost.total;
		}
	}
	return total;
};
