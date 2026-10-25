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

const providers = BUILTINS.map(([id, name, catalog, pinnedBaseUrl]) => {
	const models = Object.values(catalog)
		.filter((model) => model.type === undefined || model.type === "chat")
		.map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning === true }));
	if (models.length === 0) throw new Error(`pi-ai catalog for ${id} has no chat models`);
	// The model data's baseUrl can differ from the factory's (openrouter serves
	// /api/v1); the entry pins the URL the §5.6 validation request uses, so the
	// factory's value wins where they differ.
	return { id, name, baseUrl: pinnedBaseUrl ?? Object.values(catalog)[0].baseUrl, builtin: true, models };
});

process.stdout.write(JSON.stringify({ version: 1, providers }));
