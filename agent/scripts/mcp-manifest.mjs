#!/usr/bin/env node
// RFC 0024 §6.3: generate one candidate catalog entry from a live server.
//
//   node scripts/mcp-manifest.mjs --id worldgraph --url http://127.0.0.1:8766/mcp \
//        --token "$(cat ~/.config/worldgraph/agent2.token)" --network mcp-in
//
// Reads tools/list (bearer-authenticated, stateless HTTP) and writes the entry
// with REAL names and REAL schemas, descriptions replaced by
// "TODO(operator): explain this tool" and tier set to "read". The operator
// rewrites each description, moves side-effecting tools to "write", and
// commits; the unit test fails on any remaining TODO. Adding a server is a
// reviewed diff, not a module.

const args = process.argv.slice(2);
const flag = (name) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? undefined : args[at + 1];
};

const id = flag("id");
const url = flag("url");
const token = flag("token");
const network = flag("network") ?? "mcp-out";
const title = flag("title") ?? id;
if (!id || !url) {
	console.error("usage: mcp-manifest.mjs --id <server-id> --url <http…/mcp> [--token wgt_…] [--network mcp-in|mcp-out] [--title …]");
	process.exit(2);
}
if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
	console.error(`--id must match ^[a-z][a-z0-9-]{0,31}$ (got "${id}")`);
	process.exit(2);
}
if (network !== "mcp-in" && network !== "mcp-out") {
	console.error("--network must be mcp-in or mcp-out");
	process.exit(2);
}

const post = async (method, params) => {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: `manifest-${method}`, method, params }),
	});
	if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
	const body = await response.json();
	if (body.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
	return body.result;
};

const result = await post("tools/list", {});
const tools = (result?.tools ?? []).map((tool) => ({
	name: tool.name,
	description: `TODO(operator): explain this tool`,
	tier: "read",
	parameters: tool.inputSchema ?? { type: "object", properties: {}, required: [], additionalProperties: false },
}));

const entry = {
	id,
	title,
	url,
	host: new URL(url).hostname,
	network,
	auth: { kind: "bearer", required: Boolean(token) },
	limits: { timeoutMs: 30000, maxResultBytes: 65536, maxResultChars: 6000, requestsPerMinute: 30, concurrency: 2 },
	tools,
};

process.stdout.write(`${JSON.stringify(entry, null, "\t")}\n`);
console.error(`${tools.length} tools written; rewrite every description, set tiers, then commit (§6.3)`);
