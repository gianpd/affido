// Tool schemas are the wire contract with every catalog provider (RFC 0012):
// the same registrations travel unchanged to openai, deepseek, groq, ... and
// each provider validates them server-side with a different JSON Schema
// dialect. DeepSeek validates with 2020-12 and rejects draft-4 tuple syntax
// (array-form `items`) with 400 "Invalid schema for function ..." before the
// first token — observed 2026-10-25 on corpus_read.lineRange, which settled
// every prompt as model_error until the tuple was replaced with a bounded
// number-array. A schema valid in both draft-07 and 2020-12 is valid for the
// whole catalog, so this test validates every installed tool's parameters
// against both meta-schemas: no provider may ever see an unportable schema.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createAgentRegistry } from "./agent.ts";
import { WorkspaceCitationStore } from "./workspace-store.ts";

type JsonObject = { readonly [key: string]: unknown };

const registryTools = async (): Promise<readonly { readonly name: string; readonly parameters: JsonObject }[]> => {
	const workspace = await mkdtemp(join(tmpdir(), "tool-schemas-"));
	const store = new WorkspaceCitationStore(new NodeExecutionEnv({ cwd: workspace }), BACKGROUND_CONTEXT);
	const registry = createAgentRegistry({ name: "schema-test", workspace, store });
	return registry.snapshot().tools().map(({ tool }) => {
		const parameters = tool.parameters as JsonObject | undefined;
		assert.ok(parameters !== undefined, `${tool.name} has no parameter schema`);
		return { name: tool.name, parameters };
	});
};

test("every installed tool schema validates as JSON Schema draft-07 and 2020-12", async () => {
	const draft7 = new Ajv({ strict: false });
	const draft2020 = new Ajv2020({ strict: false });
	const tools = await registryTools();
	// CodingTools (read, write, edit, bash) plus the five citation tools; a
	// shrinking count means a registration silently disappeared from the wire.
	assert.ok(tools.length >= 9, `expected at least 9 tools, got ${tools.length}`);
	for (const { name, parameters } of tools) {
		const valid7 = draft7.validateSchema(parameters);
		assert.ok(valid7, `${name} is not draft-07: ${JSON.stringify(draft7.errors)}`);
		const valid2020 = draft2020.validateSchema(parameters);
		assert.ok(valid2020, `${name} is not 2020-12 (the DeepSeek gate): ${JSON.stringify(draft2020.errors)}`);
	}
});

test("corpus_read.lineRange is a bounded number-array, never draft-4 tuple items", async () => {
	const tools = await registryTools();
	const read = tools.find((tool) => tool.name === "corpus_read");
	assert.ok(read !== undefined, "corpus_read is not installed");
	const properties = read.parameters["properties"] as JsonObject;
	const lineRange = properties["lineRange"] as JsonObject;
	assert.equal(lineRange["type"], "array");
	assert.deepEqual(lineRange["items"], { type: "number" });
	assert.equal(lineRange["minItems"], 2);
	assert.equal(lineRange["maxItems"], 2);
});
