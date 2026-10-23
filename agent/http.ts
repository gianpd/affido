// HTTP plumbing: error type, JSON responses, raw downloads, request bodies,
// and workspace paths.

import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";

export class HttpError extends Error {
	readonly status: number;
	readonly body: JsonObject;

	constructor(status: number, body: JsonObject) {
		super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

export const json = (res: ServerResponse, status: number, value: unknown): void => {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body);
};

/** A non-JSON HTTP response, verbatim: `server.ts` writes status, headers, and
 * body with no further interpretation (RFC 0009 §5.6, the download path). */
export class RawResponse {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body: Buffer;

	constructor(status: number, headers: Record<string, string>, body: Buffer) {
		this.status = status;
		this.headers = headers;
		this.body = body;
	}
}

export const readBody = async (req: IncomingMessage): Promise<JsonObject> => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1_000_000) throw new Error("request body too large");
		chunks.push(chunk);
	}
	return chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject);
};

/** Read a non-JSON body (an upload) up to `limit` bytes; 413 past it. */
export const readRawBody = async (req: IncomingMessage, limit: number): Promise<Buffer> => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		size += buffer.length;
		if (size > limit) throw new HttpError(413, { error: "body_too_large", message: `body exceeds ${limit} bytes` });
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
};

export const textOf = (message: Message | undefined): string => {
	if (message === undefined || !Array.isArray(message.content)) return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

// Keep the file API inside the container's own workspace.
export const workspacePath = (workspace: string, path: string): string => {
	const resolved = resolve(workspace, path);
	if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) throw new Error("path escapes the workspace");
	return resolved;
};

/** Bounds of one client-chosen path (PRD 0003 §6), shared by every workspace
 * tree the client writes or reads path-by-path: uploads, skills, artifacts. */
const SEGMENTS_MAX = 10;
const SEGMENT_LENGTH_MAX = 64;
const PATH_LENGTH_MAX = 240;
/** Separators and wildcards that a path component must never carry. */
const FORBIDDEN_CHARS = /[\u0000-\u001f\\:*?"<>|]/;

/**
 * Validate a client-chosen path relative to a tree root. Relative, no
 * empty/`.`/`..` segments, bounded depth and length; everything else (unicode
 * letters, spaces, parentheses) is a legal filename. The empty string is not a
 * path: only a tree listing of the root accepts it.
 */
export const safeTreePath = (value: string): string => {
	if (value === "" || value.length > PATH_LENGTH_MAX) {
		throw new HttpError(400, {
			error: "invalid_tree_path",
			message: `path must be 1-${PATH_LENGTH_MAX} characters, relative to the tree root`,
		});
	}
	if (FORBIDDEN_CHARS.test(value)) {
		throw new HttpError(400, {
			error: "invalid_tree_path",
			message: 'path must not contain control characters or any of \\ : * ? " < > |',
		});
	}
	const segments = value.split("/");
	if (segments.length > SEGMENTS_MAX) {
		throw new HttpError(400, { error: "invalid_tree_path", message: `path must be at most ${SEGMENTS_MAX} segments deep` });
	}
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === ".." || segment.length > SEGMENT_LENGTH_MAX) {
			throw new HttpError(400, {
				error: "invalid_tree_path",
				message: `every segment must be 1-${SEGMENT_LENGTH_MAX} characters and not "." or ".."`,
			});
		}
	}
	return value;
};
