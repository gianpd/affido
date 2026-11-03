// OpenRouterDecideJudge: the default coherence-judge runtime of RFC 0018 —
// LiquidAI's d1.1 decision model (`liquid/d1.1`) behind OpenRouter's typed-
// choice endpoint POST /api/alpha/decisions. Same port as GlinerDecideJudge
// (RFC 0017), same frozen zero-shot question and label definitions as the
// experiment that measured it (agent/scripts/eval-zero-shot-judges.mjs,
// docs/zero-shot-judge-eval.html): test 30/30, FA 0%, FR 0%.
//
// One decision per (claim, quote) pair: no chat prompt, no generation, no
// parsing — a single forward pass with `probabilities` and `confidence` in the
// response. `unrelated` maps to the verdict class `unsupported`.
//
// Key routing (RFC 0018 §3): the endpoint is resolved per call, never cached —
// direct mode reads the run's OpenRouter key from the in-memory credential
// store (RFC 0012 R3: never env, image, SESSION_DB or WORKSPACE), sidecar mode
// sends no key at all (RFC 0013 R1: the key lives in the sidecar, which stamps
// it against the catalog-pinned decisions URL). A null endpoint means the
// layer is absent: `available()` answers false and the publish path skips the
// judge, so a keyless deployment never sees judge rejections.

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { CitationJudge, JudgeVerdict } from "./citation-judge.ts";
import { SIDECAR_PLACEHOLDER_KEY, sidecarUrl } from "./model.ts";

/** OpenRouter's typed-choice endpoint (alpha). Pinned: not under the /api/v1
 * chat base the sidecar proxies, which is why the sidecar has a dedicated
 * /judge/decisions route (RFC 0018 §4). */
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** The pinned model id (RFC 0018 §5): the eval numbers are for this model;
 * no env override exists, the pin is the drift control. */
export const D1_MODEL_ID = "liquid/d1.1";

/** The endpoint the judge should call, resolved from live runtime state. */
export type JudgeEndpoint =
	| { readonly kind: "direct"; readonly url: string; readonly apiKey: string }
	| { readonly kind: "sidecar"; readonly url: string };

/** RFC 0018 §3: the frozen zero-shot form — same question, same one-line
 * definition per label, same state layout as the eval run. */
const QUESTION = "How does the evidence relate to the claim?";
const LABEL_DEFINITIONS = {
	supported: "the evidence states what the claim says; wording, numbers and dates may be written differently as long as the meaning is the same",
	unrelated: "the evidence is about a different clause or subject; it neither supports nor contradicts the claim",
	contradicted: "the evidence states the opposite of the claim, including by negation or by a different number, date or value",
} as const;
const mapVerdict = (label: string): JudgeVerdict["verdict"] => (label === "unrelated" ? "unsupported" : (label as JudgeVerdict["verdict"]));

/** The per-pair request body, state included. */
const decideRequest = (claim: string, quote: string): string =>
	JSON.stringify({
		model: D1_MODEL_ID,
		state: `CLAIM:\n${claim}\n\nEVIDENCE:\n${quote}`,
		questions: {
			relation: {
				type: "choice",
				instructions: `${QUESTION} Answer with exactly one label.`,
				criteria: LABEL_DEFINITIONS,
			},
		},
	});

/** Retry budget inside RFC 0017's 5 s per-pair envelope: two attempts, one
 * quick backoff; 4xx answers fail immediately (retrying an auth or payload
 * error only burns the budget). */
const ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 2_200;
const BACKOFF_MS = 300;

export class OpenRouterDecideJudge implements CitationJudge {
	readonly #endpointOf: () => Promise<JudgeEndpoint | null> | JudgeEndpoint | null;

	/** `endpointOf` is consulted per judge call, so credential rotation and
	 * provider switches (POST /config) apply to the next judged pair with no
	 * cached key and no invalidation protocol. */
	constructor(endpointOf: () => Promise<JudgeEndpoint | null> | JudgeEndpoint | null) {
		this.#endpointOf = endpointOf;
	}

	async available(): Promise<boolean> {
		return (await this.#endpointOf()) !== null;
	}

	async judge(input: { readonly claim: string; readonly quote: string }): Promise<JudgeVerdict> {
		const endpoint = await this.#endpointOf();
		if (endpoint === null) throw new Error("d1.1 judge: no OpenRouter credential backs this run (judge unavailable)");
		const body = decideRequest(input.claim, input.quote);
		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			try {
				return await this.#decide(endpoint, body);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (!RETRIABLE.test(lastError.message) || attempt === ATTEMPTS) break;
				await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
			}
		}
		throw lastError ?? new Error("d1.1 judge: unreachable");
	}

	async #decide(endpoint: JudgeEndpoint, body: string): Promise<JudgeVerdict> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (endpoint.kind === "direct") headers.Authorization = `Bearer ${endpoint.apiKey}`;
		const response = await fetch(endpoint.url, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`decisions endpoint HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
		const data = (await response.json()) as {
			answers?: { relation?: { choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> } };
		};
		const answer = data.answers?.relation;
		const label = answer?.choice;
		if (typeof label !== "string" || !(label in LABEL_DEFINITIONS)) {
			throw new Error(`decisions endpoint returned an unexpected choice: ${JSON.stringify(label)}`);
		}
		const probabilities = answer?.probabilities ?? {};
		const fallback = typeof probabilities[label] === "number" ? (probabilities[label] as number) : 0;
		const score = typeof answer?.confidence === "number" ? answer.confidence : fallback;
		return { verdict: mapVerdict(label), score };
	}
}

/** HTTP statuses worth one retry: 408/425/429 and every 5xx. */
const RETRIABLE = /HTTP (408|425|429|5\d\d):/;

/** RFC 0018 §3: endpoint resolution from live provider state. Exported for
 * `ContainerAgent.judgeEndpoint()` and for tests; no key is cached here.
 *
 * - provider `openrouter` + sidecar delivery → the sidecar's fixed
 *   `/judge/decisions` route (no key in this process, RFC 0013 R1);
 * - provider `openrouter` + a stored real key → the pinned decisions URL with
 *   that key (standalone secret file, or a direct BYOK delivery);
 * - anything else (faux, other providers, or only the sidecar placeholder
 *   without a sidecar) → null: the layer is absent.
 */
export const resolveJudgeEndpoint = async (state: {
	readonly provider: string;
	readonly keyVia: "sidecar" | "direct" | null;
	readonly credentials: CredentialStore;
}): Promise<JudgeEndpoint | null> => {
	if (state.provider !== "openrouter") return null;
	if (state.keyVia === "sidecar") {
		const base = sidecarUrl();
		if (base === "") throw new Error("sidecar delivery requires SIDECAR_URL (RFC 0013)");
		return { kind: "sidecar", url: `${base}/judge/decisions` };
	}
	const credential = await state.credentials.read("openrouter");
	const key = credential?.type === "api_key" ? credential.key : undefined;
	if (key === undefined || key === "") return null;
	if (key === SIDECAR_PLACEHOLDER_KEY) {
		// A placeholder without a sidecar delivery is a stale registry, never a
		// usable key; with a sidecar deployed the manager re-delivers on the
		// next resolve and the judge follows.
		const base = sidecarUrl();
		return base === "" ? null : { kind: "sidecar", url: `${base}/judge/decisions` };
	}
	return { kind: "direct", url: OPENROUTER_DECISIONS_URL, apiKey: key };
};
