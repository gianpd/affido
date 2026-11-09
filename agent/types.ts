// Shared types of the agent server.

import type { IncomingMessage } from "node:http";
import type { Context } from "@earendil-works/chord";
import type { AgentChange, EntryId, HarnessOptions, ModelRef } from "@earendil-works/pi-durable";
import type { CredentialStore, ModelThinkingLevel, MutableModels } from "@earendil-works/pi-ai";
import type { HarnessLifecycle } from "./harness.ts";
import type { CitationJudge, JudgeMode } from "./citation-judge.ts";
import type { CitationRunReport, CitationsTraceReport } from "./citation-report.ts";
import type { ArtifactView } from "./artifacts.ts";
import type { TraceEntryDetail, TraceQuery, TraceReport } from "./trace.ts";
import type { StorageReport } from "./storage.ts";

/** RFC 0022: the per-sandbox disk quota. The agent and the HTTP tools share
 * one instance, so a write through either path invalidates the same measurement. */
export interface StorageQuotaPort {
	report(): Promise<StorageReport>;
	ensureCapacity(requestedBytes: number): Promise<StorageReport>;
	invalidate(): void;
}

export type Log = (...args: unknown[]) => void;

/** One provider choice: the shared model collection plus the model the agent runs on.
 * The credential store rides along so POST /config can rotate the key at
 * runtime (RFC 0012 §5.4); it is in-memory only (R3). */
export type ModelBundle = {
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly model: ModelRef;
};

/** The POST /config payload (RFC 0012 §5.4, amended by RFC 0013 §5): the
 * desired runtime state the manager reconciles. `apiKey`/`baseUrl` are absent
 * for faux; a `viaSidecar` delivery carries the key's provider and model but
 * never the key itself — that half went to the sidecar. */
export type ProviderConfig = {
	readonly provider: string;
	readonly modelId: string;
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly viaSidecar?: boolean;
};

export type AgentOptions = {
	readonly name: string;
	readonly workspace: string;
	readonly sessionDb: string;
	readonly idleMs: number;
	readonly models: MutableModels;
	/** The in-memory credential store the models collection resolves through;
	 * POST /config rotates it (RFC 0012 §5.4). */
	readonly credentials: CredentialStore;
	readonly model: ModelRef;
	/**
	 * Reasoning effort requested from the provider. Absent means `off`, which sends
	 * no `reasoning` field and stores no thinking.
	 */
	readonly thinkingLevel?: ModelThinkingLevel;
	/** Mode for submissions that omit the `citations` field (RFC 0006 §5.9). */
	readonly citationsDefault?: CitationMode;
	/** RFC 0017: the post-gate coherence judge and its mode. `judge: null`
	 * (default) leaves the layer absent; the deterministic gate is unchanged. */
	readonly judge?: CitationJudge | null;
	readonly judgeMode?: JudgeMode;
	readonly context: Context;
	readonly log: Log;
	/** RFC 0022: shared disk quota; absent in tests that inject a fake lifecycle. */
	readonly storageQuota?: StorageQuotaPort;
	/** Lifecycle to run on; defaults to a DurableHarness built from these options. */
	readonly harness?: HarnessLifecycle;
};

/** Options of `Harness.root()`: `agent` applies only when it creates the conversation. */
export type RootOptions = { readonly agent?: AgentChange };

export type DurableHarnessOptions = {
	readonly openOptions: HarnessOptions;
	readonly rootOptions: RootOptions;
	readonly context: Context;
	readonly sessionDb: string;
	readonly idleMs: number;
	readonly log: Log;
};

/** How strictly a `/prompt` submission answers (RFC 0006 §5.9). */
export type CitationMode = "required" | "off";

/** RFC 0016 §7: whether the user authorised web search for one submission.
 * Default `"off"`; the model can never set it. */
export type WebMode = "allowed" | "off";

/** One citation of a reply, as the envelope reports it (R6). */
export type CitationView = {
	readonly citationId: string;
	readonly docId: string;
	readonly title: string;
	readonly filename: string;
	readonly version: number;
	readonly start: number;
	readonly end: number;
	readonly line: number;
	readonly quote: string;
	readonly textSha256: string;
	readonly status: "attribution_verified" | string;
};

/** Why a run ended `unanswered` with an upstream failure, when the sandbox
 * itself answered. The sandbox being unreachable never produces an envelope:
 * the web tier sees a failed fetch and reports it as a `SandboxError`. */
export type PromptFailure = {
	readonly kind: "provider_timeout" | "provider_unreachable";
	/** The provider id the run was configured with (`deepseek`, `custom`, …). */
	readonly provider: string;
	/** The sidecar's transport cause: `no_response`, `dns_failure`,
	 * `connect_timeout`, `connect_failure`, `tls_failure`, `network_error`;
	 * null when the error body carried none. */
	readonly reason: string | null;
};

/** The `/prompt` response envelope. `evidence` is produced by the server, never typed by the model. */
export type PromptResult = {
	readonly agent: string;
	readonly status: string;
	readonly reason: string | null;
	/** The settlement's stored detail, e.g. the provider error behind `model_error`. */
	readonly reasonDetail: string | null;
	/** The classified upstream failure, or null when the run failed for another
	 * reason (bad key, quota, context overflow) or did not fail. */
	readonly failure: PromptFailure | null;
	readonly answer: string | null;
	readonly submissionId: number;
	readonly requestId: string | null;
	readonly conversationId: number;
	readonly entries: number;
	/** `cited`: published through the gate; `plain`: no document evidence; `none`: strict run ended unpublished. */
	readonly evidence: "cited" | "plain" | "none";
	readonly evidenceReason: string | null;
	readonly citations: readonly CitationView[];
	/** The mode this submission ran under. */
	readonly citationsMode: "required" | "free";
	/** The web authorisation of this submission, as the user chose it. */
	readonly webMode: WebMode;
	readonly runId: string | null;
	/** Files this run created or changed under `artifacts/` (RFC 0009 R7),
	 * server-built like `evidence`: re-derived from disk at response time. */
	readonly artifacts: readonly ArtifactView[];
};

/** `GET /corpus/citations?runId=`: the run's citations, each re-verified against the stored text (R11). */
export type RunCitations = {
	readonly agent: string;
	readonly runId: string;
	readonly strict: boolean;
	readonly published: boolean;
	readonly citations: readonly (CitationView & { readonly status: string })[];
};

/** The agent surface the HTTP tools drive; `ContainerAgent` is the implementation. */
export interface AgentApi {
	readonly name: string;
	status(): unknown;
	session(): Promise<unknown>;
	listDir(path: string): Promise<unknown>;
	readFile(path: string): Promise<unknown>;
	inspect(query: TraceQuery): Promise<TraceReport | CitationsTraceReport>;
	inspectEntry(id: EntryId): Promise<TraceEntryDetail>;
	prompt(
		prompt: string,
		requestId: string | undefined,
		citations: CitationMode | undefined,
		web?: WebMode,
	): Promise<PromptResult>;
	/** One run's citations, re-verified (R11). */
	citations(runId: string): Promise<RunCitations>;
	/** The corpus changed (ingest/delete); drop the store's lazy index. */
	noteCorpusChange(): void;
	/** RFC 0016 §6: whether this conversation ever read web content. `true`
	 * blocks ingest/upload/skill installation for that conversation. */
	webTainted(): Promise<boolean>;
	/** Start a separate conversation and make it the active one; nothing of the old one is deleted. */
	newSession(): Promise<unknown>;
	/** Make an existing conversation the active one (RFC 0008); unknown ids are rejected. */
	switchSession(conversationId: number): Promise<unknown>;
	/** Apply a delivered provider config (RFC 0012 §5.4): credential upsert,
	 * provider upsert, conversation reconfigure — serialized with prompts. */
	configureModel(config: ProviderConfig): Promise<unknown>;
	/** RFC 0016 §7: the manager delivers the node's control token, in memory
	 * only. Without it no run can be registered for web. */
	configureWeb(controlToken: string): Promise<unknown>;
	reset(): Promise<unknown>;
	pause(): Promise<unknown>;
}

/** One dispatched HTTP request: the raw request, its parsed URL, and the agent it targets. */
export type ToolRequest = {
	readonly req: IncomingMessage;
	readonly url: URL;
	readonly agent: AgentApi;
};
