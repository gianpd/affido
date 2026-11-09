// The quota-aware execution environment of RFC 0022. The Harness builds one
// per tool call; CodingTools' `write`/`edit` go through `writeFile` and `bash`
// through `exec`. Both are admitted against the sandbox's disk quota, so the
// model cannot write past the ceiling without going through an HTTP route.
//
// Denials are returned as the environment's own Result errors, so a refused
// tool call is a normal tool error in the durable trace, not a server crash.

import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	ExecutionError,
	FileError,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import type { StorageQuotaPort } from "./types.ts";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const contentBytes = (content: string | Uint8Array): number =>
	typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;

export class QuotaExecutionEnv extends NodeExecutionEnv {
	readonly #quota: StorageQuotaPort;

	constructor(options: { readonly cwd: string }, quota: StorageQuotaPort) {
		super(options);
		this.#quota = quota;
	}

	override async writeFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		try {
			await this.#quota.ensureCapacity(contentBytes(content));
		} catch (error) {
			return { ok: false, error: new FileError("permission_denied", messageOf(error), path) };
		}
		const result = await super.writeFile(path, content, context);
		this.#quota.invalidate();
		return result;
	}

	override async appendFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		try {
			await this.#quota.ensureCapacity(contentBytes(content));
		} catch (error) {
			return { ok: false, error: new FileError("permission_denied", messageOf(error), path) };
		}
		const result = await super.appendFile(path, content, context);
		this.#quota.invalidate();
		return result;
	}

	override async truncateFile(
		path: string,
		size: number,
		context: Context,
	): Promise<Result<void, FileError>> {
		try {
			await this.#quota.ensureCapacity(size);
		} catch (error) {
			return { ok: false, error: new FileError("permission_denied", messageOf(error), path) };
		}
		const result = await super.truncateFile(path, size, context);
		this.#quota.invalidate();
		return result;
	}

	override async createDir(
		path: string,
		options: { readonly recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		try {
			await this.#quota.ensureCapacity(0);
		} catch (error) {
			return { ok: false, error: new FileError("permission_denied", messageOf(error), path) };
		}
		const result = await super.createDir(path, options, context);
		this.#quota.invalidate();
		return result;
	}

	override async createTempDir(
		prefix: string | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		try {
			await this.#quota.ensureCapacity(0);
		} catch (error) {
			return { ok: false, error: new FileError("permission_denied", messageOf(error)) };
		}
		return super.createTempDir(prefix, context);
	}

	override async createTempFile(
		options: { readonly prefix?: string; readonly suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		try {
			await this.#quota.ensureCapacity(0);
		} catch (error) {
			return { ok: false, error: new FileError("permission_denied", messageOf(error)) };
		}
		return super.createTempFile(options, context);
	}

	/** A shell command may write anything, so it is admitted only while the
	 * quota has room. The next tool call re-measures: one command can overshoot,
	 * but no further write is admitted after it. */
	override async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		try {
			await this.#quota.ensureCapacity(0);
		} catch (error) {
			return { ok: false, error: new ExecutionError("spawn_error", messageOf(error)) };
		}
		const result = await super.exec(command, options, context);
		this.#quota.invalidate();
		return result;
	}

	override async remove(
		path: string,
		options: { readonly recursive?: boolean; readonly force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const result = await super.remove(path, options, context);
		this.#quota.invalidate();
		return result;
	}
}
