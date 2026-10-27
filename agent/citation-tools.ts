// The citation tools of RFC 0006 §5.3: grep, read, annotate, publish, plain.
// Five `defineTool()` registrations installed beside CodingTools, one strict
// prompt section that renders only inside a strict run, and one generation hook
// that bounces plain-text answers back to the gate.

import type { Context } from "@earendil-works/chord";
import { normalize } from "node:path";
import { defineExtension, defineTool, hook, section } from "@earendil-works/pi-durable";
import { GenerationTask, ToolTask } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	DEFAULT_GREP_LIMIT,
	DEFAULT_RADIUS,
	DEFAULT_READ_CHARS,
	evaluatePublish,
	VerifyError,
	type CitationStore,
} from "./citation-store.ts";
import { CurrentRunDoc, mutateRun, readCurrentRun, readRun, type CurrentRun } from "./citation-run.ts";

export const MAX_CORPUS_CALLS = 48;
const MAX_YIELD_BOUNCES = 2;

const BOUNCE_MESSAGE =
	"This is a strict-citations run: a plain-text answer is not an exit. Call answer_publish " +
	"with your markdown and citationIds (every non-heading line carries at least one [cit_...] token), " +
	"or answer_plain only if you consulted no document evidence at all.";

/** JSON tool outputs, stable shape so a scripted model (and the e2e) can parse them. */
const json = (value: unknown): [{ readonly type: "text"; readonly text: string }] => [
	{ type: "text", text: JSON.stringify(value) },
];

const rejection = (error: VerifyError): ToolExecutionResult => ({
	isError: true,
	output: json({ error: error.reason, detail: error.detail }),
});

/** The run the current submission placed; corpus tools need it, exits enforce on it. */
const requireRun = async (api: ToolExecutionApi, context: Context): Promise<CurrentRun> => {
	const run = await readCurrentRun(api, api.conversationId, context);
	if (run === null) throw new VerifyError("not_a_strict_run", "no current run; the corpus tools serve a /prompt submission");
	return run;
};

/** Count one corpus call; refuse past the budget. */
const spendCall = async (api: ToolExecutionApi, run: CurrentRun, context: Context): Promise<void> => {
	let allowed = false;
	await mutateRun(
		api,
		{ runId: run.runId, strict: run.strict, prompt: "" },
		(state) => {
			state.corpusCalls += 1;
			allowed = state.corpusCalls <= MAX_CORPUS_CALLS;
		},
		context,
	);
	if (!allowed) throw new VerifyError("turn_budget_exhausted", `the run already spent its corpus-call budget of ${MAX_CORPUS_CALLS}`);
};

const catchVerify = async (body: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
	try {
		return await body();
	} catch (error) {
		if (error instanceof VerifyError) return rejection(error);
		throw error;
	}
};

export type CitationToolDeps = { readonly store: CitationStore; readonly workspace: string };

/** The workspace tools the strict gate refuses (§5.7.1). */
const WORKSPACE_TOOLS = new Set(["bash", "read", "write", "edit"]);

const STRICT_BLOCK =
	"bash, read, write and edit are disabled in this strict-citations run: use " +
	"corpus_grep and corpus_read; only the citation index is evidence";

const CORPUS_BLOCK =
	"corpus/ is the citation registry: documents enter it only through ingestion, never " +
	"through write or edit; write outside corpus/ instead";

/** Whether a model-supplied `write`/`edit` path argument names `corpus/**`. The
 * argument is a single structured path (already confined to the workspace by
 * the execution env), so a normalized prefix check is exact — the same shape
 * that makes a path filter impossible for `bash` makes it trivial here. */
const isCorpusPath = (path: string, workspace: string): boolean => {
	let candidate = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " "); // mirror the tools' normalization
	if (candidate.startsWith("@")) candidate = candidate.slice(1);
	if (candidate.startsWith("/")) {
		const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
		if (!candidate.startsWith(root)) return false; // outside the workspace: the env refuses it
		candidate = candidate.slice(root.length);
	}
	const first = normalize(candidate).split("/")[0] ?? "";
	return first === "corpus";
};

/** The two always-checked tool rules of RFC 0014 §5.7, one `beforeTool` hook:
 * (1) `write`/`edit` refuse `corpus/**` in every run — a blocked call returns a
 * named error and lands in the durable trace, where the friction is measurable
 * like every other rejection; (2) while the current run is strict, the
 * workspace tools are refused outright: the only readable evidence is the
 * citation index. The hook reads the same run pointer the strict section
 * reads, so the gate is per-submission exactly like the gate it protects. */
const toolGate = ({ workspace }: { readonly workspace: string }) =>
	hook(ToolTask, {
		async beforeTool(call, api, context) {
			if (call.name === "write" || call.name === "edit") {
				const path = (call.arguments as Record<string, unknown>).path;
				if (typeof path === "string" && isCorpusPath(path, workspace)) return { block: CORPUS_BLOCK };
			}
			if (WORKSPACE_TOOLS.has(call.name)) {
				const run = await readCurrentRun(api, api.conversationId, context);
				if (run !== null && run.strict) return { block: STRICT_BLOCK };
			}
			return undefined;
		},
	});

const grepTool = ({ store }: CitationToolDeps) =>
	defineTool({
		name: "corpus_grep",
		description:
			"Regex search over the lines of the uploaded corpus documents. Returns each hit with the document id, " +
			"the 1-based line number, the full line, and the code-point span of the first match. A match must start " +
			"within the first 1000 characters of a line. Use it to find where the corpus talks about something.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regular expression, applied per line" }),
			docIds: Type.Optional(Type.Array(Type.String(), { description: "Restrict the search to these document ids" })),
			limit: Type.Optional(Type.Number({ description: `Maximum hits (1-${100}, default ${DEFAULT_GREP_LIMIT})` })),
		}),
		async execute(args, api, context) {
			return catchVerify(async () => {
				const run = await requireRun(api, context);
				await spendCall(api, run, context);
				const result = await store.grepLines({ pattern: args.pattern, docIds: args.docIds, limit: args.limit });
				return { output: json(result) };
			});
		},
	});

const readTool = ({ store }: CitationToolDeps) =>
	defineTool({
		name: "corpus_read",
		description:
			"A bounded window of one corpus document, located by exact needle text or a 1-based line range. " +
			"Returns the text, its absolute code-point span, and a per-line offset table; quote from this output " +
			"exactly when annotating. A bare read never dumps a document: pass needle or lineRange.",
		parameters: Type.Object({
			docId: Type.String({ description: "Document id from corpus_grep" }),
			version: Type.Optional(Type.Number({ description: "Document version; default the current one" })),
			needle: Type.Optional(Type.String({ description: "Exact text to locate (copied from a grep hit)" })),
			// Not Type.Tuple: tuple schemas emit draft-4 array-form `items`, which
			// 2020-12 validators (DeepSeek) reject — "is not of types \"boolean\",
			// \"object\"" — before the first token. A bounded number-array is the
			// same wire contract and valid in every draft; readWindow tolerates a
			// short array anyway (workspace-store.ts readWindow).
			lineRange: Type.Optional(
				Type.Array(Type.Number(), { minItems: 2, maxItems: 2, description: "1-based [first, last] line" }),
			),
			radius: Type.Optional(Type.Number({ description: `Characters of context around the anchor (default ${DEFAULT_RADIUS}, max 4000)` })),
			maxChars: Type.Optional(Type.Number({ description: `Window cap (default ${DEFAULT_READ_CHARS}, max 16000)` })),
		}),
		async execute(args, api, context) {
			return catchVerify(async () => {
				const run = await requireRun(api, context);
				await spendCall(api, run, context);
				// Schema-level exactly-2 (minItems/maxItems) is enforced before execute;
				// the narrowing only satisfies noUncheckedIndexedAccess for number[].
				const [firstLine, lastLine] = args.lineRange ?? [];
				const lineRange =
					firstLine !== undefined && lastLine !== undefined ? ([firstLine, lastLine] as const) : undefined;
				const window = await store.readWindow({
					docId: args.docId,
					version: args.version,
					needle: args.needle,
					lineRange,
					radius: args.radius,
					maxChars: args.maxChars,
				});
				return { output: json(window) };
			});
		},
	});

const annotateTool = ({ store }: CitationToolDeps) =>
	defineTool({
		name: "corpus_annotate",
		description:
			"Declare reliance on a quote: the server locates the text, verifies it is an exact span of the stated " +
			"version, and returns the span and a citationId. Copy the quote exactly from corpus_read output. " +
			"A rejected quote (quote_mismatch, not_found, quote_too_long) writes nothing and is not evidence.",
		parameters: Type.Object({
			docId: Type.String(),
			docVersion: Type.Number({ description: "The version corpus_read reported" }),
			kind: Type.String({ description: 'Citation kind; "quote" is the only evidence kind' }),
			citation: Type.Object({
				text: Type.String({ description: "The quote, copied exactly (max 1000 characters)" }),
			}),
		}),
		async execute(args, api, context) {
			return catchVerify(async () => {
				const run = await requireRun(api, context);
				await spendCall(api, run, context);
				let annotation;
				try {
					annotation = await store.annotate({
						runId: run.runId,
						docId: args.docId,
						docVersion: args.docVersion,
						kind: args.kind,
						quote: args.citation.text,
					});
				} catch (error) {
					if (error instanceof VerifyError) {
						await mutateRun(
							api,
							{ runId: run.runId, strict: run.strict, prompt: "" },
							(state) => {
								state.annotateRejections[error.reason] = (state.annotateRejections[error.reason] ?? 0) + 1;
							},
							context,
						);
					}
					throw error;
				}
				await mutateRun(
					api,
					{ runId: run.runId, strict: run.strict, prompt: "" },
					(state) => {
						state.annotations[annotation.citationId] = annotation;
					},
					context,
				);
				return {
					output: json({
						citationId: annotation.citationId,
						docId: annotation.docId,
						docVersion: annotation.docVersion,
						start: annotation.start,
						end: annotation.end,
						textSha256: annotation.textSha256,
					}),
				};
			});
		},
	});

const publishTool = ({ store: _store }: CitationToolDeps) =>
	defineTool({
		name: "answer_publish",
		description:
			"Publish the evidence-backed reply; the only way out for an answer that used documents. The gate rejects " +
			"an uncited non-heading line, an undeclared token, an unused/unknown/unverified/foreign citationId; every " +
			"rejection names the reason and writes nothing. On success the reply is fixed and the turn ends.",
		parameters: Type.Object({
			markdown: Type.String({ description: "The reply; every non-heading, non-blank line carries at least one [cit_...] token" }),
			citationIds: Type.Array(Type.String(), { description: "Every citationId the reply uses; declared ids must equal the tokens used" }),
		}),
		async execute(args, api, context) {
			return catchVerify(async () => {
				const run = await requireRun(api, context);
				const state = await readRun(api, api.conversationId, run.runId, context);
				if (state === undefined) throw new VerifyError("not_a_strict_run", `run ${run.runId} has no state`);
				const check = evaluatePublish({
					markdown: args.markdown,
					declared: args.citationIds,
					annotations: Object.values(state.annotations),
					runId: run.runId,
				});
				if (!check.ok) {
					const error = new VerifyError(check.reason, check.detail);
					await mutateRun(
						api,
						{ runId: run.runId, strict: run.strict, prompt: "" },
						(s) => {
							s.publishRejections[check.reason] = (s.publishRejections[check.reason] ?? 0) + 1;
						},
						context,
					);
					return rejection(error);
				}
				await mutateRun(
					api,
					{ runId: run.runId, strict: run.strict, prompt: "" },
					(state) => {
						state.published = { markdown: args.markdown, citationIds: [...args.citationIds] };
					},
					context,
				);
				return { output: json({ status: "published", citationIds: args.citationIds }), control: { terminate: true } };
			});
		},
	});

const plainTool = ({ store: _store }: CitationToolDeps) =>
	defineTool({
		name: "answer_plain",
		description:
			"Publish a reply that used no document evidence. Rejected with citations_unused when the run has any " +
			"verified annotation: what you annotated is what you declare you used, in the reply itself.",
		parameters: Type.Object({
			markdown: Type.String({ description: "The reply without citation tokens" }),
		}),
		async execute(args, api, context) {
			return catchVerify(async () => {
				const run = await requireRun(api, context);
				const state = await readRun(api, api.conversationId, run.runId, context);
				if (state === undefined) throw new VerifyError("not_a_strict_run", `run ${run.runId} has no state`);
				if (run.strict && Object.keys(state.annotations).length > 0) {
					const error = new VerifyError("citations_unused", `${Object.keys(state.annotations).length} verified annotations exist; publish through answer_publish`);
					await mutateRun(
						api,
						{ runId: run.runId, strict: run.strict, prompt: "" },
						(s) => {
							s.publishRejections.citations_unused = (s.publishRejections.citations_unused ?? 0) + 1;
						},
						context,
					);
					return rejection(error);
				}
				await mutateRun(
					api,
					{ runId: run.runId, strict: run.strict, prompt: "" },
					(state) => {
						state.plain = args.markdown;
					},
					context,
				);
				return { output: json({ status: "published_plain" }), control: { terminate: true } };
			});
		},
	});

/** The strict contract (§5.3), rendered only while the current run is strict. */
const strictSection = () =>
	section("citations-strict", async (input, context) => {
		const pointer = await input.read.snapshot(CurrentRunDoc, input.conversationId, context);
		if (pointer?.strict !== true) return undefined;
		return (
			"This run is under strict citations: the reply exists only through a tool call, and the server verifies every citation.\n" +
			"- Answer document questions only from the corpus through corpus_grep and corpus_read; never from memory, and never from a document id or filename alone.\n" +
			"- Documents that corpus_grep cannot see are not evidence; never back a claim with them.\n" +
			"- To use evidence, copy the exact text from corpus_read output and declare it with corpus_annotate; you get back a citationId.\n" +
			"- End every reply with answer_publish: markdown where every non-heading, non-blank line carries at least one [cit_...] token, and citationIds listing exactly the tokens you used. Grouped tokens like [cit_a; cit_b] count.\n" +
			"- If you consulted no document evidence at all, end with answer_plain instead; it is rejected with citations_unused if you annotated anything.\n" +
			"- If the corpus lacks the evidence, publish `UNANSWERED: <what is missing>` through answer_publish with no citations, or answer_plain.\n" +
			"- A citation proves attribution, not truth."
		);
	});

/** Bounce plain-text final answers in a strict run back to the gate (§5.5).
 * Each bounce hands the run to a successor generation task whose memos start
 * empty, so the counter cannot live in one memo across yields.
 * `beforeRequest` of every generation sees the whole model context — the
 * bounce continuations included — and records how many came before; `onYield`
 * reads that count (same task, so the memo is shared) and lets the next prose
 * answer end the run instead of bouncing forever. */
const strictBounceHooks = () => [
	hook(GenerationTask, {
		async beforeRequest(request, api, context) {
			const run = await readCurrentRun(api, api.conversationId, context);
			if (run === null || !run.strict) return undefined;
			let seen = 0;
			for (const message of request.messages) {
				if (message.role !== "user") continue;
				const text =
						typeof message.content === "string"
							? message.content
							: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				if (text.includes(BOUNCE_MESSAGE)) seen += 1;
			}
			await api.memo("citations.bounces.seen", seen, context);
			return undefined;
		},
	}),
	hook(GenerationTask, {
		async onYield(_answer, api, context) {
			const run = await readCurrentRun(api, api.conversationId, context);
			if (run === null || !run.strict) return undefined;
			const state = await readRun(api, api.conversationId, run.runId, context);
			if (state === undefined || state.published !== null || state.plain !== null) return undefined;
			const seen = (await api.memo<number>("citations.bounces.seen", context)) ?? 0;
			if (seen >= MAX_YIELD_BOUNCES) return undefined; // let it end; the envelope reports evidence "none"
			return { continue: BOUNCE_MESSAGE };
		},
	}),
];

/** The extension `ContainerAgent` installs beside CodingTools. */
export const citationExtension = (deps: CitationToolDeps): Extension =>
	defineExtension({
		name: "citations",
		sections: [strictSection()],
		tools: [grepTool(deps), readTool(deps), annotateTool(deps), publishTool(deps), plainTool(deps)],
		hooks: [...strictBounceHooks(), toolGate(deps)],
	});
