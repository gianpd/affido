// In-container probe. Harness injects __WEBEVAL_JOB__ and pipes this file to
// `node --input-type=module -` inside either the sandbox agent or its web-search
// node. It emits one JSON object per line on stdout.
//
// The `cases` mode reproduces agent/web-tools.ts `postNode()` exactly: POST to
// the node with x-run-id and x-run-token, 30 s abort, redirect: "error". It is
// the tool transport edge, driven from inside the agent container.

import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

const JOB = __WEBEVAL_JOB__;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");

const tcp = (host, port, ms = 2000) =>
	new Promise((resolve) => {
		let done = false;
		const finish = (result) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve(result);
		};
		const socket = connect({ host, port });
		socket.setTimeout(ms);
		socket.once("connect", () => finish({ ok: true }));
		socket.once("timeout", () => finish({ ok: false, error: "timeout" }));
		socket.once("error", (error) => finish({ ok: false, error: error.code ?? String(error) }));
	});

const http = async (url, options = {}) => {
	const { method = "GET", headers = {}, body, timeout = 30_000 } = options;
	const started = performance.now();
	try {
		const response = await fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(timeout),
		});
		const text = await response.text();
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = null;
		}
		return {
			status: response.status,
			ms: Math.round(performance.now() - started),
			body: parsed,
			raw: parsed === null ? text.slice(0, 2000) : undefined,
		};
	} catch (error) {
		return {
			status: 0,
			ms: Math.round(performance.now() - started),
			error: error instanceof Error ? error.message : String(error),
		};
	}
};

// Strict identity: scheme + host (without www) + path (without trailing
// slash). Query strings and fragments are ignored; http and https are not.
const normalizeUrl = (value) => {
	try {
		const parsed = new URL(value);
		return (parsed.protocol + "//" + parsed.hostname.replace(/^www\./, "") + parsed.pathname.replace(/\/+$/, "")).toLowerCase();
	} catch {
		return String(value).toLowerCase();
	}
};

const domainOf = (value) => String(value ?? "").replace(/^www\./, "").toLowerCase();

const connectivity = async () => {
	const hosts = readFileSync("/etc/hosts", "utf8");
	const base = (process.env.WEBSEARCH_URL ?? "").replace(/\/+$/, "");
	const nodeHost = base === "" ? "" : new URL(base).hostname;
	const checks = {};
	checks.node_tcp = await tcp(nodeHost, JOB.nodePort ?? 8082, 3000);
	checks.node_health = await http(`${base}/health`, { timeout: 5000 });
	checks.node_status = await http(`${base}/status`, { timeout: 5000 });
	for (const target of JOB.targets ?? []) {
		checks[`tcp_${target.name}`] = await tcp(target.ip, target.port, 2000);
		checks[`http_${target.name}`] = await http(target.url, { timeout: 3000 });
		try {
			const address = await lookup(target.host);
			checks[`dns_${target.name}`] = { ok: true, address: address.address };
		} catch (error) {
			checks[`dns_${target.name}`] = { ok: false, error: error.code ?? String(error) };
		}
	}
	emit({ type: "connectivity", base, hosts, checks });
};

const upstream = async () => {
	const checks = {};
	const searchUrl = `${JOB.searxngUrl.replace(/\/+$/, "")}/search?${new URLSearchParams({ q: JOB.probeQuery, format: "json" })}`;
	checks.searxng_search = await http(searchUrl, { timeout: 20_000 });
	checks.camofox_health = await http(`${JOB.camofoxUrl.replace(/\/+$/, "")}/health`, { timeout: 10_000 });
	checks.self_status = await http("http://127.0.0.1:8082/status", { timeout: 5000 });
	const results = Array.isArray(checks.searxng_search.body?.results) ? checks.searxng_search.body.results : [];
	emit({ type: "upstream", checks, searxng_result_count: results.length, hosts: readFileSync("/etc/hosts", "utf8") });
};

const cases = async () => {
	for (const item of JOB.cases) {
		const headers = {
			"content-type": "application/json",
			"x-run-id": item.runId,
			"x-run-token": item.runToken,
		};
		const payload = { query: item.query, max: item.max ?? 8 };
		if (item.lang) payload.lang = item.lang;
		const search = await http(`${JOB.nodeBase}/search`, {
			method: "POST",
			headers,
			body: payload,
			timeout: 30_000,
		});
		const results = Array.isArray(search.body?.results) ? search.body.results : [];
		// web_search deliberately returns no URL: only sourceId, title, domain
		// and snippet. A gold URL can therefore be targeted only by reading
		// domain-matched opaque ids and comparing the URL in the read response.
		const candidates = [];
		let goldReached = false;
		let matchedUrl = null;
		let fallback = false;
		if (item.kind === "url" && search.status === 200) {
			const goldDomain = domainOf(new URL(item.goldUrl).hostname);
			for (const result of results) {
				if (domainOf(result.domain) === goldDomain && typeof result.sourceId === "string") {
					candidates.push(result);
					if (candidates.length >= (item.maxReads ?? 3)) break;
				}
			}
			if (candidates.length === 0 && JOB.readFirstOnMiss === true) {
				const first = results.find((result) => typeof result.sourceId === "string");
				if (first !== undefined) candidates.push(first);
				fallback = true;
			}
		}
		const reads = [];
		for (const candidate of candidates) {
			const response = await http(`${JOB.nodeBase}/read`, {
				method: "POST",
				headers,
				body: { sourceId: candidate.sourceId },
				timeout: 30_000,
			});
			const page = response.body?.page ?? {};
			const url = typeof page.url === "string" ? page.url : null;
			const isGold = url !== null && normalizeUrl(url) === normalizeUrl(item.goldUrl);
			reads.push({ sourceId: candidate.sourceId, domain: candidate.domain, title: candidate.title, isGold, response });
			if (isGold && !goldReached) {
				goldReached = true;
				matchedUrl = url;
				break;
			}
		}
		emit({
			type: "case",
			id: item.id,
			kind: item.kind,
			queryId: item.queryId,
			urlId: item.urlId,
			repetition: item.repetition,
			query: item.query,
			goldUrl: item.goldUrl ?? null,
			search,
			reads,
			fallback,
			matchedUrl,
			goldReached,
			resultCount: results.length,
		});
	}
	emit({ type: "done", cases: JOB.cases.length });
};

if (JOB.mode === "connectivity") await connectivity();
else if (JOB.mode === "upstream") await upstream();
else if (JOB.mode === "cases") await cases();
else emit({ type: "error", message: `unknown mode ${JOB.mode}` });
