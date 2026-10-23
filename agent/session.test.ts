// Integration test of RFC 0008: a "new session" is a separate conversation the
// sandbox switches to durably. Runs the real SQLite-backed DurableHarness with
// the faux model, and asserts the pointer survives close/reopen, the old
// conversation stays readable through /inspect, and /reset keeps its own
// semantics (same conversation, context cut).

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ContainerAgent, createAgentRegistry } from "./agent.ts";
import { DurableHarness } from "./harness.ts";
import { createModel } from "./model.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";
import type { ModelBundle, PromptResult } from "./types.ts";
import type { TraceReport } from "./trace.ts";

const buildAgent = async (
	workspace: string,
	sessionDb: string,
	bundle?: ModelBundle
) => {
	const { models, model } = bundle ?? (await createModel());
	const context = BACKGROUND_CONTEXT;
	const store = new WorkspaceCitationStore(new NodeExecutionEnv({ cwd: workspace }), context);
	const harness = new DurableHarness({
		openOptions: {
			models,
			registry: createAgentRegistry({ name: "test", workspace, store }),
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
		},
		rootOptions: { agent: { model, cwd: workspace, thinkingLevel: "off" as const } },
		context,
		sessionDb,
		idleMs: 60_000,
		log: () => {},
	});
	const agent = new ContainerAgent({
		name: "test",
		workspace,
		sessionDb,
		idleMs: 60_000,
		models,
		model,
		context,
		log: () => {},
		harness,
	});
	return agent;
};

test("a provider failure settles unanswered and reports the stored detail", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "session-agent-"));
	const sessionDb = join(workspace, "session.sqlite");
	// A faux provider with no queued responses: every model call fails, the
	// error is non-retryable, and the run settles `model_error` with a detail.
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([]);

	const agent = await buildAgent(workspace, sessionDb, {
		models,
		model: { provider: "faux", modelId: "faux-1" }
	});
	await agent.seedWorkspace();

	const result = (await agent.prompt("list the files", "err-1", "off")) as PromptResult;

	assert.equal(result.status, "unanswered");
	assert.equal(result.reason, "model_error");
	assert.ok(
			result.reasonDetail !== null && result.reasonDetail.includes("No more faux responses"),
		`reasonDetail should carry the provider error, got: ${result.reasonDetail}`
	);
	await agent.close();
});

test("newSession switches to a separate conversation that survives restart", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "session-agent-"));
	const sessionDb = join(workspace, "session.sqlite");
	const agent = await buildAgent(workspace, sessionDb);
	await agent.seedWorkspace();

	// Conversation 1 gets two prompts, so it holds real entries.
	const first = (await agent.prompt("list the files", "s1", "off")) as PromptResult;
	assert.equal(first.status, "done");
	assert.equal(first.conversationId, 1);

	const started = (await agent.newSession()) as { conversationId: number; entries: number };
	const secondId = started.conversationId;
	assert.notEqual(secondId, 1, "newSession creates a conversation distinct from the root");
	assert.ok(Number.isInteger(secondId) && secondId > 1, `unexpected conversation id ${secondId}`);
	assert.equal(started.entries, 0, "the new conversation starts empty");

	// The next prompt lands in the new conversation; conversation 1 is untouched.
	const second = (await agent.prompt("list the files again", "s2", "off")) as PromptResult;
	assert.equal(second.conversationId, secondId);

	// The default trace is the new conversation; conversation 1 is still readable.
	const current = (await agent.inspect({ limit: 50 })) as TraceReport;
	assert.equal(current.conversationId, secondId);
	assert.ok(current.entries.items.length > 0);
	const old = (await agent.inspect({ conversationId: 1 as never, limit: 50 })) as TraceReport;
	assert.equal(old.conversationId, 1);
	assert.ok(
		old.entries.items.some((item) => item.summary.includes("list the files")),
		"conversation 1 kept the first prompt's entries",
	);

	// The pointer is durable: after close and reopen, the new conversation is still active.
	await agent.close();
	const reopened = await buildAgent(workspace, sessionDb);
	const third = (await reopened.prompt("and again", "s3", "off")) as PromptResult;
	assert.equal(third.conversationId, secondId, "reopen keeps the active-conversation pointer");

	// Reset keeps its own semantics: same conversation, context cut.
	const reset = (await reopened.reset()) as { conversationId: number };
	assert.equal(reset.conversationId, secondId, "reset cuts context without switching conversation");
	const afterReset = (await reopened.inspect({ limit: 50 })) as TraceReport;
	assert.equal(afterReset.conversationId, secondId);
	await reopened.close();
});

test("switchSession resumes a previous conversation and survives restart", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "session-agent-"));
	const sessionDb = join(workspace, "session.sqlite");
	const agent = await buildAgent(workspace, sessionDb);
	await agent.seedWorkspace();

	// Conversation 1 holds a real prompt; a second session takes the pointer away.
	const first = (await agent.prompt("list the files", "sw1", "off")) as PromptResult;
	assert.equal(first.conversationId, 1);
	const secondId = ((await agent.newSession()) as { conversationId: number }).conversationId;
	const second = (await agent.prompt("list the files again", "sw2", "off")) as PromptResult;
	assert.equal(second.conversationId, secondId);

	// Switching back reports conversation 1 with its entries, and the next
	// prompt lands in it: the model sees that conversation's context again.
	const switched = (await agent.switchSession(1)) as { conversationId: number; entries: number };
	assert.equal(switched.conversationId, 1);
	assert.ok(switched.entries > 0, "the resumed conversation reports its entries");
	const third = (await agent.prompt("and once more", "sw3", "off")) as PromptResult;
	assert.equal(third.conversationId, 1);
	const trace = (await agent.inspect({ limit: 50 })) as TraceReport;
	assert.equal(trace.conversationId, 1);
	assert.ok(
		trace.entries.items.some((item) => item.summary.includes("and once more")),
		"the prompt after the switch landed in conversation 1",
	);

	// An unknown conversation id is rejected, never silently ignored.
	await assert.rejects(() => agent.switchSession(999), /does not exist/);

	// The switch is durable: after close and reopen, conversation 1 is still active.
	await agent.close();
	const reopened = await buildAgent(workspace, sessionDb);
	const fourth = (await reopened.prompt("after reopen", "sw4", "off")) as PromptResult;
	assert.equal(fourth.conversationId, 1, "reopen keeps the switched conversation active");
	await reopened.close();
});
