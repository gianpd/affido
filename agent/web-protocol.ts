// RFC 0016: the shared wire contract of the web-search edge.
//
// The node, the agent tools, and the two upstream clients all use these
// schemas. The model still receives the compact JSON text built by
// `web-tools.ts`; programs that call a tool through `executeTool()` receive the
// validated envelope through `structuredOutput`.
//
// Keeping the schemas in one module is the point: a field added to the node's
// reply cannot silently drift from what the tool validates or what callers see.

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const WEB_SOURCE_ID_PATTERN = "^web_[A-Za-z0-9_-]{8,64}$";
export const WEB_HTTP_URL_PATTERN = "^https?://";
export const WEB_SHA256_PATTERN = "^[a-f0-9]{64}$";

export const WebErrorSchema = Type.Object({
	error: Type.String({ minLength: 1 }),
	message: Type.String(),
	requestId: Type.Optional(Type.String({ minLength: 1 })),
});
export type WebError = Static<typeof WebErrorSchema>;

export const WebSearchResultSchema = Type.Object({
	sourceId: Type.String({ pattern: WEB_SOURCE_ID_PATTERN }),
	title: Type.String({ maxLength: 300 }),
	domain: Type.String({ minLength: 1 }),
	snippet: Type.String({ maxLength: 500 }),
});
export type WebSearchResult = Static<typeof WebSearchResultSchema>;

export const WebSearchDiagnosticsSchema = Type.Object({
	enginesTried: Type.Array(Type.String()),
	fallbackUsed: Type.Boolean(),
	suspendedEngines: Type.Array(Type.String()),
	droppedCount: Type.Integer({ minimum: 0 }),
	partial: Type.Boolean(),
	resultCount: Type.Integer({ minimum: 0 }),
	elapsedMs: Type.Integer({ minimum: 0 }),
});
export type WebSearchDiagnostics = Static<typeof WebSearchDiagnosticsSchema>;

export const WebSearchEnvelopeSchema = Type.Object({
	requestId: Type.String({ minLength: 1 }),
	results: Type.Array(WebSearchResultSchema, { maxItems: 8 }),
	diagnostics: WebSearchDiagnosticsSchema,
});
export type WebSearchEnvelope = Static<typeof WebSearchEnvelopeSchema>;

export const WebReadPageSchema = Type.Object({
	untrusted: Type.Literal(true),
	url: Type.String({ pattern: WEB_HTTP_URL_PATTERN, minLength: 1 }),
	title: Type.String({ maxLength: 300 }),
	text: Type.String({ maxLength: 6000 }),
	sha256: Type.String({ pattern: WEB_SHA256_PATTERN }),
	truncated: Type.Boolean(),
	totalChars: Type.Integer({ minimum: 0 }),
});
export type WebReadPage = Static<typeof WebReadPageSchema>;

export const WebReadWindowSchema = Type.Object({
	mode: Type.Union([Type.Literal("full"), Type.Literal("head+focus"), Type.Literal("head")]),
	headChars: Type.Integer({ minimum: 0 }),
	start: Type.Integer({ minimum: 0 }),
	end: Type.Integer({ minimum: 0 }),
});
export type WebReadWindow = Static<typeof WebReadWindowSchema>;

export const WebReadDiagnosticsSchema = Type.Object({
	readAttempts: Type.Integer({ minimum: 1 }),
	window: WebReadWindowSchema,
	selectedChars: Type.Integer({ minimum: 0 }),
	elapsedMs: Type.Integer({ minimum: 0 }),
});
export type WebReadDiagnostics = Static<typeof WebReadDiagnosticsSchema>;

export const WebReadEnvelopeSchema = Type.Object({
	requestId: Type.String({ minLength: 1 }),
	page: WebReadPageSchema,
	diagnostics: WebReadDiagnosticsSchema,
});
export type WebReadEnvelope = Static<typeof WebReadEnvelopeSchema>;

/** `structuredOutputSchema` of the two model-facing tools. */
export const WebSearchToolOutputSchema = Type.Union([WebSearchEnvelopeSchema, WebErrorSchema]);
export const WebReadToolOutputSchema = Type.Union([WebReadEnvelopeSchema, WebErrorSchema]);
export type WebSearchToolOutput = Static<typeof WebSearchToolOutputSchema>;
export type WebReadToolOutput = Static<typeof WebReadToolOutputSchema>;

// ── upstream shapes ─────────────────────────────────────────────────────────

export const SearxResultSchema = Type.Object({
	title: Type.Optional(Type.Unknown()),
	url: Type.Optional(Type.Unknown()),
	content: Type.Optional(Type.Unknown()),
});
export type SearxResult = Static<typeof SearxResultSchema>;

export const SearxngResponseSchema = Type.Object({
	results: Type.Array(Type.Unknown()),
	unresponsive_engines: Type.Optional(Type.Array(Type.Unknown())),
});
export type SearxngResponse = Static<typeof SearxngResponseSchema>;

export const CamofoxTabSchema = Type.Object({
	tabId: Type.String({ minLength: 1 }),
	url: Type.Optional(Type.String()),
});
export type CamofoxTab = Static<typeof CamofoxTabSchema>;

export const CamofoxEvaluateSchema = Type.Object({
	ok: Type.Optional(Type.Boolean()),
	result: Type.String(),
});
export type CamofoxEvaluate = Static<typeof CamofoxEvaluateSchema>;

/** The browser expression's JSON payload: Markdown-like text plus the full
 * visible length before the node selects its 6000-character window. */
export const CamofoxPageSchema = Type.Object({
	title: Type.Optional(Type.String()),
	text: Type.String(),
	totalChars: Type.Integer({ minimum: 0 }),
});
export type CamofoxPage = Static<typeof CamofoxPageSchema>;

export const isWebError = (value: unknown): value is WebError => Value.Check(WebErrorSchema, value);
export const isWebSearchResult = (value: unknown): value is WebSearchResult =>
	Value.Check(WebSearchResultSchema, value);
export const isWebSearchEnvelope = (value: unknown): value is WebSearchEnvelope =>
	Value.Check(WebSearchEnvelopeSchema, value);
export const isWebReadPage = (value: unknown): value is WebReadPage => Value.Check(WebReadPageSchema, value);
export const isWebReadEnvelope = (value: unknown): value is WebReadEnvelope =>
	Value.Check(WebReadEnvelopeSchema, value);
export const isSearxResult = (value: unknown): value is SearxResult => Value.Check(SearxResultSchema, value);
export const isSearxngResponse = (value: unknown): value is SearxngResponse =>
	Value.Check(SearxngResponseSchema, value);
export const isCamofoxTab = (value: unknown): value is CamofoxTab => Value.Check(CamofoxTabSchema, value);
export const isCamofoxEvaluate = (value: unknown): value is CamofoxEvaluate =>
	Value.Check(CamofoxEvaluateSchema, value);
export const isCamofoxPage = (value: unknown): value is CamofoxPage => Value.Check(CamofoxPageSchema, value);
