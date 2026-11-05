// RFC 0016 §5/§6/§7: the web-search node. Exercises the shared response
// schemas, opaque source ids, no URL argument, budgets, the per-run
// authorisation gate, and the SearXNG / Camofox clients against local fakes.
// No Docker, no manager.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import {
	MAX_READ_CHARS,
	MAX_RESULTS,
	MAX_SEARCHES_PER_RUN,
	createWebsearchServer,
	focusTermsOf,
	peerAllowed,
	selectReadWindow,
	type WebsearchOptions,
	type WebsearchServer,
} from "./websearch.ts";
import {
	isWebError,
	isWebReadEnvelope,
	isWebSearchEnvelope,
	type WebReadEnvelope,
	type WebSearchEnvelope,
} from "./web-protocol.ts";

type Fake = { readonly url: string; readonly close: () => Promise<void>; readonly calls: string[] };
type Reply = { readonly status: number; readonly body: unknown };

const CONTROL = "c".repeat(64);

const listen = async (server: Server): Promise<{ url: string; close: () => Promise<void> }> => {
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeIdleConnections();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
};

const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const fakeSearxng = async (): Promise<Fake> => {
	const calls: string[] = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://fake");
		calls.push(url.search);
		const results = [
			{ title: "First page", url: "https://example.com/first", content: "first snippet" },
			{ title: "Second page", url: "https://example.com/second", content: "second snippet" },
			// Duplicate, non-http and private-address entries must be dropped: the
			// browser has egress, and the node must never point it at the host's
			// bridge, a tenant network or the cloud metadata endpoint.
			{ title: "Duplicate", url: "https://example.com/first", content: "dup" },
			{ title: "Not http", url: "file:///etc/passwd", content: "no" },
			{ title: "Metadata", url: "http://169.254.169.254/latest/meta-data", content: "no" },
			{ title: "Loopback", url: "http://localhost:8080/secret", content: "no" },
			{ title: "Private", url: "http://10.0.0.5/admin", content: "no" },
			{ title: "Private v6", url: "http://[::1]/secret", content: "no" },
			{ title: "Mapped v4", url: "http://[::ffff:127.0.0.1]/secret", content: "no" },
			{ title: "Third page", url: "https://example.org/third", content: "third snippet" },
		];
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ results }));
	});
	const listening = await listen(server);
	return { ...listening, calls };
};

const fakeSearxngUnavailableFirstCall = async (): Promise<Fake> => {
	const calls: string[] = [];
	let seen = 0;
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://fake");
		calls.push(url.search);
		seen += 1;
		// The default engine set plus all six fallbacks fail once; the next
		// search call is healthy. A failed call must not spend the run budget.
		if (seen <= 7) {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "upstream" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ results: [{ title: "Recovered", url: "https://example.com/recovered", content: "ok" }] }));
	});
	const listening = await listen(server);
	return { ...listening, calls };
};

const fakeCamofox = async (text: string, evaluateStatus = 200, totalChars = text.length): Promise<Fake> => {
	const calls: string[] = [];
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://fake");
			calls.push(`${req.method} ${url.pathname}`);
			if (req.method === "POST" && url.pathname === "/tabs") {
				await body(req);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ tabId: "tab-1", url: "https://example.com/first" }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/tabs/tab-1/evaluate") {
				await body(req);
				if (evaluateStatus !== 200) {
					res.writeHead(evaluateStatus, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "unauthorized" }));
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, result: JSON.stringify({ title: "First page", text, totalChars }) }));
				return;
			}
			if (req.method === "DELETE" && url.pathname === "/tabs/tab-1") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
		})();
	});
	const listening = await listen(server);
	return { ...listening, calls };
};

const searchEnvelopeOf = (result: Reply): WebSearchEnvelope => {
	if (!isWebSearchEnvelope(result.body)) throw new Error(`not a /search envelope: ${JSON.stringify(result.body)}`);
	return result.body;
};

const readEnvelopeOf = (result: Reply): WebReadEnvelope => {
	if (!isWebReadEnvelope(result.body)) throw new Error(`not a /read envelope: ${JSON.stringify(result.body)}`);
	return result.body;
};

const errorOf = (result: Reply): string => {
	if (!isWebError(result.body)) throw new Error(`not a web error: ${JSON.stringify(result.body)}`);
	return result.body.error;
};

const call = async (
	node: WebsearchServer,
	path: string,
	payload: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<Reply> => {
	const response = await fetch(`http://127.0.0.1:${node.port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(payload),
	});
	return { status: response.status, body: await response.json() };
};

/** A data call: x-run-id + the per-run token + a trusted call id. */
const post = (
	node: WebsearchServer,
	path: string,
	payload: Record<string, unknown>,
	runId: string,
	runToken?: string,
	callId = "test-call",
): Promise<Reply> =>
	call(node, path, payload, {
		...(runId === "" ? {} : { "x-run-id": runId }),
		...(runToken === undefined ? {} : { "x-run-token": runToken }),
		"x-call-id": callId,
	});

/** Register one run the way the trusted admission path does. */
const register = async (
	node: WebsearchServer,
	runId: string,
	web = true,
	control = CONTROL,
): Promise<{ status: number; token: string | undefined }> => {
	const result = await call(node, "/runs", { web }, { "x-control-token": control, "x-run-id": runId });
	const value = result.body as { runToken?: unknown };
	return { status: result.status, token: typeof value.runToken === "string" ? value.runToken : undefined };
};

const start = (options: Partial<WebsearchOptions> = {}): Promise<WebsearchServer> =>
	createWebsearchServer({
		host: "127.0.0.1",
		port: 0,
		peers: ["127.0.0.1/32"],
		controlToken: CONTROL,
		readDelayMs: 0,
		...options,
	});

test("peerAllowed matches the sandbox CIDR and refuses everything else", () => {
	assert.equal(peerAllowed("10.5.0.2", ["10.5.0.0/16"]), true);
	assert.equal(peerAllowed("::ffff:10.5.0.2", ["10.5.0.0/16"]), true);
	assert.equal(peerAllowed("10.6.0.2", ["10.5.0.0/16"]), false);
	assert.equal(peerAllowed("127.0.0.1", ["10.5.0.0/16"]), false);
	assert.equal(peerAllowed("10.5.0.2", []), false);
	assert.equal(peerAllowed(undefined, ["10.5.0.0/16"]), false);
});

test("selectReadWindow keeps a deep focus marker inside the 6000-character cap", () => {
	const deep = "x".repeat(7_000) + " renewal marker " + "y".repeat(7_000);
	const selection = selectReadWindow(deep, focusTermsOf(["renewal"]));
	assert.equal(selection.text.length, MAX_READ_CHARS);
	assert.match(selection.text, /renewal marker/);
	assert.equal(selection.window.mode, "head+focus");
	assert.ok(selection.window.start > selection.window.headChars);
});

test("search falls back to one engine when the default set is suspended", async () => {
	const calls: string[] = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://fake");
		calls.push(url.search);
		const engine = url.searchParams.get("engines");
		const results = engine === "bing" ? [{ title: "Bing page", url: "https://example.com/bing", content: "bing" }] : [];
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ results, unresponsive_engines: engine === null ? [["brave", "Suspended: timeout"]] : [] }));
	});
	const listening = await listen(server);
	const camofox = await fakeCamofox("x");
	const node = await start({ searxngUrl: listening.url, camofoxUrl: camofox.url });
	try {
		const runToken = (await register(node, "run-cascade")).token ?? "";
		const search = await post(node, "/search", { query: "renewal" }, "run-cascade", runToken);
		assert.equal(search.status, 200);
		const envelope = searchEnvelopeOf(search);
		assert.equal(envelope.requestId, "test-call");
		assert.equal(envelope.results.length, 1);
		assert.equal(envelope.results[0]?.title, "Bing page");
		assert.equal(envelope.diagnostics.fallbackUsed, true);
		assert.deepEqual(envelope.diagnostics.enginesTried, ["default", "bing"]);
		assert.ok(envelope.diagnostics.suspendedEngines.includes("brave"));
		assert.equal(calls.length, 2, "the default set is asked once, then the first fallback engine");
		assert.match(calls[0] ?? "", /format=json/);
		assert.doesNotMatch(calls[0] ?? "", /engines=/);
		assert.match(calls[1] ?? "", /engines=bing/);
	} finally {
		await node.close();
		await listening.close();
		await camofox.close();
	}
});

test("a failed upstream search does not spend the per-run budget", async () => {
	const searxng = await fakeSearxngUnavailableFirstCall();
	const node = await start({ searxngUrl: searxng.url });
	try {
		const token = (await register(node, "run-retry")).token ?? "";
		const failed = await post(node, "/search", { query: "fail once" }, "run-retry", token);
		assert.equal(failed.status, 502);
		assert.equal(errorOf(failed), "search_unavailable");
		for (let index = 0; index < MAX_SEARCHES_PER_RUN; index++) {
			const ok = await post(node, "/search", { query: `q${index}` }, "run-retry", token);
			assert.equal(ok.status, 200, `search ${index + 1} after the failure should be allowed`);
		}
		const exhausted = await post(node, "/search", { query: "one too many" }, "run-retry", token);
		assert.equal(exhausted.status, 429);
		assert.equal(errorOf(exhausted), "budget_exhausted");
	} finally {
		await node.close();
		await searxng.close();
	}
});

test("a search stack that refuses every attempt is a named error", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "upstream" }));
	});
	const listening = await listen(server);
	const node = await start({ searxngUrl: listening.url });
	try {
		const runToken = (await register(node, "run-refused")).token ?? "";
		const search = await post(node, "/search", { query: "renewal" }, "run-refused", runToken);
		assert.equal(search.status, 502);
		assert.equal(errorOf(search), "search_unavailable");
	} finally {
		await node.close();
		await listening.close();
	}
});

test("a Camofox auth refusal is named, not reported as an empty page", async () => {
	const searxng = await fakeSearxng();
	const camofox = await fakeCamofox("x", 401);
	const node = await start({ searxngUrl: searxng.url, camofoxUrl: camofox.url, camofoxKey: "" });
	try {
		const runToken = (await register(node, "run-camofox")).token ?? "";
		const search = await post(node, "/search", { query: "renewal" }, "run-camofox", runToken);
		const sourceId = searchEnvelopeOf(search).results[0]?.sourceId ?? "";
		const read = await post(node, "/read", { sourceId }, "run-camofox", runToken);
		assert.equal(read.status, 502);
		if (!isWebError(read.body)) throw new Error("not a web error");
		assert.equal(read.body.error, "read_unavailable");
		assert.match(read.body.message, /401/);
	} finally {
		await node.close();
		await searxng.close();
		await camofox.close();
	}
});

test("web_search returns opaque ids and web_read resolves only ids of this run", async () => {
	const searxng = await fakeSearxng();
	const camofox = await fakeCamofox("The page text.");
	const node = await start({ searxngUrl: searxng.url, camofoxUrl: camofox.url, camofoxKey: "key", userId: "user-slug" });
	try {
		const runToken = (await register(node, "run-1")).token ?? "";
		assert.notEqual(runToken, "");
		const search = await post(node, "/search", { query: "renewal", max: MAX_RESULTS }, "run-1", runToken);
		assert.equal(search.status, 200);
		const envelope = searchEnvelopeOf(search);
		const results = envelope.results;
		assert.equal(results.length, 3, "duplicates, non-http and private-address results are dropped");
		assert.equal(results[0]?.domain, "example.com");
		assert.match(results[0]?.sourceId ?? "", /^web_[A-Za-z0-9_-]+$/);
		assert.ok(!(results[0]?.sourceId ?? "").includes("example.com"), "the id leaks no URL");
		assert.equal(new Set(results.map((result) => result.sourceId)).size, results.length);
		assert.equal(envelope.diagnostics.resultCount, 3);
		assert.equal(envelope.diagnostics.partial, true, "dropped results make the answer partial");

		const sourceId = results[0]?.sourceId ?? "";
		const read = await post(node, "/read", { sourceId }, "run-1", runToken);
		assert.equal(read.status, 200);
		const readEnvelope = readEnvelopeOf(read);
		const page = readEnvelope.page;
		assert.equal(readEnvelope.requestId, "test-call");
		assert.equal(page.untrusted, true);
		assert.equal(page.url, "https://example.com/first");
		assert.equal(page.title, "First page");
		assert.equal(page.text, "The page text.");
		assert.equal(page.sha256, createHash("sha256").update("The page text.").digest("hex"));
		assert.equal(page.truncated, false);
		assert.equal(page.totalChars, "The page text.".length);
		assert.equal(readEnvelope.diagnostics.window.mode, "full");
		assert.equal(readEnvelope.diagnostics.selectedChars, page.text.length);
		// Camofox closed the tab: no shared history between runs.
		assert.ok(camofox.calls.includes("DELETE /tabs/tab-1"));

		// A URL argument never reaches a fetch: it is refused by name.
		const byUrl = await post(node, "/read", { url: "https://example.com/first" }, "run-1", runToken);
		assert.equal(byUrl.status, 400);
		assert.equal(errorOf(byUrl), "no_url_in_arguments");

		// A well-formed id issued to another run is unknown here.
		const runToken2 = (await register(node, "run-2")).token ?? "";
		const otherRun = await post(node, "/read", { sourceId }, "run-2", runToken2);
		assert.equal(otherRun.status, 404);
		assert.equal(errorOf(otherRun), "unknown_source");

		// One read per result.
		const again = await post(node, "/read", { sourceId }, "run-1", runToken);
		assert.equal(again.status, 429);
		assert.equal(errorOf(again), "already_read");

		// Reads of results this run never received stay refused.
		const fabricated = await post(node, "/read", { sourceId: "web_other_run_3" }, "run-1", runToken);
		assert.equal(fabricated.status, 404);
		assert.equal(errorOf(fabricated), "unknown_source");
	} finally {
		await node.close();
		await searxng.close();
		await camofox.close();
	}
});

test("only a user-authorised, registered run with its token can search", async () => {
	const searxng = await fakeSearxng();
	const camofox = await fakeCamofox("x");
	// Start without a control token: nothing can be registered until the
	// manager delivers one (RFC 0016 §7, fail closed).
	const node = await createWebsearchServer({
		host: "127.0.0.1",
		port: 0,
		peers: ["127.0.0.1/32"],
		searxngUrl: searxng.url,
		camofoxUrl: camofox.url,
		readDelayMs: 0,
	});
	try {
		const unset = await register(node, "run-unset");
		assert.equal(unset.status, 503);
		// The manager's delivery.
		const control = await call(node, "/control", { token: CONTROL });
		assert.equal(control.status, 200);
		// Only the same token is accepted afterwards.
		const mismatch = await call(node, "/control", { token: "d".repeat(64) });
		assert.equal(mismatch.status, 403);
		assert.equal(errorOf(mismatch), "control_token_mismatch");

		// A registration without the control token is refused.
		const noControl = await call(node, "/runs", { web: true }, { "x-run-id": "run-x" });
		assert.equal(noControl.status, 403);
		assert.equal(errorOf(noControl), "forbidden_control");

		// A run the user did not authorise is refused, token or not.
		const offToken = (await register(node, "run-off", false)).token ?? "";
		const off = await post(node, "/search", { query: "x" }, "run-off", offToken);
		assert.equal(off.status, 403);
		assert.equal(errorOf(off), "web_not_authorized");

		// An authorised run still needs the per-run token.
		const onToken = (await register(node, "run-on")).token ?? "";
		const missing = await post(node, "/search", { query: "x" }, "run-on");
		assert.equal(missing.status, 403);
		assert.equal(errorOf(missing), "not_authorized");
		const wrong = await post(node, "/search", { query: "x" }, "run-on", "wrong-token");
		assert.equal(wrong.status, 403);
		const ok = await post(node, "/search", { query: "x" }, "run-on", onToken);
		assert.equal(ok.status, 200);

		// An id never registered is not authorised, even with a plausible token.
		const unknown = await post(node, "/search", { query: "x" }, "run-never", "made-up-token");
		assert.equal(unknown.status, 403);
		assert.equal(errorOf(unknown), "web_not_authorized");
	} finally {
		await node.close();
		await searxng.close();
		await camofox.close();
	}
});

test("budgets, bounds and the peer guard are enforced by the node", async () => {
	const searxng = await fakeSearxng();
	const camofox = await fakeCamofox("x".repeat(20_000));
	const node = await start({ searxngUrl: searxng.url, camofoxUrl: camofox.url });
	const closed = await start({ searxngUrl: searxng.url, camofoxUrl: camofox.url, peers: ["10.0.0.0/8"] });
	try {
		// The fifth search of one run is refused; another run starts fresh.
		const budgetToken = (await register(node, "run-budget")).token ?? "";
		for (let index = 0; index < MAX_SEARCHES_PER_RUN; index++) {
			const result = await post(node, "/search", { query: `q${index}` }, "run-budget", budgetToken);
			assert.equal(result.status, 200, `search ${index + 1} should be allowed`);
		}
		const exhausted = await post(node, "/search", { query: "one too many" }, "run-budget", budgetToken);
		assert.equal(exhausted.status, 429);
		assert.equal(errorOf(exhausted), "budget_exhausted");
		const freshToken = (await register(node, "run-2")).token ?? "";
		const fresh = await post(node, "/search", { query: "fresh" }, "run-2", freshToken);
		assert.equal(fresh.status, 200);

		// Query length and result count bounds, on an authorised run.
		const boundsToken = (await register(node, "run-bounds")).token ?? "";
		const long = await post(node, "/search", { query: "x".repeat(257) }, "run-bounds", boundsToken);
		assert.equal(long.status, 413);
		assert.equal(errorOf(long), "query_too_long");
		const tooMany = await post(node, "/search", { query: "x", max: MAX_RESULTS + 1 }, "run-bounds", boundsToken);
		assert.equal(tooMany.status, 400);

		// The read text is capped before it leaves the node, and the envelope
		// says how much was omitted.
		const readToken = (await register(node, "run-3")).token ?? "";
		const search = await post(node, "/search", { query: "renewal" }, "run-3", readToken);
		const sourceId = searchEnvelopeOf(search).results[0]?.sourceId ?? "";
		const read = await post(node, "/read", { sourceId }, "run-3", readToken);
		assert.equal(read.status, 200);
		const readEnvelope = readEnvelopeOf(read);
		assert.equal(readEnvelope.page.text.length, MAX_READ_CHARS);
		assert.equal(readEnvelope.page.truncated, true);
		assert.equal(readEnvelope.page.totalChars, 20_000);
		assert.equal(readEnvelope.diagnostics.selectedChars, MAX_READ_CHARS);

		// Peer outside the user's subnet: forbidden before any upstream call.
		const before = searxng.calls.length;
		const forbidden = await post(closed, "/search", { query: "should not run" }, "run-x", "token");
		assert.equal(forbidden.status, 403);
		assert.equal(errorOf(forbidden), "forbidden_peer");
		assert.equal(searxng.calls.length, before);

		// No run id: the caller (the agent tool) always sets one.
		const noRun = await post(node, "/search", { query: "x" }, "", "token");
		assert.equal(noRun.status, 400);
		assert.equal(errorOf(noRun), "missing_run");
	} finally {
		await node.close();
		await closed.close();
		await searxng.close();
		await camofox.close();
	}
});

test("a missing search stack is a named error, not a crash", async () => {
	const node = await start();
	try {
		const health = await fetch(`http://127.0.0.1:${node.port}/health`);
		assert.equal(health.status, 200);
		const runToken = (await register(node, "run-1")).token ?? "";
		const search = await post(node, "/search", { query: "renewal" }, "run-1", runToken);
		assert.equal(search.status, 503);
		assert.equal(errorOf(search), "search_unavailable");
	} finally {
		await node.close();
	}
});
