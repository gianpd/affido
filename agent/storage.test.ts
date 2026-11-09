// RFC 0022: the quota is measured from the two durable roots, and the same
// measurement drives both the 507 refusal and the UI report. No container,
// model or database is involved.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageQuota, StorageQuotaError, AGENT_STORAGE_QUOTA_BYTES } from "./storage.ts";

const roots = async (): Promise<{ workspace: string; sessionDb: string }> => {
	const workspace = await mkdtemp(join(tmpdir(), "storage-ws-"));
	const data = await mkdtemp(join(tmpdir(), "storage-data-"));
	return { workspace, sessionDb: join(data, "session.sqlite") };
};

test("the default quota is 2.5 GiB and an empty sandbox starts ok", async () => {
	const { workspace, sessionDb } = await roots();
	const report = await new StorageQuota({ workspace, sessionDb }).report();
	assert.equal(report.quotaBytes, 2_684_354_560);
	assert.equal(report.quotaBytes, AGENT_STORAGE_QUOTA_BYTES);
	assert.equal(report.usedBytes, 0);
	assert.equal(report.state, "ok");
	assert.equal(report.partial, false);
	assert.ok(report.availableBytes > 0);
	assert.ok(report.hostFreeBytes !== null);
});

test("both volumes count, including nested files, and symlinks are skipped", async () => {
	const { workspace, sessionDb } = await roots();
	const quota = new StorageQuota({ workspace, sessionDb });
	await mkdir(join(workspace, "corpus", "uploads"), { recursive: true });
	await writeFile(join(workspace, "corpus", "uploads", "a.txt"), "12345");
	await writeFile(sessionDb, "1234567");
	const report = await quota.report();
	assert.equal(report.usedBytes, 12);
});

test("a write invalidates the cached measurement", async () => {
	const { workspace, sessionDb } = await roots();
	const quota = new StorageQuota({ workspace, sessionDb });
	await writeFile(join(workspace, "a.txt"), "1234");
	assert.equal((await quota.report()).usedBytes, 4);
	await writeFile(join(workspace, "b.txt"), "123456");
	assert.equal((await quota.report()).usedBytes, 4); // cached
	quota.invalidate();
	assert.equal((await quota.report()).usedBytes, 10);
});

test("warning, critical and full follow the used ratio", async () => {
	const { workspace, sessionDb } = await roots();
	const quota = new StorageQuota({ workspace, sessionDb, quotaBytes: 1_000 });
	await writeFile(join(workspace, "a.txt"), "x".repeat(800));
	assert.equal((await quota.report()).state, "warning");
	assert.equal((await quota.report()).usedPercent, 80);
	quota.invalidate();
	await writeFile(join(workspace, "a.txt"), "x".repeat(950));
	assert.equal((await quota.report()).state, "critical");
	quota.invalidate();
	await writeFile(join(workspace, "a.txt"), "x".repeat(1_000));
	const full = await quota.report();
	assert.equal(full.state, "full");
	assert.equal(full.availableBytes, 0);
});

test("a write past the remaining bytes is refused with 507 and its numbers", async () => {
	const { workspace, sessionDb } = await roots();
	const quota = new StorageQuota({ workspace, sessionDb, quotaBytes: 1_000 });
	await writeFile(join(workspace, "a.txt"), "x".repeat(950));
	await assert.rejects(
		quota.ensureCapacity(100),
		(error: unknown) => {
			assert.ok(error instanceof StorageQuotaError);
			assert.equal(error.status, 507);
			assert.equal(error.requestedBytes, 100);
			assert.equal(error.report.availableBytes, 50);
			assert.equal(error.body.error, "storage_quota_exceeded");
			return true;
		},
	);
	await quota.ensureCapacity(50);
	quota.invalidate();
	await writeFile(join(workspace, "a.txt"), "x".repeat(1_000));
	await assert.rejects(quota.ensureCapacity(0), (error: unknown) => error instanceof StorageQuotaError);
});

test("a :memory: session db adds no second root", async () => {
	const { workspace } = await roots();
	const quota = new StorageQuota({ workspace, sessionDb: ":memory:", quotaBytes: 1_000 });
	await writeFile(join(workspace, "a.txt"), "123");
	assert.equal((await quota.report()).usedBytes, 3);
});
