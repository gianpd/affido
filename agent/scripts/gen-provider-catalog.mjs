// Generates provider-catalog.json from pi-ai's static model catalogs
// (RFC 0012 §5.1). Run at agent-image build time:
//   node scripts/gen-provider-catalog.mjs > provider-catalog.json
// The manager extracts this file from AGENT_IMAGE and serves it verbatim, so
// the catalog and the provider wrappers (agent/model.ts factories) always come
// from the same pinned pi-ai version — the no-drift answer to open question 3.
// No static fallback exists: an image without the file fails closed.

import { CEREBRAS_MODELS } from "@earendil-works/pi-ai/providers/cerebras.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { TOGETHER_MODELS } from "@earendil-works/pi-ai/providers/together.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";

const BUILTINS = [
	["openrouter", "OpenRouter", OPENROUTER_MODELS, "https://openrouter.ai/api/v1"],
	["openai", "OpenAI", OPENAI_MODELS, undefined],
	["deepseek", "DeepSeek", DEEPSEEK_MODELS, undefined],
	["groq", "Groq", GROQ_MODELS, undefined],
	["together", "Together", TOGETHER_MODELS, undefined],
	["fireworks", "Fireworks", FIREWORKS_MODELS, undefined],
	["xai", "xAI", XAI_MODELS, undefined],
	["cerebras", "Cerebras", CEREBRAS_MODELS, undefined],
	["mistral", "Mistral", MISTRAL_MODELS, undefined],
];

// RFC 0012 §5.6: the path the manager's key check appends to the entry's
// baseUrl. The default (absent) is "/models", but OpenRouter's /models is
// public and ignores Authorization — any garbage key answers 200 there, so
// validation proves nothing and a wrong-provider key only fails at the first
// prompt (observed 2026-10-25: a DeepSeek key under openrouter passed
// validation, then every prompt settled model_error 401 "Missing
// Authentication header"). "/key" is OpenRouter's auth-required account
// endpoint: it 401s for any key that is not a real sk-or-v1-… key.
const VALIDATE_PATHS = { openrouter: "/key" };

// RFC 0013 §6.1 step 3: which header the key-injection sidecar stamps for the
// entry. Every catalog provider speaks an OpenAI-compatible or
// Mistral/OpenRouter wire API that authenticates with `Authorization: Bearer`
// (OpenRouter's and Fireworks' anthropic-messages models included);
// "x-api-key" is the native Anthropic header and reserved for a future
// native-anthropic entry. Read by the sidecar at /config time from the same
// file (no drift: one generator, one image).
const AUTH_HEADERS = {}; // id -> "x-api-key"; absent means bearer

const providers = BUILTINS.map(([id, name, catalog, pinnedBaseUrl]) => {
	const models = Object.values(catalog)
		.filter((model) => model.type === undefined || model.type === "chat")
		.map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning === true }));
	if (models.length === 0) throw new Error(`pi-ai catalog for ${id} has no chat models`);
	// The model data's baseUrl can differ from the factory's (openrouter serves
	// /api/v1); the entry pins the URL the §5.6 validation request uses, so the
	// factory's value wins where they differ.
	const entry = { id, name, baseUrl: pinnedBaseUrl ?? Object.values(catalog)[0].baseUrl, builtin: true, models };
	if (VALIDATE_PATHS[id] !== undefined) entry.validatePath = VALIDATE_PATHS[id];
	if (AUTH_HEADERS[id] !== undefined) entry.auth = AUTH_HEADERS[id];
	return entry;
});

process.stdout.write(JSON.stringify({ version: 1, providers }));
