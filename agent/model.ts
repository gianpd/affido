// Model selection: the BYOK runtime (RFC 0012) plus the legacy standalone path.
// The manager delivers {provider, modelId, apiKey, baseUrl?} to POST /config at
// resolve time; the key lives in the InMemoryCredentialStore only (R3) and
// re-delivery after any restart is the manager's job (§5.4). Standalone image
// runs (no manager) keep the secret-file branch below: API keys come from
// secret files, not environment variables. Default: the bundled faux provider,
// scripted by transcript state, so the demo runs without a key.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { CredentialStore, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import type { ModelBundle } from "./types.ts";
import { citationGateDemoScript } from "./citation-gate-demo.ts";

// Docker Compose mounts each secret as a file here; the API key never enters the process environment.
const SECRET_DIR = process.env.SECRET_DIR ?? "/run/secrets";

export const readSecret = async (name: string): Promise<string | undefined> => {
	try {
		const value = (await readFile(join(SECRET_DIR, name), "utf8")).trim();
		return value === "" ? undefined : value;
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};

/** sha256(key) as 12 hex chars — the only key-derived value any API returns (RFC 0012 §8.3). */
export const keyFingerprint = (apiKey: string): string => createHash("sha256").update(apiKey).digest("hex").slice(0, 12);

/** The catalog built-ins (RFC 0012 §5.1): curated pi-ai factories, keyed by catalog id. */
const BUILTIN_PROVIDERS: Readonly<Record<string, () => Provider>> = {
	openrouter: openrouterProvider,
	openai: openaiProvider,
	deepseek: deepseekProvider,
	groq: groqProvider,
	together: togetherProvider,
	fireworks: fireworksProvider,
	xai: xaiProvider,
	cerebras: cerebrasProvider,
	mistral: mistralProvider,
};

export type ProviderBuild = {
	readonly id: string;
	readonly modelId: string;
	/** Required for non-built-in, non-faux providers (custom endpoints, the e2e fake upstream). */
	readonly baseUrl?: string;
};

/** One model entry of a custom OpenAI-compatible endpoint: conservative
 * defaults, no reasoning, text-only. `compat` stays unset so pi-ai
 * auto-detects quirks from the baseUrl (§3.2). */
const openAICompatModel = (provider: string, id: string, baseUrl: string): Model<"openai-completions"> => ({
	id,
	name: id,
	provider,
	api: "openai-completions",
	baseUrl,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 8_192,
});

/** RFC 0012 §3.2: catalog built-ins resolve to their pi-ai factory (the stored
 * credential supplies the key, §3.3); everything else is an OpenAI-compatible
 * endpoint built with `createProvider` + `openAICompletionsApi()`, registering
 * the delivered modelId as its single model (custom endpoints carry one
 * selection at a time, §5.2). */
export const buildProvider = ({ id, modelId, baseUrl }: ProviderBuild): Provider => {
	const builtin = BUILTIN_PROVIDERS[id];
	if (builtin !== undefined) return builtin();
	if (id === "faux") return fauxProviderScripted();
	if (baseUrl === undefined) throw new Error(`provider "${id}" is neither a catalog built-in nor faux; baseUrl is required`);
	return createProvider({
		id,
		name: id,
		baseUrl,
		auth: { apiKey: envApiKeyAuth(`${id} API key`, []) },
		models: [openAICompatModel(id, modelId, baseUrl)],
		api: openAICompletionsApi(),
	});
};

export type DeliveredConfig = ProviderBuild & {
	/** Absent for faux and for keyless selections; the manager always re-delivers it for real providers (§5.4). */
	readonly apiKey?: string;
};

export type AppliedConfig = {
	readonly model: ModelRef;
	/** Null when no key was delivered; never the key itself. */
	readonly fingerprint: string | null;
};

/** The §5.4 sketch, verbatim order: credentials.modify -> models.setProvider
 * (upsert) -> the caller then pins the conversation with configure(). Mutations
 * apply to subsequent model calls; an in-flight prompt finishes on the old
 * provider (§7.1). */
export const configureProvider = async (
	models: MutableModels,
	credentials: CredentialStore,
	{ id, modelId, baseUrl, apiKey }: DeliveredConfig,
): Promise<AppliedConfig> => {
	if (apiKey !== undefined) await credentials.modify(id, async () => ({ type: "api_key", key: apiKey }));
	models.setProvider(buildProvider({ id, modelId, baseUrl }));
	return { model: { provider: id, modelId }, fingerprint: apiKey === undefined ? null : keyFingerprint(apiKey) };
};

const lastToolResult = (messages: readonly Message[]): { name: string; text: string; isError: boolean } | undefined => {
	const last = messages.at(-1);
	if (last === undefined || last.role !== "toolResult" || !Array.isArray(last.content)) return undefined;
	return {
		name: last.toolName,
		text: last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
		isError: last.isError,
	};
};

/** The newest assistant call of `name`, for scripted follow-ups that need its arguments. */
const lastToolArgs = (messages: readonly Message[], name: string): Record<string, unknown> | undefined => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of [...message.content].reverse()) {
			if (part.type === "toolCall" && part.name === name) return part.arguments as Record<string, unknown>;
		}
	}
	return undefined;
};

const lastUserText = (messages: readonly Message[]): string => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message !== undefined && message.role === "user") {
				return typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			}
	}
	return "";
};

const callId = (step: string): string => `${step}-${Date.now()}`;

// RFC 0009 §5.9: the documents dance. A prompt whose server-built hint resolved
// `/md-to-docx` drives one bash call that builds a small real .docx through the
// baked package (NODE_PATH, no network) into artifacts/ — and plants a symlink,
// so the e2e can assert the download path refuses it. The one-liner is the
// whole chain under the deterministic provider: install, hint, image library,
// artifacts convention, envelope diff.
const DOCX_DANCE =
	"mkdir -p artifacts && node -e '" +
	'const { Document, Packer, Paragraph, TextRun } = require("docx");\n' +
	'const fs = require("fs");\n' +
	"const doc = new Document({ sections: [{ children: [\n" +
	'  new Paragraph({ children: [new TextRun({ text: "Branded proposal", bold: true, size: 52 })] }),\n' +
	'  new Paragraph({ children: [new TextRun({ text: "Prepared with the md-to-docx skill in the durable sandbox.", size: 24 })] }),\n' +
	'] }] });\n' +
	'Packer.toBuffer(doc).then((buffer) => { fs.writeFileSync("artifacts/proposal.docx", buffer); console.log("WROTE artifacts/proposal.docx " + buffer.length); });\n' +
	"' && ln -sf /etc/hostname artifacts/leak && echo DANCED";

// A deterministic citation dance for the e2e suite and the demo: a question
// mentioning "renew" drives grep -> read -> annotate -> answer_publish against
// the staged corpus, so the gate is exercised without a real model. Anything
// else keeps the two-step workspace listing.
const scripted: FauxResponseFactory = (transcript) => {
	const demo = citationGateDemoScript(transcript);
	if (demo !== undefined) return demo;
	const tool = lastToolResult(transcript.messages);
	const userText = lastUserText(transcript.messages);
	// A bounced strict answer exits through answer_plain, exactly as the gate
	// demands; without this the scripted model would loop on prose.
	if (/strict-citations run/i.test(userText)) {
		return fauxAssistantMessage(
			[fauxToolCall("answer_plain", { markdown: "UNANSWERED: the request could not be met with corpus evidence." }, { id: callId("plain") })],
			{ stopReason: "toolUse" },
		);
	}
	// The skill hint is server-built, so these branches key on its exact shape.
	if (userText.includes("[skill hint]") && userText.includes("is not installed")) {
		return fauxAssistantMessage([
			fauxText("That skill is not installed in this sandbox. Answered in plain text without pretending to use it."),
		]);
	}
	if (userText.includes('[skill hint] The user invoked the skill "md-to-docx"')) {
		if (tool?.name === "bash" && !tool.isError) {
			return fauxAssistantMessage([fauxText("Done. The branded proposal is ready to download from artifacts/proposal.docx.")]);
		}
		return fauxAssistantMessage([fauxToolCall("bash", { command: DOCX_DANCE }, { id: callId("docx") })], {
			stopReason: "toolUse",
		});
	}
	// RFC 0014 §5.7.1 e2e/unit dance: a strict prompt that says "with bash first"
	// attempts one workspace-tool call, takes the named block, then proceeds
	// through the corpus tools like every strict run.
	if (userText.includes("with bash first") && tool === undefined) {
		return fauxAssistantMessage([fauxToolCall("bash", { command: "grep -r rinnova corpus" }, { id: callId("bash") })], {
			stopReason: "toolUse",
		});
	}
	if (tool?.name === "bash" && tool.isError && /renew/i.test(userText)) {
		return fauxAssistantMessage([fauxToolCall("corpus_grep", { pattern: "rinnova" }, { id: callId("grep") })], {
			stopReason: "toolUse",
		});
	}
	// A corpus the registry did not admit (or a pattern that matches nothing):
	// the honest strict exit is UNANSWERED through answer_plain, never a citation.
	if (tool?.name === "corpus_grep" && tool.isError) {
		return fauxAssistantMessage(
			[fauxToolCall("answer_plain", { markdown: "UNANSWERED: the corpus does not contain the renewal date." }, { id: callId("plain") })],
			{ stopReason: "toolUse" },
		);
	}
	// RFC 0014 R12 dance: write outside corpus/ succeeds in a free run; a
	// corpus/** target takes the named block and the model gives up in prose.
	if (/write a workspace note/i.test(userText) && tool === undefined) {
		return fauxAssistantMessage(
			[fauxToolCall("write", { path: "workspace/notes.md", content: "note" }, { id: callId("write") })],
			{ stopReason: "toolUse" },
		);
	}
	if (/write into the corpus/i.test(userText) && tool === undefined) {
		return fauxAssistantMessage(
			[fauxToolCall("write", { path: "corpus/uploads/facts.md", content: "fabricated" }, { id: callId("write") })],
			{ stopReason: "toolUse" },
		);
	}
	if (tool?.name === "write" && tool.isError) {
		return fauxAssistantMessage([fauxText("The write was refused: corpus/ is write-protected.")]);
	}
	if (tool?.name === "write" && !tool.isError) {
		return fauxAssistantMessage([fauxText("The note was written.")]);
	}
	if (tool?.name === "corpus_grep" && !tool.isError) {
		const parsed = JSON.parse(tool.text) as { hits: { docId: string; text: string }[] };
		const hit = parsed.hits[0];
		if (hit !== undefined) {
			return fauxAssistantMessage(
				[fauxToolCall("corpus_read", { docId: hit.docId, needle: hit.text }, { id: callId("read") })],
				{ stopReason: "toolUse" },
			);
		}
	}
	if (tool?.name === "corpus_read" && !tool.isError) {
		const readArgs = lastToolArgs(transcript.messages, "corpus_read");
		const docId = readArgs?.docId;
		const quote = readArgs?.needle;
		if (typeof docId === "string" && typeof quote === "string") {
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"corpus_annotate",
						{ docId, docVersion: 1, kind: "quote", citation: { text: quote } },
						{ id: callId("annotate") },
					),
				],
				{ stopReason: "toolUse" },
			);
		}
	}
	if (tool?.name === "corpus_annotate" && !tool.isError) {
		const parsed = JSON.parse(tool.text) as { citationId: string };
		const markdown =
				"## Renewal\n\nThe maintenance contract renews tacitly on 1 March 2027 " +
				`[${parsed.citationId}].\n`;
		return fauxAssistantMessage(
				[fauxToolCall("answer_publish", { markdown, citationIds: [parsed.citationId] }, { id: callId("publish") })],
			{ stopReason: "toolUse" },
		);
	}
	if (/renew/i.test(lastUserText(transcript.messages))) {
		return fauxAssistantMessage(
			[fauxToolCall("corpus_grep", { pattern: "rinnova" }, { id: callId("grep") })],
			{ stopReason: "toolUse" },
		);
	}
	if (tool !== undefined) {
		return fauxAssistantMessage([fauxText(`Result:\n${tool.text}`)]);
	}
	return fauxAssistantMessage([fauxToolCall("bash", { command: "ls -la" }, { id: callId("ls") })], {
		stopReason: "toolUse",
	});
};

/** The faux provider with the shared state-driven scripted factory: one
 * factory per slot, so the one-shot queue is effectively inexhaustible
 * (see the comment in createModel). Shared by the boot default and the
 * /config faux fallback (§5.4 step 5). */
const fauxProviderScripted = (): Provider => {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 1_000_000 }, () => scripted));
	return faux.provider;
};

export const createModel = async (): Promise<ModelBundle> => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const openrouterKey = await readSecret("openrouter_api_key");
	if (openrouterKey !== undefined) {
		const modelId = process.env.OPENROUTER_MODEL;
		if (modelId === undefined) throw new Error("OPENROUTER_MODEL is required when the openrouter_api_key secret is set");
		await credentials.modify("openrouter", async () => ({ type: "api_key", key: openrouterKey }));
		models.setProvider(openrouterProvider());
		return { models, credentials, model: { provider: "openrouter", modelId } };
	}
	const openaiKey = await readSecret("openai_api_key");
	if (openaiKey !== undefined) {
		const modelId = process.env.OPENAI_MODEL;
		if (modelId === undefined) throw new Error("OPENAI_MODEL is required when the openai_api_key secret is set");
		await credentials.modify("openai", async () => ({ type: "api_key", key: openaiKey }));
		models.setProvider(openaiProvider());
		return { models, credentials, model: { provider: "openai", modelId } };
	}
	// The faux queue is one-shot (one entry per model call, never refilled). A
	// durable sandbox outlives any small queue: once empty, every prompt settles
	// `model_error: No more faux responses queued` until the process restarts.
	// One shared, state-driven factory per slot, so the queue is ~8MB of pointers
	// and effectively inexhaustible (a prompt spends two or more calls).
	models.setProvider(fauxProviderScripted());
	return { models, credentials, model: { provider: "faux", modelId: "faux-1" } };
};
