// RFC 0022: model tool calls go through the same quota as HTTP uploads. A
// refused `write`/`edit` becomes a normal tool error, and a full quota stops
// `bash` from writing more.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { QuotaExecutionEnv } from "./quota-env.ts";
import { StorageQuota } from "./storage.ts";

const setup = async (): Promise<{ env: QuotaExecutionEnv; quota: StorageQuota; workspace: string }> => {
	const workspace = await mkdtemp(join(tmpdir(), "quota-env-"));
	const data = await mkdtemp(join(tmpdir(), "quota-env-data-"));
	const quota = new StorageQuota({
		workspace,
		sessionDb: join(data, "session.sqlite"),
		quotaBytes: 200,
	});
	return { env: new QuotaExecutionEnv({ cwd: workspace }, quota), quota, workspace };
};

test("a write within the quota lands, one past it is refused as a tool error", async () => {
	const { env, quota, workspace } = await setup();
	const first = await env.writeFile(join(workspace, "a.txt"), "x".repeat(50), BACKGROUND_CONTEXT);
	assert.equal(first.ok, true);
	assert.equal((await quota.report()).usedBytes, 50);

	const denied = await env.writeFile(join(workspace, "b.txt"), "x".repeat(200), BACKGROUND_CONTEXT);
	assert.equal(denied.ok, false);
	if (!denied.ok) assert.match(denied.error.message, /storage_quota_exceeded/);
	assert.equal((await quota.report()).usedBytes, 50);
});

test("bash is refused once the quota is full and admitted again after a delete", async () => {
	const { env, quota, workspace } = await setup();
	const path = join(workspace, "a.txt");
	const written = await env.writeFile(path, "x".repeat(200), BACKGROUND_CONTEXT);
	assert.equal(written.ok, true);
	assert.equal((await quota.report()).availableBytes, 0);

	const refused = await env.exec(["node", "-e", "0"], undefined, BACKGROUND_CONTEXT);
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.match(refused.error.message, /storage_quota_exceeded/);

	const removed = await env.remove(path, undefined, BACKGROUND_CONTEXT);
	assert.equal(removed.ok, true);
	assert.equal((await quota.report()).usedBytes, 0);
	const admitted = await env.exec(["node", "-e", "0"], undefined, BACKGROUND_CONTEXT);
	assert.equal(admitted.ok, true);
});

test("a write outside the process does not bypass the next check", async () => {
	const { env, quota, workspace } = await setup();
	await writeFile(join(workspace, "outside.txt"), "x".repeat(200));
	const denied = await env.writeFile(join(workspace, "next.txt"), "x", BACKGROUND_CONTEXT);
	assert.equal(denied.ok, false);
	assert.equal((await quota.report()).state, "full");
});
