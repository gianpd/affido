// RFC 0024: the shared wire contract of the MCP edge (the `web-protocol.ts`
// pattern: one module the node, the agent tools, and the tests all use, so a
// field added on one side cannot silently drift from what the other validates).
//
// Two vocabularies live here:
//   - the refusal codes the model can act on (§8): one closed enum, wording
//     pinned by unit tests, shared by the node and the tools (§3.1: a refusal
//     is legible to the model and stable in the trace);
//   - the result envelope every successful call returns, `untrusted: true` by
//     construction, capped to the manifest's `maxResultChars`.

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Refusal codes the model can act on (RFC 0024 §8). Closed enum: the node and
 * the tools answer only these, never an upstream string verbatim. */
export const MCP_TOOL_ERRORS = [
	"server_disabled",
	"tool_unavailable",
	"write_not_authorized",
	"timeout",
	"upstream_error",
	"invalid_result",
	"rate_limited",
	"breaker_open",
	"not_a_run",
	"mcp_unavailable",
] as const;
export type McpToolError = (typeof MCP_TOOL_ERRORS)[number];

/** Node-side transport refusals (HTTP status + code), the websearch.ts shape. */
export const MCP_NODE_ERRORS = [
	"invalid_json",
	"invalid_request",
	"forbidden_peer",
	"control_token_required",
	"control_token_mismatch",
	"forbidden_control",
	"missing_run",
	"run_not_registered",
	"not_authorized",
	"not_found",
	"internal",
] as const;
export type McpNodeError = (typeof MCP_NODE_ERRORS)[number];

/** Pinned refusal wording (§3.1): asserted verbatim by unit tests so a refusal
 * stays legible to the model and stable in the trace. */
export const MCP_REFUSALS: Record<McpToolError, string> = {
	server_disabled: "this MCP server is not enabled for the user; ask the user to enable it in Settings or pick another server",
	tool_unavailable: "the server no longer offers this tool; it was removed from the manifest or the server dropped it",
	write_not_authorized: "this tool changes state and the user did not allow changes for this message; ask the user to enable changes and resend",
	timeout: "the server did not answer within its time budget",
	upstream_error: "the server answered with an error",
	invalid_result: "the server returned a result that does not match the MCP shape",
	rate_limited: "this server's per-minute call budget is spent; wait and retry",
	breaker_open: "this server failed repeatedly and is paused for a cooldown; try again later",
	not_a_run: "MCP tools serve a /prompt submission; there is no current run",
	mcp_unavailable: "the MCP node is not available for this run; ask the user to resend the message",
};

/** Every upstream-authored string that travels with an error is capped to this
 * many characters before it reaches the model: it is server text, not a
 * message we quote in full (§3.1 pattern 2). */
export const MCP_ERROR_TEXT_CAP = 300;

export const capServerText = (text: string, cap: number = MCP_ERROR_TEXT_CAP): string => {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length <= cap ? single : `${single.slice(0, cap)}…`;
};

// ── result envelope ─────────────────────────────────────────────────────────

export const McpResultEnvelopeSchema = Type.Object({
	untrusted: Type.Literal(true),
	server: Type.String({ minLength: 1, maxLength: 64 }),
	tool: Type.String({ minLength: 1, maxLength: 128 }),
	text: Type.String({ maxLength: 65536 }),
	truncated: Type.Boolean(),
	totalChars: Type.Integer({ minimum: 0 }),
});
export type McpResultEnvelope = Static<typeof McpResultEnvelopeSchema>;

/** `structuredOutputSchema` of every model-facing MCP tool. */
export const McpToolOutputSchema = Type.Union([McpResultEnvelopeSchema, Type.Object({
	error: Type.Union([Type.String()]),
	message: Type.String(),
	requestId: Type.Optional(Type.String()),
})]);
export type McpToolOutput = Static<typeof McpToolOutputSchema>;

export const isMcpResultEnvelope = (value: unknown): value is McpResultEnvelope =>
	Value.Check(McpResultEnvelopeSchema, value);

// ── node config wire (manager -> node, RFC 0024 §7.1) ───────────────────────

export const MCP_SERVER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** One configured server, as the manager delivers it to the node. The token is
 * the per-user credential (D9): it lives in the node's RAM only. */
export type McpConfiguredServer = {
	readonly id: string;
	readonly url: string;
	readonly token?: string;
};

export const isMcpConfiguredServer = (value: unknown): value is McpConfiguredServer => {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["id"] === "string" &&
		MCP_SERVER_ID_RE.test(record["id"]) &&
		typeof record["url"] === "string" &&
		(record["token"] === undefined || typeof record["token"] === "string")
	);
};

// ── manifest limits (D15: per-server, not global) ───────────────────────────

export type McpLimits = {
	readonly timeoutMs: number;
	readonly maxResultBytes: number;
	readonly maxResultChars: number;
	readonly requestsPerMinute: number;
	readonly concurrency: number;
};

export const MCP_DEFAULT_LIMITS: McpLimits = {
	timeoutMs: 30_000,
	maxResultBytes: 65_536,
	maxResultChars: 6_000,
	requestsPerMinute: 30,
	concurrency: 2,
};

export const MCP_CATALOG_PATH = "/app/catalog/mcp.json";
