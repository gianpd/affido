// Tests of the dependency seams: ContainerAgent runs on an injected
// HarnessLifecycle and satisfies AgentApi, so these drive the agent with a fake
// lifecycle — no SQLite, no provider, no pi-durable runtime.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, MutableModels, ThinkingContent } from "@earendil-works/pi-ai";
import type {
	Conversation,
	ConversationId,
	EntryId,
	EntryRecord,
	SubmissionDraft,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	TaskInspection,
} from "@earendil-works/pi-durable";
import { ContainerAgent } from "./agent.ts";
import { MAX_ARTIFACT_BYTES } from "./artifacts.ts";
import type { ConversationHandler, HarnessLifecycle } from "./harness.ts";
import {
	DEFAULT_TRACE_LIMIT,
	InvalidTraceQueryError,
	MAX_TRACE_LIMIT,
	parseTraceQuery,
	UnknownConversationError,
	UnknownEntryError,
	type TraceReport,
	type TraceSource,
} from "./trace.ts";

/** Records lifecycle calls. The fake conversation carries only the `id` the tested paths read. */
class FakeLifecycle implements HarnessLifecycle {
	activations = 0;
	closes = 0;
	refreshes = 0;
	resets = 0;
	newSessions = 0;
	switchSessions = 0;
	traces = 0;
	paused = true;
	conversationId: ConversationId | null = null;
	entries = 0;
	inFlight = 0;

	readonly traceSource: TraceSource;
	/** The conversation `activate` hands to handlers; default carries only the `id`. */
	readonly conversation: Conversation;

	constructor(traceSource: TraceSource = fakeTraceSource(), conversation?: Conversation) {
		this.traceSource = traceSource;
		this.conversation =
			conversation ??
			({
				id: 1 as ConversationId,
				reset: async () => {
					this.resets++;
				},
			} ) as unknown as Conversation;
	}

	async activate<T>(handler: ConversationHandler<T>): Promise<T> {
		this.activations++;
		return handler(this.conversation);
	}

	async trace<T>(handler: (source: TraceSource) => Promise<T>): Promise<T> {
		this.traces++;
		this.paused = false;
		this.conversationId = 1 as ConversationId;
		return handler(this.traceSource);
	}

	async close(): Promise<void> {
		this.closes++;
	}

	async newSession(): Promise<{ conversationId: ConversationId; entries: number }> {
		this.newSessions++;
		return { conversationId: 2 as ConversationId, entries: 0 };
	}

	async switchSession(conversationId: ConversationId): Promise<{ conversationId: ConversationId; entries: number }> {
		this.switchSessions++;
		this.conversationId = conversationId;
		return { conversationId, entries: 0 };
	}

	async refreshStats(): Promise<void> {
		this.refreshes++;
	}
}

/** A fake conversation whose submissions record their drafts and can simulate
 * work happening between the agent's snapshots and the settlement (RFC 0009: a
 * run that writes an artifact). `commit` runs the handler against a minimal
 * doc store so `placeCurrentRun` behaves as in production. */
type FakeTx = {
	doc: (_definition: unknown, _conversationId: unknown, key?: unknown, seed?: unknown) => Record<string, unknown>;
	entry: () => undefined;
};

const scriptableConversation = (
	drafts: SubmissionDraft[],
	onWait?: () => Promise<void> | void,
): Conversation => {
	const runs = new Map<string, Record<string, unknown>>();
	const pointer: Record<string, unknown> = { runId: null, strict: false };
	const tx: FakeTx = {
		doc: (_definition, _conversationId, key, seed) => {
			if (typeof key !== "string") return pointer;
			let run = runs.get(key);
			if (run === undefined) {
				run = {
					annotations: {},
					annotateRejections: {},
					publishRejections: {},
					corpusCalls: 0,
					published: null,
					plain: null,
					endedReason: null,
					artifactBaseline: null,
					...((seed as Record<string, unknown> | undefined) ?? {}),
				};
				runs.set(key, run);
			}
			return run;
		},
		entry: () => undefined,
	};
	return {
		id: 1 as ConversationId,
		commit: async (handler: (tx: FakeTx) => unknown) => handler(tx),
		submit: async (draft: SubmissionDraft) => {
			drafts.push(draft);
			return {
				id: 5 as SubmissionId,
				wait: async () => {
					await onWait?.();
					return { id: 5 as SubmissionId, status: "done" as const, type: "input" as const, answer: 7 as EntryId };
				},
			};
		},
	} as unknown as Conversation;
};

const fakeConversation = (items: readonly EntryRecord[], hasMore = false): Conversation =>
	({
		id: 1 as ConversationId,
		// Honours the `minEntryId`/`maxEntryId` single-entry lookup `/entry` uses.
		entries: async (query: { minEntryId?: EntryId; maxEntryId?: EntryId }) => ({
			items: items.filter(
				(item) =>
					(query.minEntryId === undefined || item.id >= query.minEntryId) &&
					(query.maxEntryId === undefined || item.id <= query.maxEntryId),
			),
			next: hasMore ? { cursor: 1 } : undefined,
		}),
	}) as unknown as Conversation;

const entry = (id: number, kind: string, text: string): EntryRecord => ({
	id: id as EntryId,
	conversationId: 1 as ConversationId,
	kind,
	model: [{ role: "user", content: text, timestamp: 1_000 + id }],
});

const liveTask = (id: number, conversationId: number): TaskInspection => ({
	record: {
		id: id as TaskId<JsonValue>,
		conversationId: conversationId as ConversationId,
		kind: "pi.tool",
		version: 1,
		input: null,
		background: false,
		abortRequested: false,
		state: { status: "running", checkpoint: null },
	},
	state: { kind: "running" },
});

const liveSubmission = (id: number, conversationId: number): SubmissionRecord => ({
	id: id as SubmissionId,
	conversationId: conversationId as ConversationId,
	type: "input",
	status: "queued",
});

const usage = (input: number, output: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
});

function fakeTraceSource(items = [entry(2, "pi.user", "hi"), entry(3, "pi.assistant", "hello")]): TraceSource {
	const conversation = fakeConversation(items);
	return {
		conversation: async (id) => (id === 1 ? conversation : undefined),
		inspect: async () => ({
			scheduling: "running",
			tasks: [liveTask(10, 1), liveTask(11, 2)],
			submissions: [liveSubmission(20, 1), liveSubmission(21, 2)],
		}),
		usage: async () => ({ models: { "faux/faux-1": usage(10, 5) }, tools: { bash: usage(1, 1) } }),
		runState: async () => undefined,
	};
}

// models/sessionDb are only read when building the default DurableHarness; with
// a harness injected they never leave this call.
const makeAgent = async (harness: HarnessLifecycle) => {
	const workspace = await mkdtemp(join(tmpdir(), "agent-test-"));
	const agent = new ContainerAgent({
		name: "test",
		workspace,
		sessionDb: ":memory:",
		idleMs: 60_000,
		models: {} as MutableModels,
		model: { provider: "faux", modelId: "faux-1" },
		context: BACKGROUND_CONTEXT,
		log: () => {},
		harness,
	});
	return { agent, workspace };
};

test("a run that writes an artifact reports it in the envelope; a replay re-derives the same list", async () => {
	let lifecycleWorkspace: string | null = null;
	let ranOnce = false;
	const drafts: SubmissionDraft[] = [];
	const lifecycle = new FakeLifecycle(
		fakeTraceSource(),
		scriptableConversation(drafts, async () => {
			// The "model's" work, once — a replay never runs again: one deliverable
			// lands under artifacts/ between the admission snapshot and the
			// settlement (RFC 0009 §5.7).
			if (ranOnce) return;
			ranOnce = true;
			await mkdir(join(lifecycleWorkspace!, "artifacts"), { recursive: true });
			await writeFile(join(lifecycleWorkspace!, "artifacts/proposal.docx"), "PK-zip-bytes");
		}),
	);
	const { agent, workspace } = await makeAgent(lifecycle);
	lifecycleWorkspace = workspace;

	const first = await agent.prompt("make a proposal", "req-art-1", "off");
	assert.equal(first.status, "done");
	assert.equal(first.artifacts.length, 1);
	assert.equal(first.artifacts[0]?.path, "proposal.docx");
	assert.equal(first.artifacts[0]?.bytes, 12);
	assert.match(first.artifacts[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
	assert.ok(typeof first.artifacts[0]?.modifiedAt === "string");

	// Idempotent replay (R9): same admitted submission, artifact list re-derived
	// from the admission baseline — the file still on disk is still the run's.
	const replay = await agent.prompt("make a proposal", "req-art-1", "off");
	assert.equal(replay.submissionId, first.submissionId);
	assert.equal(replay.artifacts.length, 1);
	assert.equal(replay.artifacts[0]?.path, "proposal.docx");
	// And the deletion the RFC documents: the file gone, the list shrinks.
	await rm(join(workspace, "artifacts/proposal.docx"), { force: true });
	const shrunk = await agent.prompt("make a proposal", "req-art-1", "off");
	assert.equal(shrunk.submissionId, first.submissionId);
	assert.deepEqual(shrunk.artifacts, []);
});

test("an artifact above the download cap is reported with sha256 null", async () => {
	let lifecycleWorkspace: string | null = null;
	const drafts: SubmissionDraft[] = [];
	const lifecycle = new FakeLifecycle(
		fakeTraceSource(),
		scriptableConversation(drafts, async () => {
			await mkdir(join(lifecycleWorkspace!, "artifacts"), { recursive: true });
			await writeFile(join(lifecycleWorkspace!, "artifacts/big.bin"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
		}),
	);
	const { agent, workspace } = await makeAgent(lifecycle);
	lifecycleWorkspace = workspace;

	const result = await agent.prompt("make a big file", "req-art-2", "off");
	assert.equal(result.artifacts.length, 1);
	assert.equal(result.artifacts[0]?.bytes, MAX_ARTIFACT_BYTES + 1);
	assert.equal(result.artifacts[0]?.sha256, null);
});

test("a /skill_name prompt carries the server-built hint in the stored content", async () => {
	const drafts: SubmissionDraft[] = [];
	const lifecycle = new FakeLifecycle(fakeTraceSource(), scriptableConversation(drafts));
	const { agent, workspace } = await makeAgent(lifecycle);
	await mkdir(join(workspace, "skills/md-to-docx"), { recursive: true });
	await writeFile(
		join(workspace, "skills/md-to-docx/SKILL.md"),
		"---\ndescription: convert notes\n---\n# md-to-docx\n",
	);

	const resolved = await agent.prompt("/md-to-docx make a proposal", "req-hint-1", "off");
	assert.equal(resolved.status, "done");
	const content = (drafts.at(-1) as { content?: unknown }).content;
	assert.equal(typeof content, "string");
	assert.ok((content as string).includes('[skill hint] The user invoked the skill "md-to-docx".'));
	assert.ok((content as string).startsWith("make a proposal\n"), "the /name token is stripped");

	const unresolved = await agent.prompt("/nope do a thing", "req-hint-2", "off");
	const kept = (drafts.at(-1) as { content?: unknown }).content as string;
	assert.ok(kept.includes("is not installed"));
	assert.ok(kept.includes("Installed skills: md-to-docx"));

	const plain = await agent.prompt("what is 2+2", "req-hint-3", "off");
	assert.equal((drafts.at(-1) as { content?: unknown }).content, "what is 2+2");
	assert.deepEqual(plain.artifacts, []);
});

test("status reports the injected lifecycle without activating it", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);
	const status = agent.status();
	assert.equal(status.agent, "test");
	assert.equal(status.paused, true);
	assert.equal(status.conversationId, null);
	assert.equal(lifecycle.activations, 0);
});

test("listDir and readFile go through the injected lifecycle", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent, workspace } = await makeAgent(lifecycle);
	await writeFile(join(workspace, "b.txt"), "two");
	await writeFile(join(workspace, "a.txt"), "one");

	const listing = await agent.listDir(".");
	assert.deepEqual(
		listing.entries.map((entry) => entry.name),
		["a.txt", "b.txt"],
	);
	assert.equal(lifecycle.activations, 1);

	const file = await agent.readFile("a.txt");
	assert.equal(file.content, "one");
});

test("session refreshes stats through the injected lifecycle", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);
	const session = await agent.session();
	assert.equal(session.agent, "test");
	assert.equal(session.conversationId, 1);
	assert.equal(session.paused, false);
	assert.equal(lifecycle.refreshes, 1);
});

test("reset starts a new context through the injected lifecycle", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);

	const result = await agent.reset();

	assert.equal(result.agent, "test");
	assert.equal(result.conversationId, 1);
	assert.equal(lifecycle.resets, 1);
	assert.equal(lifecycle.refreshes, 1);
});

test("newSession starts a separate conversation through the injected lifecycle", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);

	const result = await agent.newSession();

	assert.deepEqual(result, { agent: "test", conversationId: 2, entries: 0 });
	assert.equal(lifecycle.newSessions, 1);
	assert.equal(lifecycle.resets, 0, "a new session is not a reset");
});

test("switchSession resumes a conversation through the injected lifecycle", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);

	const result = await agent.switchSession(1);

	assert.deepEqual(result, { agent: "test", conversationId: 1, entries: 0 });
	assert.equal(lifecycle.switchSessions, 1);
	assert.equal(lifecycle.resets, 0, "resuming a session is not a context cut");
	assert.equal(lifecycle.newSessions, 0, "resuming creates no conversation");
});

test("pause closes the injected lifecycle", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);
	const result = await agent.pause();
	assert.deepEqual(result, { agent: "test", paused: true });
	assert.equal(lifecycle.closes, 1);
});

test("paths outside the workspace are refused", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);
	await assert.rejects(agent.readFile("../escape.txt"));
});

test("inspect reports entries, filters live work by conversation, and folds usage", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);

	const report = (await agent.inspect({ limit: 10 })) as TraceReport;

	assert.equal(report.agent, "test");
	assert.equal(report.conversationId, 1);
	assert.equal(report.paused, true);
	assert.equal(report.scheduling, "running");
	assert.deepEqual(
		report.entries.items.map((item) => [item.kind, item.summary]),
		[
			["pi.user", "hi"],
			["pi.assistant", "hello"],
		],
	);
	assert.deepEqual([report.entries.returned, report.entries.hasMore], [2, false]);
	// Conversation 2 work is not part of conversation 1's trace.
	assert.deepEqual(report.tasks.map((task) => task.id), [10]);
	assert.deepEqual(report.submissions.map((submission) => submission.id), [20]);
	assert.deepEqual(report.usage, { input: 11, output: 6, totalTokens: 17, cost: 1 });
	assert.equal(lifecycle.traces, 1);
});

test("inspect refuses a conversation that does not exist", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);

	await assert.rejects(
		agent.inspect({ conversationId: 9 as ConversationId, limit: 10 }),
		UnknownConversationError,
	);
});

test("inspectEntry returns the messages the model saw, unabridged", async () => {
	const messages: EntryRecord["model"] = [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "# notes\nline two" }],
			isError: false,
			timestamp: 1_004,
			durationMs: 12,
		},
	];
	const lifecycle = new FakeLifecycle(
		fakeTraceSource([
			{ id: 4 as EntryId, conversationId: 1 as ConversationId, kind: "pi.tool-result", model: messages, data: { diagnostics: [] } },
		]),
	);
	const { agent } = await makeAgent(lifecycle);

	const detail = await agent.inspectEntry(4 as EntryId);

	assert.deepEqual(detail, {
		id: 4,
		kind: "pi.tool-result",
		messages,
		data: { diagnostics: [] },
	});
	assert.equal(lifecycle.traces, 1);
});

test("inspectEntry refuses an id outside the conversation", async () => {
	const lifecycle = new FakeLifecycle();
	const { agent } = await makeAgent(lifecycle);

	await assert.rejects(agent.inspectEntry(99 as EntryId), UnknownEntryError);
});

test("inspectEntry keeps a thinking block the report collapses", async () => {
	const thinking: ThinkingContent = { type: "thinking", thinking: "the user wants the listing first" };
	const message: AssistantMessage = {
		role: "assistant",
		content: [thinking, { type: "text", text: "done" }],
		api: "openai-completions",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_005,
	};
	const entries: EntryRecord[] = [
		{ id: 5 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [message] },
	];
	const { agent } = await makeAgent(new FakeLifecycle(fakeTraceSource(entries)));

	const report = (await agent.inspect({ limit: 10 })) as TraceReport;
	const detail = await agent.inspectEntry(5 as EntryId);

	assert.equal(report.entries.items[0]?.summary, "[thinking] done");
	assert.deepEqual(detail.messages[0]?.content, [thinking, { type: "text", text: "done" }]);
});

test("inspect projects the structured decision fields the graph view reads", async () => {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "list first, then read" },
			{ type: "toolCall", id: "call-1", name: "list_dir", arguments: { path: "." } },
			{ type: "toolCall", id: "call-2", name: "read_file", arguments: { path: "a.txt" } },
		],
		api: "openai-completions",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1_010,
		durationMs: 40,
	};
	const result: EntryRecord = {
		id: 6 as EntryId,
		conversationId: 1 as ConversationId,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "list_dir",
				content: [{ type: "text", text: "a.txt" }],
				isError: false,
				timestamp: 1_011,
				durationMs: 12,
			},
		],
	};
	const { agent } = await makeAgent(
		new FakeLifecycle(
			fakeTraceSource([
				{ id: 5 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [assistant] },
				result,
			]),
		),
	);

	const report = (await agent.inspect({ limit: 10 })) as TraceReport;

	assert.deepEqual(report.entries.items[0], {
		id: 5,
		kind: "pi.assistant",
		at: 1010,
		summary: "[thinking] tool:list_dir tool:read_file",
		role: "assistant",
		tools: ["list_dir", "read_file"],
		stopReason: "toolUse",
		model: "faux-1",
	});
	assert.deepEqual(report.entries.items[1], {
		id: 6,
		kind: "pi.tool-result",
		at: 1011,
		summary: "a.txt",
		role: "toolResult",
		toolName: "list_dir",
		isError: false,
		durationMs: 12,
	});
});

test("parseTraceQuery defaults, clamps, and refuses invalid input", () => {
	assert.deepEqual(parseTraceQuery(new URLSearchParams()), { conversationId: undefined, limit: DEFAULT_TRACE_LIMIT });
	assert.deepEqual(parseTraceQuery(new URLSearchParams("conversation=3&limit=999")), {
		conversationId: 3 as ConversationId,
		limit: MAX_TRACE_LIMIT,
	});
	assert.deepEqual(parseTraceQuery(new URLSearchParams("report=citations")), {
		conversationId: undefined,
		limit: DEFAULT_TRACE_LIMIT,
		report: "citations",
	});
	assert.throws(() => parseTraceQuery(new URLSearchParams("conversation=0")), InvalidTraceQueryError);
	assert.throws(() => parseTraceQuery(new URLSearchParams("limit=abc")), InvalidTraceQueryError);
	assert.throws(() => parseTraceQuery(new URLSearchParams("report=bogus")), InvalidTraceQueryError);
});
