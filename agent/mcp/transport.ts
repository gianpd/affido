// RFC 0024 §11.1 M0 / D13: the transport port. V1 ships the hand-written
// stateless HTTP transport (stateless-http.ts); a future server that needs
// sessions or SSE lands behind this port as a reviewed dependency addition,
// without touching the node or the tools.

/** One upstream tool as `tools/list` reports it. Only `name` and
 * `inputSchema` are read; `description`, `title` and annotations are server
 * text and are discarded (D5, §6.4). */
export type McpUpstreamTool = {
	readonly name: string;
	readonly inputSchema?: unknown;
};

export type McpToolCallResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly code: "upstream_error" | "timeout" | "invalid_result"; readonly detail: string };

export interface McpTransport {
	/** The server's `tools/list`. Descriptions are already discarded here: the
	 * caller sees names and schemas only. */
	listTools(signal: AbortSignal): Promise<{ readonly ok: true; readonly tools: readonly McpUpstreamTool[] } | { readonly ok: false; readonly code: "upstream_error" | "timeout" | "invalid_result"; readonly detail: string }>;
	/** One `tools/call`. The result text is the raw upstream payload, capped to
	 * `maxResultBytes` by the transport; the caller applies the model-facing
	 * `maxResultChars` cap. */
	callTool(name: string, args: Record<string, unknown>, maxResultBytes: number, signal: AbortSignal): Promise<McpToolCallResult>;
	close(): void;
}
