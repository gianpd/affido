// Model selection: API keys come from secret files, not environment variables.
// Default: the bundled faux provider, scripted by transcript state, so the demo
// runs without a key. Set OPENROUTER_MODEL or OPENAI_MODEL to use a real provider.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelBundle } from "./types.ts";

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
	const tool = lastToolResult(transcript.messages);
	const userText = lastUserText(transcript.messages);
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

export const createModel = async (): Promise<ModelBundle> => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const openrouterKey = await readSecret("openrouter_api_key");
	if (openrouterKey !== undefined) {
		const modelId = process.env.OPENROUTER_MODEL;
		if (modelId === undefined) throw new Error("OPENROUTER_MODEL is required when the openrouter_api_key secret is set");
		await credentials.modify("openrouter", async () => ({ type: "api_key", key: openrouterKey }));
		models.setProvider(openrouterProvider());
		return { models, model: { provider: "openrouter", modelId } };
	}
	const openaiKey = await readSecret("openai_api_key");
	if (openaiKey !== undefined) {
		const modelId = process.env.OPENAI_MODEL;
		if (modelId === undefined) throw new Error("OPENAI_MODEL is required when the openai_api_key secret is set");
		await credentials.modify("openai", async () => ({ type: "api_key", key: openaiKey }));
		models.setProvider(openaiProvider());
		return { models, model: { provider: "openai", modelId } };
	}
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	// The faux queue is one-shot (one entry per model call, never refilled). A
	// durable sandbox outlives any small queue: once empty, every prompt settles
	// `model_error: No more faux responses queued` until the process restarts.
	// One shared, state-driven factory per slot, so the queue is ~8MB of pointers
	// and effectively inexhaustible (a prompt spends two or more calls).
	faux.setResponses(Array.from({ length: 1_000_000 }, () => scripted));
	return { models, model: { provider: "faux", modelId: "faux-1" } };
};
