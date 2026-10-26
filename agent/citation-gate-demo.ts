// A faux-provider transcript for the citation-gate launch recording, and for
// anyone who wants to watch the gate reject a quote without a real model.
//
// This file is a *model*, not a gate. It decides which tool the scripted model
// calls; the corpus tools, the verifier and the publish gate in
// citation-store.ts / citation-tools.ts are the shipped ones and reject or
// accept on their own. Nothing here can make a rejection happen: the script
// only proposes a quote that does not exist in the stored document.
//
// Two questions drive it, and both name the clause so the script can key on the
// question rather than on transcript position:
//
//   "What does clause 7.2 of the vendor agreement say?"
//     propose a tampered quote ("annually" where the agreement says
//     "quarterly") -> corpus_annotate rejects it with quote_mismatch (nothing
//     is written, no citationId is minted) -> answer_publish with the citation
//     id it never got is rejected with unknown_citation -> the model falls back
//     to prose -> the strict hook bounces the plain answer -> the run ends
//     unpublished, and /prompt reports evidence "none".
//
//   "Quote clause 7.2 of the vendor agreement exactly."
//     copy the stored line, annotate it (the server locates the span and mints
//     the id), publish through the gate -> the reply is published with its
//     citation: document, version, line, quote.
//
// Every other prompt falls through to the generic script in model.ts.

import type { AssistantMessage, JsonObject, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

/** The question that opens a demo turn. Both demo questions carry it. */
const DEMO_QUESTION = /clause 7\.2 of the vendor agreement/i;
/** The follow-up that asks the same model to copy the line instead of recalling it. */
const EXACT_QUESTION = /exactly/i;
/** The strict hook's bounce text (citation-tools.ts, BOUNCE_MESSAGE). */
const BOUNCE = /strict-citations run/i;
/** The tamper: the agreement says quarterly, the scripted model "remembers"
 * annually. Short words, early in the line, so the recording can show them. */
const AGREEMENT_TERM = "quarterly";
const HALLUCINATED_TERM = "annually";
/** A citation id the rejected annotation never minted. */
const NEVER_MINTED_ID = "cit_5f3c9a1e42";

const textOf = (message: Message): string =>
	typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

const lastToolResult = (messages: readonly Message[]): { name: string; text: string; isError: boolean } | undefined => {
	const last = messages.at(-1);
	if (last === undefined || last.role !== "toolResult" || !Array.isArray(last.content)) return undefined;
	return {
		name: last.toolName,
		text: last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
		isError: last.isError,
	};
};

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

/** The newest question naming clause 7.2 — still found after a bounce, whose
 * message is the newest user turn. */
const demoQuestion = (messages: readonly Message[]): Message | undefined => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message !== undefined && message.role === "user" && DEMO_QUESTION.test(textOf(message))) return message;
	}
	return undefined;
};

/** The sentence the scripted model believes. Both the publish attempt and the
 * plain fallback say the same thing, so the transcript is coherent. */
const claim = (term: string): string => `Clause 7.2 says fees are payable ${term} in advance.`;

const toolCall = (name: string, arguments_: JsonObject): AssistantMessage =>
	fauxAssistantMessage([fauxToolCall(name, arguments_, { id: `${name}-${Date.now()}` })], { stopReason: "toolUse" });

/** The tampered copy of a stored line: the two figures differ, so the gate's
 * exact-span check fails on a real document. */
const tampered = (quote: string): string =>
	quote.includes(AGREEMENT_TERM)
		? quote.replace(AGREEMENT_TERM, HALLUCINATED_TERM)
		: `${quote} as amended.`;

export const citationGateDemoScript = (transcript: TranscriptContext): AssistantMessage | undefined => {
	const messages = transcript.messages;
	const question = demoQuestion(messages);
	if (question === undefined) return undefined;
	const exact = EXACT_QUESTION.test(textOf(question));
	const term = exact ? AGREEMENT_TERM : HALLUCINATED_TERM;

	// A rejected publish leaves the model with one exit that is not the gate: the
	// plain answer, which the envelope labels "No document evidence". The claim is
	// not evidence and the product says so; the rejected submission stays in the
	// trace, where the gate's reasons are counted (RFC 0006 R12).
	const newest = messages.at(-1);
	if (newest !== undefined && newest.role === "user" && BOUNCE.test(textOf(newest))) {
		return toolCall("answer_plain", { markdown: claim(term) });
	}

	const last = lastToolResult(messages);
	if (last === undefined) return toolCall("corpus_grep", { pattern: "7\\.2" });

	if (last.name === "corpus_grep") {
		// No such document staged (a reader asking the recording's question with an
		// empty corpus): exit through answer_plain, which terminates. Returning prose
		// would be bounced by the strict hook and never end.
		if (last.isError) return toolCall("answer_plain", { markdown: "UNANSWERED: clause 7.2 is not in the corpus." });
		const hits = (JSON.parse(last.text) as { hits: { docId: string; text: string }[] }).hits;
		const hit = hits[0];
		if (hit === undefined) return toolCall("answer_plain", { markdown: "UNANSWERED: clause 7.2 is not in the corpus." });
		return toolCall("corpus_read", { docId: hit.docId, needle: hit.text });
	}

	if (last.name === "corpus_read") {
		const read = lastToolArgs(messages, "corpus_read");
		const docId = typeof read?.docId === "string" ? read.docId : "";
		const stored = typeof read?.needle === "string" ? read.needle : "";
		const quote = exact ? stored : tampered(stored);
		return toolCall("corpus_annotate", { docId, docVersion: 1, kind: "quote", citation: { text: quote } });
	}

	if (last.name === "corpus_annotate") {
		if (last.isError) {
			// The quote never became a citation. Publishing the claim anyway is the
			// move the gate exists to refuse: the id was never minted.
			return toolCall("answer_publish", {
				markdown: `## Payment term\n\n${claim(term)} [${NEVER_MINTED_ID}]\n`,
				citationIds: [NEVER_MINTED_ID],
			});
		}
		const { citationId } = JSON.parse(last.text) as { citationId: string };
		return toolCall("answer_publish", {
			markdown: `## Payment term\n\n${claim(term)} [${citationId}]\n`,
			citationIds: [citationId],
		});
	}

	if (last.name === "answer_publish") {
		// Refused. The model falls back to the plain exit: the reply is shown, and the
		// product labels it as carrying no document evidence.
		return toolCall("answer_plain", { markdown: claim(term) });
	}

	return undefined;
};
