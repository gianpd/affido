// GlinerDecideJudge: the local GLiNER2.5-Decide runtime behind the
// CitationJudge port (RFC 0017 §5). Everything model-shaped — the ONNX
// session, the tokenizer, the GLiNER2 sequence encoding — stays in this file;
// nothing else imports `@huggingface/transformers`.
//
// The runtime is `@huggingface/transformers` (Transformers.js) directly, not
// `open-jev`: open-jev 0.1.2 (latest, 2026-11) supports only the `open_jev`
// and `kev` config sections and refuses this model's `gliner2` section —
// verified against its published source and at runtime. The gliner2 family
// adapter exists only as unmerged PR nico-martin/open-jev#1, so the adapter is
// reproduced here and verified token-for-token against the exporter's
// `conversion/reference.json` (onnx-community/GLiNER2.5-Decide-ONNX @
// 18271032): identical input_ids and marker_positions on all 6 reference
// cases, argmax agreement 12/13, worst probability difference 0.068 at q4f16
// (the card's own q4f16 parity table reports 7.1e-2).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AutoConfig, AutoModel, AutoTokenizer, Tensor, env } from "@huggingface/transformers";
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";
import type { CitationJudge, JudgeVerdict } from "./citation-judge.ts";

/** The pinned artifacts (RFC 0017 §2). Sizes are actual bytes. */
export type JudgeManifest = {
	readonly repo: string;
	readonly revision: string;
	readonly dtype: "q4f16";
	readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
};

export const MOBILE_MANIFEST: JudgeManifest = {
	repo: "onnx-community/GLiNER2.5-Decide-mobile-ONNX",
	revision: "880d1921d315b44648c9f6c6fb6ea0b87dea2b62",
	dtype: "q4f16",
	files: [
		{ path: "config.json", bytes: 1617, sha256: "fe7207771be1163b9837be6dab8799ceaa9cfd8bd39357f435c6ad813c757fcb" },
		{ path: "onnx/model_q4f16.onnx", bytes: 342105, sha256: "99a4e4c57fb15095a7e0aada14303d3d4f4ae0c3ce09c7b456a444bc2aff0dc2" },
		{ path: "onnx/model_q4f16.onnx_data", bytes: 344936496, sha256: "602b28f32ad602d84355de99deb3dcd549386a7ef3b8ab9c3bc4e9911e918974" },
		{ path: "tokenizer.json", bytes: 8333952, sha256: "3ad87d9ffe669147063e70850927dd2da90249e2acc5c8527f1eb65df467bcc8" },
		{ path: "tokenizer_config.json", bytes: 3360, sha256: "ae050dc100bd157db8995b9604e4d5a9bef535f3170fdba43f167dd3126d2bf1" },
		{ path: "special_tokens_map.json", bytes: 2414, sha256: "84ea70143f533d7e99b393d87f20010887a9ac2cba955828ef313886e4e83f4f" },
	],
};

/** The 523 MB non-mobile q4f16 build: the parity reference the mobile build
 * is measured against (RFC 0017 §8), not shipped behind the default flag. */
export const FULL_MANIFEST: JudgeManifest = {
	repo: "onnx-community/GLiNER2.5-Decide-ONNX",
	revision: "18271032588167fe9a3fbb8c5a4900b1231f8119",
	dtype: "q4f16",
	files: [
		{ path: "config.json", bytes: 1693, sha256: "1ca6b630724aebef2a6d6ab8d5da72f7c3d40abdee0d7a96742b6252b23a0b12" },
		{ path: "onnx/model_q4f16.onnx", bytes: 341889, sha256: "93f3e0d4ed8bbd4858840f8a2e66028a70e86a482e1ff9822d2ac726381684f6" },
		{ path: "onnx/model_q4f16.onnx_data", bytes: 523127808, sha256: "df2b05dc97ff875e0d2b51ec21de0049b7b3e7feddaa5224d318dc79e66210e8" },
		{ path: "tokenizer.json", bytes: 8333952, sha256: "3ad87d9ffe669147063e70850927dd2da90249e2acc5c8527f1eb65df467bcc8" },
		{ path: "tokenizer_config.json", bytes: 3360, sha256: "ae050dc100bd157db8995b9604e4d5a9bef535f3170fdba43f167dd3126d2bf1" },
		{ path: "special_tokens_map.json", bytes: 2414, sha256: "84ea70143f533d7e99b393d87f20010887a9ac2cba955828ef313886e4e83f4f" },
	],
};

/** `max_position_embeddings` of the export; the question, its labels and both
 * judged fields share this budget. */
const MAX_LENGTH = 512;
/** The judge asks exactly one question; its encoded overhead is subtracted
 * before the state is cut, so the state budget is 512 minus this. */
const QUESTION_OVERHEAD_TOKENS = 28;

const QUESTION = "How does the evidence relate to the claim?";
const OPTIONS = ["supported", "unrelated", "contradicted"] as const;

/** Word splitter of the GLiNER2 processor (`WhitespaceTokenSplitter`), with
 * `\w` widened to Unicode letters, marks and digits to match Python's `re`. */
const WORD_PATTERN = /(?:https?:\/\/[^\s]+|www\.[^\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|[\p{L}\p{M}\p{N}_]+(?:[-_][\p{L}\p{M}\p{N}_]+)*|\S/giu;

const softmax = (logits: readonly number[], temperature: number): number[] => {
	const max = Math.max(...logits);
	const exps = logits.map((logit) => Math.exp((logit - max) / temperature));
	const sum = exps.reduce((a, b) => a + b, 0);
	return exps.map((value) => value / sum);
};

/** The judge input as one state: the model has no native (claim, evidence)
 * pair input, so both are concatenated with fixed markers (RFC 0017 §4.1). */
const stateOf = (claim: string, quote: string): string => `CLAIM:\n${claim}\n\nEVIDENCE:\n${quote}`;

export class GlinerDecideJudge implements CitationJudge {
	readonly #modelDir: string;
	readonly #manifest: JudgeManifest;
	#session: Promise<LoadedSession> | undefined;

	constructor(modelDir: string, manifest: JudgeManifest = MOBILE_MANIFEST) {
		this.#modelDir = modelDir;
		this.#manifest = manifest;
	}

	/** Load lazily (first judge call) and fail loudly: remote models are
	 * disabled up front, so a missing cache is an error, never a download.
	 * Transformers.js resolves `<localModelPath>/<model id>`, so the cache
	 * root is the parent of the artifact directory and the id is its name. */
	async #load(): Promise<LoadedSession> {
		this.#session ??= (async () => {
			// Transformers.js is process-global: pin it to our cache and forbid
			// the network before anything can fetch.
			env.allowRemoteModels = false;
			env.allowLocalModels = true;
			env.localModelPath = parentDirectory(this.#modelDir);
			for (const file of this.#manifest.files) {
				const info = await stat(join(this.#modelDir, file.path)).catch(() => null);
				if (info === null || !info.isFile() || info.size !== file.bytes) {
					throw new Error(
						`judge model cache incomplete: ${join(this.#modelDir, file.path)} (expected ${file.bytes} bytes, ${this.#manifest.repo}@${this.#manifest.revision}); run agent/scripts/fetch-judge-model.mjs`,
					);
				}
			}
			const dir = directoryName(this.#modelDir);
			const config = await AutoConfig.from_pretrained(dir);
			const tokenizer = await AutoTokenizer.from_pretrained(dir);
			const model = await AutoModel.from_pretrained(dir, { config, dtype: this.#manifest.dtype, device: "cpu" });
			return new LoadedSession(model, tokenizer, this.#manifest);
		})();
		return this.#session;
	}

	async judge(input: { readonly claim: string; readonly quote: string }): Promise<JudgeVerdict> {
		const session = await this.#load();
		return session.decide(stateOf(input.claim, input.quote));
	}

	async close(): Promise<void> {
		const pending = this.#session;
		this.#session = undefined;
		const session = await pending?.catch(() => null);
		await session?.dispose();
	}

	/** Whether every pinned file is present with the pinned size. Cheap
	 * (stat only): the download script owns the SHA256 verification. */
	async cached(): Promise<boolean> {
		for (const file of this.#manifest.files) {
			const info = await stat(join(this.#modelDir, file.path)).catch(() => null);
			if (info === null || !info.isFile() || info.size !== file.bytes) return false;
		}
		return true;
	}
}

/** The last path segment as Transformers.js sees the model id: the cache
 * directory's own name (`.../judge-models/decide-mobile` -> `decide-mobile`). */
const directoryName = (modelDir: string): string => {
	const parts = modelDir.replace(/[\\/]+$/, "").split(/[\\/]/);
	const last = parts.at(-1);
	if (last === undefined || last === "") throw new Error(`invalid model dir: ${modelDir}`);
	return last;
};

/** The directory containing the artifact directory (`.../judge-models`). */
const parentDirectory = (modelDir: string): string => {
	const parts = modelDir.replace(/[\\/]+$/, "").split(/[\\/]/);
	parts.pop();
	const parent = parts.join("/");
	if (parent === "") throw new Error(`invalid model dir: ${modelDir}`);
	return parent;
};

class LoadedSession {
	readonly #model: PreTrainedModel;
	readonly #tokenizer: PreTrainedTokenizer;
	readonly #markers: Gliner2Markers;

	constructor(model: PreTrainedModel, tokenizer: PreTrainedTokenizer, manifest: JudgeManifest) {
		this.#model = model;
		this.#tokenizer = tokenizer;
		this.#markers = prepareMarkers(tokenizer);
		void manifest;
	}

	/** Tokenize caller text as one string, no special tokens. */
	readonly #encode = (text: string): number[] => {
		const { input_ids } = this.#tokenizer(text, { add_special_tokens: false });
		return Array.from(input_ids.data, Number);
	};

	/** One decision: encode the GLiNER2 classification sequence, run the
	 * session, softmax the marker logits, argmax the three options. */
	async decide(state: string): Promise<JudgeVerdict> {
		const sequence = encodeGliner2Sequence({
			state: encodeState(state, this.#encode),
			questions: [{ instructions: this.#encode(QUESTION), options: OPTIONS.map((option) => this.#encode(option)) }],
			markers: this.#markers,
			maxLength: MAX_LENGTH,
		});
		const { logits } = await this.#model.forward({
			input_ids: int64(sequence.inputIds),
			attention_mask: int64(sequence.inputIds.map(() => 1)),
			marker_positions: int64(sequence.markerPositions),
		});
		const values = Array.from(logits.to("float32").data) as readonly number[];
		const probabilities = softmax((sequence.groups[0] ?? []).map((position) => values[position] ?? 0), 1);
		let best = 0;
		for (let index = 1; index < probabilities.length; index++) {
			if ((probabilities[index] ?? 0) > (probabilities[best] ?? 0)) best = index;
		}
		const option = OPTIONS[best] ?? "unsupported";
		return { verdict: option === "unrelated" ? "unsupported" : option, score: probabilities[best] ?? 0 };
	}

	async dispose(): Promise<void> {
		await this.#model.dispose?.();
	}
}

type Gliner2Markers = {
	readonly p: number;
	readonly l: number;
	readonly sepStruct: number;
	readonly sepText: number;
	readonly open: readonly number[];
	readonly close: readonly number[];
};

const singleToken = (tokenizer: PreTrainedTokenizer, text: string): number => {
	const { input_ids } = tokenizer(text, { add_special_tokens: false });
	const ids = Array.from(input_ids.data, Number);
	const first = ids[0];
	if (ids.length !== 1 || first === undefined) throw new Error(`tokenizer does not know the marker token ${text}`);
	return first;
};

const prepareMarkers = (tokenizer: PreTrainedTokenizer): Gliner2Markers => {
	const encode = (text: string): number[] => {
		const { input_ids } = tokenizer(text, { add_special_tokens: false });
		return Array.from(input_ids.data, Number);
	};
	return {
		p: singleToken(tokenizer, "[P]"),
		l: singleToken(tokenizer, "[L]"),
		sepStruct: singleToken(tokenizer, "[SEP_STRUCT]"),
		sepText: singleToken(tokenizer, "[SEP_TEXT]"),
		open: encode("("),
		close: encode(")"),
	};
};

/** The state is lowercased, split into words, terminated with `.` if it has
 * no terminator, and tokenized one word at a time — the GLiNER2 processor's
 * classification layout, reproduced exactly (verified against the export's
 * reference token ids). */
const encodeState = (state: string, encode: (text: string) => number[]): number[] => {
	const text = state.trim();
	const terminated = text === "" ? "." : /[.!?]$/.test(text) ? text : `${text}.`;
	const ids: number[] = [];
	for (const word of terminated.match(WORD_PATTERN) ?? []) ids.push(...encode(word.toLowerCase()));
	return ids;
};

/** `(...) [SEP_STRUCT] (...) [SEP_TEXT] state`, with `marker_positions`
 * pointing at every `[L]`. The state is cut at the end, whole words only,
 * never mid-token. */
const encodeGliner2Sequence = (input: {
	readonly state: readonly number[];
	readonly questions: readonly { readonly instructions: readonly number[]; readonly options: readonly (readonly number[])[] }[];
	readonly markers: Gliner2Markers;
	readonly maxLength: number;
}): { readonly inputIds: number[]; readonly markerPositions: number[]; readonly groups: readonly (readonly number[])[] } => {
	const { state, questions, markers, maxLength } = input;
	const inputIds: number[] = [];
	const markerPositions: number[] = [];
	const groups: number[][] = [];
	questions.forEach((question, index) => {
		if (index > 0) inputIds.push(markers.sepStruct);
		inputIds.push(...markers.open, markers.p, ...question.instructions, ...markers.open);
		const group: number[] = [];
		for (const option of question.options) {
			group.push(markerPositions.length);
			markerPositions.push(inputIds.length);
			inputIds.push(markers.l, ...option);
		}
		groups.push(group);
		inputIds.push(...markers.close, ...markers.close);
	});
	inputIds.push(markers.sepText);
	const budget = maxLength - QUESTION_OVERHEAD_TOKENS - inputIds.length;
	if (budget < 0) throw new Error(`judge question needs ${inputIds.length} tokens, over the ${maxLength} token context`);
	inputIds.push(...state.slice(0, budget));
	return { inputIds, markerPositions, groups };
};

const int64 = (values: readonly number[]): Tensor => new Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);

/** SHA256 of one file, streamed: used by the download script, exported for
 * verification tooling. */
export const sha256OfFile = async (path: string): Promise<string> =>
	new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
