// The current judge binding (RFC 0018): LiquidAI d1.1 through OpenRouter's
// typed-choice decisions endpoint. This file is the only place that knows the
// pinned model id, the alpha base URL, the wire form the model sees and how
// live runtime state becomes a `JudgeTarget`. `Judge` (judge.ts) is the
// provider-agnostic class; another runtime is a sibling binding with its own
// provider + classifier implementation and the same target shape.

import { createProvider } from "@earendil-works/pi-ai/models";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierFunction,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	CredentialStore,
	JsonObject,
	MutableModels,
	ProviderAuth,
	ProviderClassifier,
} from "@earendil-works/pi-ai";
import type { JudgeTarget } from "./judge.ts";
import { JUDGE_BUDGET, JUDGE_LADDER } from "./citation-judge.ts";
import { SIDECAR_PLACEHOLDER_KEY, sidecarUrl } from "./model.ts";

/** The pinned model id (RFC 0018 §5): the eval numbers are for this model; no
 * env override exists, the pin is the drift control. */
export const D1_MODEL_ID = "liquid/d1.1";

/** OpenRouter's typed-choice base (alpha): the classifier posts
 * `${baseUrl}/decisions`. Not under `/api/v1`, which is why the sidecar has a
 * dedicated route (RFC 0018 §4). */
export const OPENROUTER_DECISIONS_BASE_URL = "https://openrouter.ai/api/alpha";

/** Classifier API id of the decisions protocol, registered on the judge
 * provider (the same id the built-in OpenAI adapter uses for `/v1/decisions`
 * would be misleading: the wire shape is OpenRouter's alpha one). */
export const OPENROUTER_DECISIONS_API = "openrouter-decisions";

/** The judge's own provider entry in the `Models` collection: separate from
 * the conversation's chat providers, so the judge never inherits (or
 * perturbs) the model selection's base URL and auth. */
export const JUDGE_PROVIDER = "judge";

/** Keyless provider auth. `Models.classify` requires a configured provider
 * before it dispatches; whether a target exists at all is the resolver's
 * answer, not the credential store's. A direct key travels as a request
 * option read from that store (RFC 0012 R3: memory only), the sidecar route
 * carries none. */
const KEYLESS_AUTH: ProviderAuth = {
	apiKey: {
		name: "judge request key",
		resolve: async () => ({ auth: {} }),
	},
};

/** Register the judge's provider and classifier implementation once per boot. */
export const registerJudgeProvider = (models: MutableModels): void => {
	models.setProvider(
		createProvider({
			id: JUDGE_PROVIDER,
			name: "Coherence judge",
			baseUrl: OPENROUTER_DECISIONS_BASE_URL,
			auth: KEYLESS_AUTH,
			models: [],
			classifiers: { [OPENROUTER_DECISIONS_API]: openRouterDecisionsApi() },
		}),
	);
};

/** RFC 0020 §4.3: the retry ladder and its per-attempt deadline are derived
 * in one place (`citation-judge.ts`) from the per-pair envelope, so the two can
 * no longer drift apart (that drift was defect R3: a 4.4 s ladder under a
 * 4.7 s envelope while the measured cold path was 5.65 s). Timeouts are worth
 * the one retry — the cold start the first attempt absorbs is exactly the
 * case the second, warm attempt answers — and 4xx answers still fail
 * immediately (retrying an auth or payload error only burns the budget). */
const RETRIABLE = /HTTP (408|425|429|5\d\d):/;

const isTimeoutAbort = (error: unknown): boolean =>
	error instanceof Error &&
	(error.name === "TimeoutError" || (error.name === "AbortError" && /timeout/i.test(error.message)));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The frozen state form of the eval (RFC 0018 §2): both fields with fixed
 * markers, no JSON wrapper. This is a wire detail of the measured model, so it
 * lives in the binding, not in the Judge. */
const renderState = (state: JsonObject): string => {
	const claim = state.claim;
	const quote = state.quote;
	if (typeof claim !== "string" || typeof quote !== "string") {
		throw new Error('decisions state requires the string fields "claim" and "quote"');
	}
	return `CLAIM:\n${claim}\n\nEVIDENCE:\n${quote}`;
};

/** The endpoint is typed-choice only; a `score`/`bool` question is a caller
 * bug, not a provider limitation to paper over. */
const wireQuestions = (questions: ClassifierContext["questions"]): ClassifierContext["questions"] => {
	for (const [id, question] of Object.entries(questions)) {
		if (question.type !== "choice") throw new Error(`decisions endpoint supports choice questions only (${id}: ${question.type})`);
	}
	return questions;
};

const probabilityRecord = (value: unknown): Record<string, number> => {
	if (typeof value !== "object" || value === null) return {};
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
};

/** One response answer per requested question; the choice is passed through
 * unvalidated (the Judge owns the label vocabulary), the score is
 * `confidence` with the choice's own probability as fallback. */
const parseAnswers = (context: ClassifierContext, response: unknown): ClassifierResult["answers"] => {
	if (typeof response !== "object" || response === null) throw new Error("decisions endpoint returned an unexpected response");
	const answers = (response as { answers?: unknown }).answers;
	if (typeof answers !== "object" || answers === null) throw new Error("decisions endpoint returned no answers");
	const record = answers as Record<string, unknown>;
	const parsed: ClassifierResult["answers"] = {};
	for (const id of Object.keys(context.questions)) {
		const answer = record[id];
		if (typeof answer !== "object" || answer === null) throw new Error(`decisions endpoint returned no answer for ${id}`);
		const { choice, confidence, probabilities } = answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown };
		if (typeof choice !== "string") throw new Error(`decisions endpoint returned an unexpected choice: ${JSON.stringify(choice)}`);
		const scores = probabilityRecord(probabilities);
		parsed[id] = {
			type: "choice",
			choice,
			probabilities: scores,
			confidence: typeof confidence === "number" ? confidence : (scores[choice] ?? 0),
		};
	}
	return parsed;
};

/** One POST, bounded by a per-attempt timeout; the caller's signal wins. */
const post = async (model: ClassifierModel<ClassifierApi>, body: string, options: ClassifierOptions | undefined): Promise<unknown> => {
	const url = `${model.baseUrl.replace(/\/+$/u, "")}/decisions`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (options?.apiKey !== undefined && options.apiKey !== "") headers.authorization = `Bearer ${options.apiKey}`;
	// Catalog headers first, then the request's (already auth-merged and
	// transformHeaders-applied by `Models`); null suppresses a default.
	for (const source of [model.headers ?? {}, options?.headers ?? {}]) {
		for (const [name, value] of Object.entries(source)) {
			if (value === null) delete headers[name.toLowerCase()];
			else headers[name] = value;
		}
	}
	const timeout = AbortSignal.timeout(options?.timeoutMs ?? JUDGE_BUDGET.attemptDeadlineMs);
	const signal = options?.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
	const request = options?.fetch ?? fetch;
	const response = await request(url, { method: "POST", headers, body, signal });
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`decisions endpoint HTTP ${response.status}: ${text.slice(0, 200)}`);
	}
	return await response.json();
};

const withRetry = async (attempt: () => Promise<unknown>): Promise<unknown> => {
	let lastError = new Error("decisions endpoint: unreachable");
	for (let index = 0; index < JUDGE_LADDER.attempts; index++) {
		try {
			return await attempt();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if ((!isTimeoutAbort(error) && !RETRIABLE.test(lastError.message)) || index === JUDGE_LADDER.attempts - 1) break;
			await sleep(JUDGE_LADDER.backoffMs);
		}
	}
	throw lastError;
};

/** The OpenRouter decisions classifier API (RFC 0018 §2). Never rejects: the
 * classifier contract reports failures as a result, and `Judge` turns a
 * non-`stop` result back into a thrown error for the port. */
export const openRouterDecisionsApi = (): ProviderClassifier => ({
	classify: (async (model, context, options) => {
		const output: ClassifierResult = {
			api: model.api,
			provider: model.provider,
			model: model.id,
			answers: {},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		try {
			if (model.api !== OPENROUTER_DECISIONS_API) throw new Error(`unsupported classifier API: ${model.api}`);
			const body = JSON.stringify({ model: model.id, state: renderState(context.state), questions: wireQuestions(context.questions) });
			output.answers = parseAnswers(context, await withRetry(() => post(model, body, options)));
			return output;
		} catch (error) {
			output.answers = {};
			output.stopReason = options?.signal?.aborted === true ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			return output;
		}
	}) satisfies ClassifierFunction,
});

/** Live runtime state the target resolution reads; no key is cached. */
export type JudgeRunState = {
	readonly provider: string;
	readonly keyVia: "sidecar" | "direct" | null;
	readonly credentials: CredentialStore;
};

const sidecarJudgeBase = (): string => {
	const base = sidecarUrl();
	if (base === "") throw new Error("sidecar delivery requires SIDECAR_URL (RFC 0013)");
	return `${base}/judge`;
};

const judgeModel = (baseUrl: string): ClassifierModel<ClassifierApi> => ({
	type: "classifier",
	id: D1_MODEL_ID,
	name: D1_MODEL_ID,
	provider: JUDGE_PROVIDER,
	api: OPENROUTER_DECISIONS_API,
	baseUrl,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4_096,
});

/** RFC 0018 §3: target resolution from live provider state.
 *
 * - provider `openrouter` + sidecar delivery → the sidecar's fixed
 *   `/judge/decisions` route, no key in this process (RFC 0013 R1);
 * - provider `openrouter` + a stored real key → the pinned decisions URL with
 *   that key (standalone secret file, or a direct BYOK delivery);
 * - anything else (faux, other providers, or only the sidecar placeholder
 *   without a sidecar) → null: the layer is absent.
 */
export const judgeTargetOf = async (state: JudgeRunState): Promise<JudgeTarget | null> => {
	if (state.provider !== "openrouter") return null;
	if (state.keyVia === "sidecar") return { model: judgeModel(sidecarJudgeBase()) };
	const credential = await state.credentials.read("openrouter");
	const key = credential?.type === "api_key" ? credential.key : undefined;
	if (key === undefined || key === "") return null;
	if (key === SIDECAR_PLACEHOLDER_KEY) {
		// A placeholder without a sidecar delivery is a stale registry, never a
		// usable key; with a sidecar deployed the manager re-delivers on the
		// next resolve and the judge follows.
		const base = sidecarUrl();
		return base === "" ? null : { model: judgeModel(`${base}/judge`) };
	}
	return { model: judgeModel(OPENROUTER_DECISIONS_BASE_URL), apiKey: key };
};
