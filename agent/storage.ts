// Per-sandbox disk quota (RFC 0022): one logical 2.5 GiB ceiling shared by the
// workspace volume and the session volume. Docker named volumes have no size
// limit of their own, so the agent measures its own two roots and refuses a
// write that would cross the ceiling. The measurement is also the wire report
// `GET /storage` returns; monitoring and enforcement read the same numbers.
//
// Nothing here opens the Harness: a quota check is plain filesystem work, so a
// probe cannot defeat the idle pause.

import { lstat, readdir, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Dirent } from "node:fs";
import { HttpError } from "./http.ts";

/** 2.5 GiB: the per-agent ceiling of RFC 0022. */
export const AGENT_STORAGE_QUOTA_BYTES = 2_684_354_560;

export const STORAGE_WARN_RATIO = 0.8;
export const STORAGE_CRITICAL_RATIO = 0.95;

/** One measurement stays fresh for two seconds; writes invalidate it. */
const CACHE_TTL_MS = 2_000;
/** Bounds one scan so a tree of millions of empty files cannot pin the probe. */
const MAX_SCAN_ENTRIES = 100_000;

export type StorageState = "ok" | "warning" | "critical" | "full";

export type StorageReport = {
	readonly quotaBytes: number;
	readonly usedBytes: number;
	/** Bytes the agent may still write: min(quota - used, host free space). */
	readonly availableBytes: number;
	/** Free bytes of the host filesystem behind the volumes; null if unreadable. */
	readonly hostFreeBytes: number | null;
	readonly usedPercent: number;
	readonly state: StorageState;
	/** True when the entry cap cut the scan short; `usedBytes` is then a lower bound. */
	readonly partial: boolean;
	readonly checkedAt: number;
};

/** 507 Insufficient Storage, with the numbers that caused the refusal. */
export class StorageQuotaError extends HttpError {
	readonly report: StorageReport;
	readonly requestedBytes: number;

	constructor(report: StorageReport, requestedBytes: number) {
		super(507, {
			error: "storage_quota_exceeded",
			message: `agent storage quota exceeded: ${report.usedBytes} of ${report.quotaBytes} bytes used, ${report.availableBytes} available, ${requestedBytes} requested`,
			quotaBytes: report.quotaBytes,
			usedBytes: report.usedBytes,
			availableBytes: report.availableBytes,
			requestedBytes,
			state: report.state,
		});
		this.name = "StorageQuotaError";
		this.report = report;
		this.requestedBytes = requestedBytes;
	}
}

/** The two durable roots of one sandbox. `:memory:` (tests) and a session db
 * inside the workspace do not add a second root, or the scan would double count. */
const rootsOf = (workspace: string, sessionDb: string): readonly string[] => {
	const workspaceRoot = resolve(workspace);
	const roots = [workspaceRoot];
	if (isAbsolute(sessionDb)) {
		const dataRoot = resolve(dirname(sessionDb));
		if (dataRoot !== workspaceRoot && !dataRoot.startsWith(`${workspaceRoot}/`)) roots.push(dataRoot);
	}
	return roots;
};

/** Logical bytes of regular files below one root. Symlinks are skipped: they
 * are not owned bytes and must never turn the walk into a cycle. */
const scanRoot = async (root: string): Promise<{ readonly used: number; readonly partial: boolean }> => {
	let used = 0;
	let seen = 0;
	let partial = false;
	const walk = async (dir: string): Promise<void> => {
		const entries: readonly Dirent[] = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
		for (const entry of entries) {
			if (partial) return;
			if (seen >= MAX_SCAN_ENTRIES) {
				partial = true;
				return;
			}
			seen++;
			if (entry.isSymbolicLink()) continue;
			const path = join(dir, entry.name);
			const info = await lstat(path).catch(() => null);
			if (info === null) continue;
			if (info.isFile()) used += info.size;
			else if (info.isDirectory()) await walk(path);
		}
	};
	await walk(root);
	return { used, partial };
};

const freeBytesOf = async (roots: readonly string[]): Promise<number | null> => {
	const values: number[] = [];
	for (const root of roots) {
		const stats = await statfs(root).catch(() => null);
		if (stats !== null) values.push(Math.max(0, stats.bavail * stats.bsize));
	}
	return values.length === 0 ? null : Math.min(...values);
};

const stateOf = (used: number, quota: number, available: number): StorageState => {
	if (available === 0) return "full";
	const ratio = used / Math.max(quota, 1);
	if (ratio >= STORAGE_CRITICAL_RATIO) return "critical";
	if (ratio >= STORAGE_WARN_RATIO) return "warning";
	return "ok";
};

/** One quota for one sandbox. Injectable roots and ceiling keep it testable
 * without a database, a container, or a Docker daemon. */
export class StorageQuota {
	readonly #roots: readonly string[];
	readonly #quotaBytes: number;
	#cached: { readonly at: number; readonly report: StorageReport } | undefined;

	constructor(input: {
		readonly workspace: string;
		readonly sessionDb: string;
		readonly quotaBytes?: number;
	}) {
		this.#roots = rootsOf(input.workspace, input.sessionDb);
		this.#quotaBytes = input.quotaBytes ?? AGENT_STORAGE_QUOTA_BYTES;
	}

	/** Measure now, or return the cached measurement. Never throws on a missing
	 * root: a fresh volume simply reads as empty. */
	async report(): Promise<StorageReport> {
		const now = Date.now();
		if (this.#cached !== undefined && now - this.#cached.at < CACHE_TTL_MS) return this.#cached.report;
		const scans = await Promise.all(this.#roots.map((root) => scanRoot(root)));
		const usedBytes = scans.reduce((sum, scan) => sum + scan.used, 0);
		const hostFreeBytes = await freeBytesOf(this.#roots);
		const remaining = Math.max(0, this.#quotaBytes - usedBytes);
		const availableBytes = Math.max(0, Math.min(remaining, hostFreeBytes ?? Number.POSITIVE_INFINITY));
		const report: StorageReport = {
			quotaBytes: this.#quotaBytes,
			usedBytes,
			availableBytes,
			hostFreeBytes,
			usedPercent: Math.round((Math.min(usedBytes, this.#quotaBytes) / Math.max(this.#quotaBytes, 1)) * 1_000) / 10,
			state: stateOf(usedBytes, this.#quotaBytes, availableBytes),
			partial: scans.some((scan) => scan.partial),
			checkedAt: now,
		};
		this.#cached = { at: now, report };
		return report;
	}

	/** Admission check for one write. `0` means "no new bytes", used by shell
	 * commands and directory creation: they are refused once the quota is full. */
	async ensureCapacity(requestedBytes: number): Promise<StorageReport> {
		const report = await this.report();
		if (report.availableBytes === 0 || requestedBytes > report.availableBytes) {
			throw new StorageQuotaError(report, requestedBytes);
		}
		return report;
	}

	/** A write or delete happened: the cached measurement is stale. */
	invalidate(): void {
		this.#cached = undefined;
	}
}
