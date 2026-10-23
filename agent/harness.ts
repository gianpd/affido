// The durable lifecycle: open on demand, close when idle.

import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc, Harness as DurableRuntime } from "@earendil-works/pi-durable";
import type { Conversation, ConversationId, Harness, HarnessOptions, ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CitationRunDocs } from "./citation-run.ts";
import type { DurableHarnessOptions, Log, RootOptions } from "./types.ts";
import { UnknownConversationError } from "./trace.ts";
import type { TraceSource } from "./trace.ts";

/** The handler `HarnessLifecycle.activate` runs against the open conversation. */
export type ConversationHandler<T> = (conversation: Conversation) => Promise<T>;

/**
 * The conversation `newSession()` last made active, or `null` until the first
 * switch. Session-scoped, so the pointer lives in `SESSION_DB` and survives
 * pause, restart, and eviction — the active conversation is durable state, never
 * process memory (RFC 0008).
 */
const ActiveConversationDoc = defineDoc<{ conversationId: number | null }>({
	scope: "session",
	kind: "agent.active-conversation",
	version: 1,
	initial: () => ({ conversationId: null }),
});

// The durable lifecycle the agent runs on. `DurableHarness` is the pi-durable
// implementation; `AgentOptions.harness` substitutes another one.
export interface HarnessLifecycle {
	/** Run `handler` against the active conversation, opening it first. Returns the handler's value. */
	activate<T>(handler: ConversationHandler<T>): Promise<T>;
	/** Create a separate conversation, make it the active one durably, and return its id and entry count. */
	newSession(): Promise<{ conversationId: ConversationId; entries: number }>;
	/** Make an existing conversation the active one durably (RFC 0008): the resume path of `newSession`. */
	switchSession(conversationId: ConversationId): Promise<{ conversationId: ConversationId; entries: number }>;
	/** Run `handler` against a read-only trace source, activating first. Never writes. */
	trace<T>(handler: (source: TraceSource) => Promise<T>): Promise<T>;
	/** Close the active conversation now. */
	close(): Promise<void>;
	/** Refresh the cached transcript entry count. */
	refreshStats(): Promise<void>;
	readonly paused: boolean;
	readonly conversationId: ConversationId | null;
	readonly entries: number;
	readonly inFlight: number;
}

export class DurableHarness implements HarnessLifecycle {
	#openOptions: HarnessOptions;
	#rootOptions: RootOptions;
	#context: Context;
	#sessionDb: string;
	#idleMs: number;
	#log: Log;

	#runtime: Harness | undefined;
	#conversation: Conversation | undefined;
	#paused = true;
	#inFlight = 0;
	#entries = 0;
	#idleTimer: NodeJS.Timeout | undefined;
	#chain: Promise<void> = Promise.resolve();

	constructor({ openOptions, rootOptions, context, sessionDb, idleMs, log }: DurableHarnessOptions) {
		this.#openOptions = openOptions;
		this.#rootOptions = rootOptions;
		this.#context = context;
		this.#sessionDb = sessionDb;
		this.#idleMs = idleMs;
		this.#log = log;
	}

	get paused(): boolean {
		return this.#paused;
	}

	get conversationId(): ConversationId | null {
		return this.#conversation?.id ?? null;
	}

	get entries(): number {
		return this.#entries;
	}

	get inFlight(): number {
		return this.#inFlight;
	}

	async activate<T>(handler: ConversationHandler<T>): Promise<T> {
		this.#inFlight++;
		try {
			await this.#serialize(() => this.#open());
			const conversation = this.#conversation;
			if (conversation === undefined) throw new Error("conversation did not open");
			this.#resetIdle();
			return await handler(conversation);
		} finally {
			this.#inFlight--;
			this.#resetIdle();
		}
	}

	async close(): Promise<void> {
		await this.#serialize(() => this.#pause());
	}

	/**
	 * Start a separate conversation and switch to it. Create first, point second:
	 * a crash between the two commits leaves an unused empty conversation and the
	 * pointer still on the old one — the safe direction. Nothing of the previous
	 * conversation is deleted; `/inspect?conversation=` still reads it.
	 */
	async newSession(): Promise<{ conversationId: ConversationId; entries: number }> {
		this.#inFlight++;
		try {
			await this.#serialize(() => this.#open());
			const runtime = this.#runtime;
			if (runtime === undefined) throw new Error("conversation did not open");
			const created = await runtime.createConversation(
				{ ownership: { kind: "ownerless" }, agent: this.#rootOptions.agent },
				this.#context,
			);
			await runtime.commit(async (tx) => {
				const pointer = await tx.doc(ActiveConversationDoc);
				pointer.conversationId = created.id;
			}, this.#context);
			this.#conversation = created;
			await this.refreshStats();
			this.#resetIdle();
			return { conversationId: created.id, entries: this.#entries };
		} finally {
			this.#inFlight--;
			this.#resetIdle();
		}
	}

	/**
	 * Make an existing conversation the active one: the resume path of `newSession`
	 * (RFC 0008). One pointer commit; the conversation, its entries and its chat
	 * rows are untouched. An unknown id is `UnknownConversationError` — a switch
	 * must never fall back to the root by accident.
	 */
	async switchSession(conversationId: ConversationId): Promise<{ conversationId: ConversationId; entries: number }> {
		this.#inFlight++;
		try {
			await this.#serialize(() => this.#open());
			const runtime = this.#runtime;
			if (runtime === undefined) throw new Error("conversation did not open");
			const root = await runtime.root(this.#context, this.#rootOptions);
			const target = conversationId === root.id ? root : await runtime.conversation(conversationId, this.#context);
			if (target === undefined) throw new UnknownConversationError(conversationId);
			await runtime.commit(async (tx) => {
				const pointer = await tx.doc(ActiveConversationDoc);
				pointer.conversationId = target.id;
			}, this.#context);
			this.#conversation = target;
			// The conversation may have been created under an older deployment; the
			// stored `pi.agent` follows the current one whatever becomes active.
			await this.#syncAgent(target);
			await this.refreshStats();
			this.#resetIdle();
			return { conversationId: target.id, entries: this.#entries };
		} finally {
			this.#inFlight--;
			this.#resetIdle();
		}
	}

	async trace<T>(handler: (source: TraceSource) => Promise<T>): Promise<T> {
		return this.activate(async () => {
			const runtime = this.#runtime;
			const active = this.#conversation;
			if (runtime === undefined || active === undefined) throw new Error("trace read without an open runtime");
			const source: TraceSource = {
				conversation: (id) =>
					id === active.id ? Promise.resolve(active) : runtime.conversation(id, this.#context),
				inspect: () => runtime.inspect(this.#context),
				usage: () => runtime.usage(this.#context),
				runState: (conversationId, runId, context) => runtime.snapshot(CitationRunDocs, conversationId, runId, context),
			};
			return handler(source);
		});
	}

	async refreshStats(): Promise<void> {
		const conversation = this.#conversation;
		if (conversation === undefined) throw new Error("conversation is not open");
		const page = await conversation.entries({}, 500, undefined, this.#context);
		this.#entries = page.items.length;
	}

	// Serialize open/close so a timer and a request never interleave.
	#serialize(task: () => Promise<void>): Promise<void> {
		const next = this.#chain.then(task, task);
		this.#chain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async #open(): Promise<void> {
		if (this.#runtime !== undefined) return;
		const storage = await openNodeSqliteStorage(this.#sessionDb);
		const opened = await DurableRuntime.open(storage, this.#openOptions, this.#context);
		this.#runtime = opened;
		// `root()` applies `agent` only when it creates the conversation; the
		// active one may be a conversation `newSession()` created later.
		const root = await opened.root(this.#context, this.#rootOptions);
		const active = await this.#resolveActive(opened, root);
		await this.#syncAgent(active);
		this.#conversation = active;
		opened.resume(); // continue any run the previous process left unfinished
		this.#paused = false;
		this.#log("activated");
	}

	/** The conversation the stored pointer names, or the root when it names none. */
	async #resolveActive(runtime: Harness, root: Conversation): Promise<Conversation> {
		const pointer = await runtime.snapshot(ActiveConversationDoc, this.#context);
		const id = pointer?.conversationId;
		if (id === null || id === undefined || id === root.id) return root;
		return (await runtime.conversation(id as ConversationId, this.#context)) ?? root;
	}

	// `root()` applies `agent` only when it creates the conversation; on reopen the
	// stored `pi.agent` is used. That model is part of the session, so a provider
	// switch (a new secret) would otherwise keep resolving the old, now-unregistered
	// model and answer `no_model`. The thinking level has the same problem: the
	// sandbox keeps its volume across `dev.sh reload`, so a new THINKING_LEVEL would
	// never reach the existing conversation. Follow the deployment for both.
	/** Align the stored `pi.agent` model and thinking level with the deployment. */
	async #syncAgent(conversation: Conversation): Promise<void> {
		const agent = this.#rootOptions.agent;
		const current = await conversation.agent(this.#context);
		const change: { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } = {};
		const model = agent?.model;
		if (model !== undefined && model !== null && (current.model?.provider !== model.provider || current.model?.modelId !== model.modelId)) {
			change.model = model;
		}
		const thinkingLevel = agent?.thinkingLevel;
		if (thinkingLevel !== undefined && thinkingLevel !== null && current.thinkingLevel !== thinkingLevel) {
			change.thinkingLevel = thinkingLevel;
		}
		if (change.model === undefined && change.thinkingLevel === undefined) return;
		await conversation.configure(change, this.#context);
		this.#log("agent updated:", change);
	}

	async #pause(): Promise<void> {
		if (this.#runtime === undefined) return;
		const closing = this.#runtime;
		this.#runtime = undefined;
		this.#conversation = undefined;
		await closing.close(this.#context);
		this.#paused = true;
		this.#log("paused");
	}

	#resetIdle(): void {
		if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			if (this.#inFlight > 0) {
				this.#resetIdle();
				return;
			}
			this.#serialize(() => this.#pause()).catch((error: unknown) => this.#log("pause failed:", error));
		}, this.#idleMs);
		this.#idleTimer.unref();
	}
}
