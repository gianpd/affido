// The citation-coherence judge (RFC 0017) over pi-ai's classifier contract.
// One class owns the layer's semantics: the frozen zero-shot question, one
// definition per label, the verdict vocabulary and the score. Which model
// answers it is injected: `targetOf` returns the classifier model (and, when
// the provider needs one, the request key) that backs the current run, or null
// when no model does — in which case the layer is absent, not erroring.
//
// Nothing provider-shaped lives here: no provider id, no URL, no model id, no
// wire format. A different runtime — local ONNX encoder, another hosted
// decisions API, a different model on the same one — is a different binding:
// register a provider with a classifier implementation in the `Models`
// collection and return that model from the resolver. The transport form the
// model actually sees (state rendering, question shape on the wire) belongs to
// the binding, because it is part of what was measured and differs per runtime.

import type { ClassifierApi, ClassifierModel, ClassifierQuestion, Models } from "@earendil-works/pi-ai";
import type { CitationJudge, JudgeVerdict } from "./citation-judge.ts";

/** One classification target resolved from live runtime state. The model must
 * be dispatchable by the same `Models` collection the judge runs on. */
export type JudgeTarget = {
	readonly model: ClassifierModel<ClassifierApi>;
	/** Explicit request key when the provider's auth resolution carries none
	 * (direct BYOK delivery). The sidecar route sends no key at all: the
	 * sidecar stamps it (RFC 0013 R1). */
	readonly apiKey?: string;
};

/** Consulted per judge call, so credential rotation and provider switches
 * (`POST /config`) apply to the next pair with no cached target. Null means
 * the layer is absent: no provider or credential backs the run. */
export type JudgeTargetResolver = () => Promise<JudgeTarget | null> | JudgeTarget | null;

/** RFC 0018 §3: the frozen zero-shot form — the same question and one-line
 * definition per label as the eval run. The definitions describe the fixture
 * semantics and do not leak pairs. */
const QUESTION = "How does the evidence relate to the claim?";

/** Versions the frozen question below (RFC 0020 §4.4): part of the verdict
 * cache key, so any change to the question or the label definitions
 * invalidates every cached verdict without a storage migration. Bump on any
 * change to this block. */
export const JUDGE_QUESTION_VERSION = 1;
export const LABEL_DEFINITIONS = {
	supported:
		"the evidence states what the claim says; wording, numbers and dates may be written differently as long as the meaning is the same",
	unrelated: "the evidence is about a different clause or subject; it neither supports nor contradicts the claim",
	contradicted:
		"the evidence states the opposite of the claim, including by negation or by a different number, date or value",
} as const;

export type JudgeLabel = keyof typeof LABEL_DEFINITIONS;

const RELATION_QUESTION: ClassifierQuestion = {
	type: "choice",
	instructions: `${QUESTION} Answer with exactly one label.`,
	criteria: LABEL_DEFINITIONS,
};

const isLabel = (value: string): value is JudgeLabel => Object.hasOwn(LABEL_DEFINITIONS, value);

/** `unrelated` is the dataset's name for "neither"; the layer's verdict
 * vocabulary is RFC 0017's (`supported` | `unsupported` | `contradicted`). */
const verdictOf = (label: JudgeLabel): JudgeVerdict["verdict"] => (label === "unrelated" ? "unsupported" : label);

export class Judge implements CitationJudge {
	readonly #models: Models;
	readonly #targetOf: JudgeTargetResolver;

	constructor(models: Models, targetOf: JudgeTargetResolver) {
		this.#models = models;
		this.#targetOf = targetOf;
	}

	async available(): Promise<boolean> {
		return (await this.#targetOf()) !== null;
	}

	/** RFC 0020 §4.4: the model id behind the next call, part of the verdict
	 * cache key. Null when no target resolves — but then `available()` is
	 * false too and the layer is skipped before any call. */
	async modelId(): Promise<string | null> {
		const target = await this.#targetOf();
		return target === null ? null : target.model.id;
	}

	/** One decision per (claim, quote) pair. `Models.classify` never rejects:
	 * unknown providers, auth failures, transport errors and malformed answers
	 * all come back as a result with `stopReason` "error"/"aborted". The port
	 * throws instead, so `coherenceOf` stores the named cause and `enforce`
	 * fails closed (RFC 0017 §4.2, RFC 0020 §4.2). */
	async judge(input: { readonly claim: string; readonly quote: string }): Promise<JudgeVerdict> {
		const target = await this.#targetOf();
		if (target === null) throw new Error("judge: no classifier model backs this run");
		const result = await this.#models.classify(
			target.model,
			{ state: { claim: input.claim, quote: input.quote }, questions: { relation: RELATION_QUESTION } },
			target.apiKey === undefined ? {} : { apiKey: target.apiKey },
		);
		if (result.stopReason !== "stop") throw new Error(`judge ${result.stopReason}: ${result.errorMessage ?? "no answer"}`);
		const answer = result.answers.relation;
		if (answer === undefined || answer.type !== "choice" || !isLabel(answer.choice)) {
			throw new Error(`judge returned an unexpected answer: ${JSON.stringify(answer)}`);
		}
		const probabilities = answer.probabilities;
		const supported = probabilities.supported;
		const unrelated = probabilities.unrelated;
		const contradicted = probabilities.contradicted;
		return {
			verdict: verdictOf(answer.choice),
			score: answer.confidence,
			...(typeof supported === "number" && typeof unrelated === "number" && typeof contradicted === "number"
				? { probabilities: { supported, unrelated, contradicted } }
				: {}),
		};
	}
}
