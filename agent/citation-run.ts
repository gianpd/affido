import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	Session,
	ToolExecutionApi,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { Annotation } from "./citation-store.ts";
import type { ArtifactBaseline } from "./artifacts.ts";

export type CitationRunState = {
	runId: string;
	strict: boolean;
	prompt: string;
	/** Verified annotations by citationId. What is annotated is declared used. */
	annotations: Record<string, Annotation>;
	annotateRejections: Record<string, number>;
	publishRejections: Record<string, number>;
	/** Corpus tool calls of this run; the turn budget refuses past the cap. */
	corpusCalls: number;
	published: { markdown: string; citationIds: string[] } | null;
	plain: string | null;
	/** Why a strict run ended without an exit (bounce cap, fault, abort). */
	endedReason: string | null;
	/** Snapshot of `artifacts/` at admission (RFC 0009 §5.7): the baseline the
	 * response's artifact list is diffed against. Written once, when the run is
	 * fresh; a replay keeps the original so the list stays derivable. Runs stored
	 * before the field existed read as `undefined` and are treated as empty. */
	artifactBaseline?: ArtifactBaseline;
};

const emptyRun = (runId: string, strict: boolean, prompt: string): CitationRunState => ({
	runId,
	strict,
	prompt,
	annotations: {},
	annotateRejections: {},
	publishRejections: {},
	corpusCalls: 0,
	published: null,
	plain: null,
	endedReason: null,
});

export type RunSeed = { readonly runId: string; readonly strict: boolean; readonly prompt: string };

/** Per-run state, keyed by the submission's requestId. */
export const CitationRunDocs = defineDocFamily<CitationRunState, RunSeed>({
	scope: "conversation",
	history: "latest",
	fork: "current",
	family: true,
	kind: "citations.run",
	version: 1,
	initial: (seed) => emptyRun(seed.runId, seed.strict, seed.prompt),
});

/** The run the current submission placed; tools and hooks read this pointer.
 * RFC 0016 §7 adds the per-run web authorisation: `web` is the user's choice,
 * `webToken` is the node's registration token (null when web was not requested
 * or the node was unavailable). Neither is ever writable by the model. */
export const CurrentRunDoc = defineDoc<{
	runId: string | null;
	strict: boolean;
	web: boolean;
	webToken: string | null;
}>({
	scope: "conversation",
	history: "latest",
	fork: "current",
	kind: "citations.current",
	version: 1,
	initial: () => ({ runId: null, strict: false, web: false, webToken: null }),
});

export type CurrentRun = {
	readonly runId: string;
	readonly strict: boolean;
	/** The user allowed web for this run. */
	readonly web: boolean;
	/** The node's per-run token; null means web is not usable in this run. */
	readonly webToken: string | null;
};

/** Committed document reads with the full snapshot overloads (as `Session` declares them). */
export type DocReader = Pick<Session, "snapshot">;

/** The run pointer as `prompt()` last set it; `null` before any submission. */
export const readCurrentRun = async (
	reader: DocReader,
	conversationId: ConversationId,
	context: Context,
): Promise<CurrentRun | null> => {
	const pointer = await reader.snapshot(CurrentRunDoc, conversationId, context);
	if (pointer === undefined || pointer.runId === null) return null;
	// Documents stored before RFC 0016 have neither field: absent means "web off".
	return { runId: pointer.runId, strict: pointer.strict, web: pointer.web === true, webToken: pointer.webToken ?? null };
};

/** One run's state as stored, or `undefined` when the run id never existed. */
export const readRun = async (
	reader: DocReader,
	conversationId: ConversationId,
	runId: string,
	context: Context,
): Promise<CitationRunState | undefined> => reader.snapshot(CitationRunDocs, conversationId, runId, context);

/** Mutate one run inside the caller's commit; creates the doc when absent. */
export const mutateRunInTx = async (
	tx: Tx,
	conversationId: ConversationId,
	seed: RunSeed,
	mutate: (run: CitationRunState) => void,
): Promise<void> => {
	const run = await tx.doc(CitationRunDocs, conversationId, seed.runId, seed);
	mutate(run);
};

/** Mutate one run in its own commit; tool bodies use this. */
export const mutateRun = async (
	api: ToolExecutionApi,
	seed: RunSeed,
	mutate: (run: CitationRunState) => void,
	context: Context,
): Promise<void> => {
	await api.commit((tx) => mutateRunInTx(tx, api.conversationId, seed, mutate), context);
};

/** Place the pointer at admission time. Called by `prompt()` before `submit()`.
 * Returns the run's effective artifact baseline: the one just taken when the
 * run is fresh, the stored one on an idempotent replay. */
export type WebRunGrant = { readonly web: boolean; readonly webToken: string | null };

export const placeCurrentRun = async (
	conversation: Conversation,
	runId: string,
	strict: boolean,
	prompt: string,
	artifactBaseline: ArtifactBaseline,
	web: WebRunGrant,
	context: Context,
): Promise<ArtifactBaseline> =>
	conversation.commit(async (tx) => {
		const pointer = await tx.doc(CurrentRunDoc, conversation.id);
		pointer.runId = runId;
		pointer.strict = strict;
		pointer.web = web.web;
		pointer.webToken = web.webToken;
		const run = await tx.doc(CitationRunDocs, conversation.id, runId, { runId, strict, prompt });
		// A replayed requestId (idempotent submit) must not reset the run: only a
		// doc that never accumulated anything takes the prompt. The artifact
		// baseline has its own rule (RFC 0009 §5.7): written once at the first
		// admission, never overwritten — a replay re-derives its artifact list
		// against the baseline of the run that actually did the work. Runs stored
		// before the field existed read as undefined and take the current snapshot,
		// which is correct: they predate artifacts.
		if (run.corpusCalls === 0 && run.published === null && run.plain === null && Object.keys(run.annotations).length === 0) {
			run.prompt = prompt;
			run.strict = strict;
		}
		if (run.artifactBaseline === null || run.artifactBaseline === undefined) {
			run.artifactBaseline = artifactBaseline;
		}
		// Plain data out: the returned object must not keep the commit's overlay alive.
		return Object.fromEntries(
			Object.entries(run.artifactBaseline ?? {}).map(([path, stats]) => [path, { size: stats.size, mtimeMs: stats.mtimeMs }]),
		);
	}, context);
