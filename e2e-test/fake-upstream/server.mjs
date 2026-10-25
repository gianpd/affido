// RFC 0012 §10 M2: an e2e-only fake OpenAI-compatible upstream. Implements
// GET /v1/models and streaming POST /v1/chat/completions exactly as pi-ai's
// openai-completions API expects, records every Authorization header it saw,
// and exposes the log at GET /_log for the e2e assertions (delivery once,
// rotation changes the bearer, validation hits /v1/models).
//
// Keys containing "bad-key" are rejected with 401 so the manager's optional
// upstream validation (§5.6) has an invalid_key case to catch.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8090);
const ANSWER =
	"The fake upstream answered: the maintenance file says the contract renews tacitly on 1 March 2027.";

/** [{path, auth}] in arrival order; GET /_log reads it, POST /_reset clears it. */
const log = [];

const chatChunk = (delta, finishReason = null) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-e2e",
		object: "chat.completion.chunk",
		created: 1,
		model: "e2e-fake-1",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;

const server = createServer((req, res) => {
	const auth = req.headers.authorization ?? "";
	const url = new URL(req.url ?? "/", "http://e2e-fake-upstream");

	if (url.pathname !== "/_log" && url.pathname !== "/_reset") log.push({ path: url.pathname, auth });

	if (req.method === "GET" && url.pathname === "/_log") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(log));
		return;
	}
	if (req.method === "POST" && url.pathname === "/_reset") {
		log.length = 0;
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
		return;
	}
	if (req.method === "GET" && url.pathname === "/v1/models") {
		if (!auth.startsWith("Bearer ") || auth.includes("bad-key")) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "invalid key" } }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: "e2e-fake-1", object: "model" }] }));
		return;
	}
	if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
		if (!auth.startsWith("Bearer ")) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "missing bearer" } }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			res.write(chatChunk({ role: "assistant", content: "" }));
			res.write(chatChunk({ content: ANSWER }));
			res.write(chatChunk({}, "stop"));
			res.write("data: [DONE]\n\n");
			res.end();
		});
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`e2e fake upstream on :${PORT} (chat answer: ${ANSWER.slice(0, 40)}...)`);
});
