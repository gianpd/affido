// Containment probe for e2e-test/security.sh. Runs INSIDE an attacker sandbox
// (docker exec, the same netns and node the agent's bash tool would use) and
// prints one JSON object; a non-zero "breach" field is a failure.
//
//   node security-probe.mjs <victim-container> <manager-token>
const victim = process.argv[2] ?? "";
const token = process.argv[3] ?? "";
import net from "node:net";
import dns from "node:dns";
import { readFileSync } from "node:fs";

const out = { gateway: null, gatewayPg: null, internet: null, managerMetrics: null, managerPause: null, victimDial: null, victimIp: null };

// default-route gateway from /proc/net/route (hex, little-endian words)
try {
	for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length > 2 && cols[1] === "00000000") {
			const gw = cols[2];
			out.gateway = [gw.slice(6, 8), gw.slice(4, 6), gw.slice(2, 4), gw.slice(0, 2)]
				.map((h) => parseInt(h, 16)).join(".");
			break;
		}
	}
} catch { /* leave null */ }

const tcp = (host, port, ms) => new Promise((resolve) => {
	const s = net.connect({ host, port });
	const t = setTimeout(() => { s.destroy(); resolve(`connect:timeout`); }, ms);
	s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("connect:ok"); });
	s.on("error", (e) => { clearTimeout(t); resolve(`connect:${e.code ?? e.message}`); });
});

const http = async (url, init) => {
	try {
		const r = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
		return { status: r.status, body: (await r.text()).slice(0, 120) };
	} catch (e) {
		return { status: 0, body: String(e.cause?.code ?? e.message).slice(0, 120) };
	}
};

// 1. host-local services on the gateway (the published Postgres must be loopback-only)
if (out.gateway) out.gatewayPg = await tcp(out.gateway, 15432, 4000);
// 2. public internet
out.internet = await tcp("1.1.1.1", 80, 4000);
// 3. the manager API: a sandbox peer must be refused even with the right token
out.managerMetrics = await http("http://sandbox-manager:8090/metrics", { headers: { "x-manager-token": token } });
out.managerPause = await http("http://sandbox-manager:8090/pause", {
	method: "POST",
	headers: { "content-type": "application/json", "x-manager-token": token },
	body: JSON.stringify({ user_id: "nobody" }),
});
// 4. another tenant's agent
if (victim) {
	out.victimIp = await new Promise((resolve) => dns.lookup(victim, { family: 4 }, (e, a) => resolve(e ? `dns:${e.code}` : a)));
	if (!String(out.victimIp).startsWith("dns:")) out.victimDial = await tcp(out.victimIp, 8080, 3000);
	else out.victimDial = out.victimIp;
}

out.breach =
	(out.gatewayPg === "connect:ok" ? "gateway_pg_reachable " : "") +
	(out.internet === "connect:ok" ? "internet_reachable " : "") +
	(out.managerMetrics.status === 200 ? "manager_answered_sandbox " : "") +
	(out.managerPause.status === 200 ? "manager_pausable " : "") +
	(out.victimDial === "connect:ok" ? "victim_agent_reachable" : "");
console.log(JSON.stringify(out));
