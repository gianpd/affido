// RFC 0024 §3.1/D13: the hand-written stateless HTTP transport.
//
// worldGraph's dialect, which the first catalog servers share: one JSON-RPC
// object per POST, no `initialize` handshake required, no `MCP-Session-Id`,
// batches refused by the server. The client is therefore ~150 lines of fetch +
// JSON with no MCP SDK in the image (R7).
//
// Discipline adopted from relate (ADR-0442/0447, §3.1):
//   - every request carries an `id` this client issued; notifications are
//     never sent, and a response whose id is unknown or duplicate is dropped;
//   - caps are enforced during the read, not after: the body is read through a
//     byte counter and the whole call runs under a wall-clock abort, so a 10 GB
//     body or a one-byte-per-second drip is a named error, never a hang or a
//     RAM spike.

import { randomUUID } from "node:crypto";
import type { McpToolCallResult, McpTransport, McpUpstreamTool } from "./transport.ts";

type ListOutcome =
	| { readonly ok: true; readonly tools: readonly McpUpstreamTool[] }
	| { readonly ok: false; readonly code: "upstream_error" | "timeout" | "invalid_result"; readonly detail: string };

type JsonRpcResponse = {
	jsonrpc?: unknown;
	id?: unknown;
	result?: unknown;
	error?: { code?: unknown; message?: unknown };
};

const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse =>
	typeof value === "object" && value !== null;

export type StatelessHttpOptions = {
	readonly url: string;
	/** Bearer credential; empty string sends no Authorization header. */
	readonly token?: string;
	readonly log?: (...args: unknown[]) => void;
};

/** One POST = one JSON-RPC request object. Returns the parsed response after
 * the id check, or a named refusal. `deadlineSignal` is the caller's overall
 * budget; the byte cap is enforced while the body streams. */
const postRpc = async (
	options: StatelessHttpOptions,
	method: string,
	params: Record<string, unknown>,
	maxBytes: number,
	signal: AbortSignal,
): Promise<JsonRpcResponse | { readonly refusal: McpToolCallResult }> => {
	const id = randomUUID();
	let response: Response;
	try {
		response = await fetch(options.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			redirect: "error",
			signal,
		});
	} catch (error) {
		if (signal.aborted) {
			return { refusal: { ok: false, code: "timeout", detail: "the call exceeded its time budget" } };
		}
		const reason = error instanceof Error ? error.message : String(error);
		return { refusal: { ok: false, code: "upstream_error", detail: `the server did not answer: ${reason}` } };
	}
	if (response.status === 401 || response.status === 403) {
		return { refusal: { ok: false, code: "upstream_error", detail: `the server refused the credential (${response.status})` } };
	}
	// Read the body through the byte counter, never buffering first (§3.1).
	const reader = response.body?.getReader();
	if (reader === undefined) {
		const text = await response.text();
		return parseBody(options, id, text, response.status);
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) {
				size += value.byteLength;
				if (size > maxBytes) {
					await reader.cancel().catch(() => undefined);
					return { refusal: { ok: false, code: "upstream_error", detail: `the response body exceeds ${maxBytes} bytes` } };
				}
				chunks.push(value);
			}
		}
	} catch (error) {
		if (signal.aborted) {
			return { refusal: { ok: false, code: "timeout", detail: "the call exceeded its time budget while reading the body" } };
		}
		const reason = error instanceof Error ? error.message : String(error);
		return { refusal: { ok: false, code: "upstream_error", detail: `the response body broke: ${reason}` } };
	}
	return parseBody(options, id, Buffer.concat(chunks).toString("utf8"), response.status);
};

const parseBody = (
	options: StatelessHttpOptions,
	id: string,
	text: string,
	status: number,
): JsonRpcResponse | { readonly refusal: McpToolCallResult } => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { refusal: { ok: false, code: "invalid_result", detail: `the server answered HTTP ${status} with a non-JSON body` } };
	}
	if (Array.isArray(parsed)) {
		return { refusal: { ok: false, code: "invalid_result", detail: "the server answered a batch; the stateless contract is one object per POST" } };
	}
	if (!isJsonRpcResponse(parsed)) {
		return { refusal: { ok: false, code: "invalid_result", detail: "the server answer is not a JSON-RPC object" } };
	}
	// id discipline: a response that does not answer our id is dropped data,
	// never a result we act on. `result` and `error` both count as answers.
	if (parsed.id !== id) {
		options.log?.(`dropping response with foreign id ${String(parsed.id)} (expected ${id})`);
		return { refusal: { ok: false, code: "invalid_result", detail: "the server answered a request id this client did not issue" } };
	}
	return parsed;
};

export class StatelessHttpTransport implements McpTransport {
	readonly #options: StatelessHttpOptions;

	constructor(options: StatelessHttpOptions) {
		this.#options = options;
	}

	async listTools(signal: AbortSignal): Promise<ListOutcome> {
		const posted = await postRpc(this.#options, "tools/list", {}, 1_048_576, signal);
		if ("refusal" in posted) {
			// postRpc's refusals are always failures; the ok:true branch of the
			// shared type is unreachable here.
			if (posted.refusal.ok) throw new Error("internal: unexpected success refusal");
			return posted.refusal;
		}
		if (posted.error !== undefined) {
			return { ok: false, code: "upstream_error", detail: `tools/list failed: ${String(posted.error.message ?? posted.error.code)}` };
		}
		const result = posted.result;
		if (typeof result !== "object" || result === null || !Array.isArray((result as { tools?: unknown }).tools)) {
			return { ok: false, code: "invalid_result", detail: "tools/list returned no tools array" };
		}
		const tools: McpUpstreamTool[] = [];
		for (const entry of (result as { tools: unknown[] }).tools) {
			if (typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string") {
				// Description and annotations are server text: dropped here (D5).
				tools.push({
					name: (entry as { name: string }).name,
					inputSchema: (entry as { inputSchema?: unknown }).inputSchema,
				});
			}
		}
		return { ok: true, tools };
	}

	async callTool(name: string, args: Record<string, unknown>, maxResultBytes: number, signal: AbortSignal): Promise<McpToolCallResult> {
		const posted = await postRpc(this.#options, "tools/call", { name, arguments: args }, maxResultBytes, signal);
		if ("refusal" in posted) return posted.refusal;
		if (posted.error !== undefined) {
			return { ok: false, code: "upstream_error", detail: `the server refused the call: ${String(posted.error.message ?? posted.error.code)}` };
		}
		const result = posted.result;
		if (typeof result !== "object" || result === null) {
			return { ok: false, code: "invalid_result", detail: "tools/call returned no result object" };
		}
		const record = result as Record<string, unknown>;
		// An `isError` payload is upstream-authored text like any result: it
		// becomes a capped `upstream_error`, never a forwarded string.
		if (record["isError"] === true) {
			return { ok: false, code: "upstream_error", detail: textOfContent(record) ?? "the server reported a tool error with no text" };
		}
		const text = textOfContent(record);
		if (text === null) {
			return { ok: false, code: "invalid_result", detail: "tools/call returned no text content" };
		}
		return { ok: true, text };
	}

	close(): void {
		// Stateless: nothing to close. The port keeps the seam for the future
		// session-capable transport (D13).
	}
}

const textOfContent = (result: Record<string, unknown>): string | null => {
	const content = result["content"];
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null) {
			const record = block as Record<string, unknown>;
			if (record["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
		}
	}
	return parts.length === 0 ? null : parts.join("\n");
};
