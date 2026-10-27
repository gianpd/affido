// Containment probe for e2e-test/security.sh. Runs INSIDE an attacker sandbox
// (docker exec, the same netns and node the agent's bash tool would use) and
// prints one JSON object; a non-zero "breach" field is a failure.
//
//   node security-probe.mjs <victim-container> <manager-token>
const victim = process.argv[2] ?? "";
const token = process.argv[3] ?? "";
import net from "node:net";
import dns from "node:dns";
import os from "node:os";
import { readFileSync } from "node:fs";

const out = { gateway: null, gatewayPg: null, hostService: null, internet: null, managerMetrics: null, managerPause: null, victimDial: null, victimIp: null, victimSidecar: null, victimSidecarIp: null, ptrace: null, coreLimit: null };

// default-route gateway from /proc/net/route (hex, little-endian words).
// --internal networks have no default route, so fall back to the subnet's own
// gateway (first address of the interface subnet): that address is the host
// side of the bridge and must be unreachable from the sandbox.
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
if (!out.gateway) {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal) {
				const toInt = (s) => s.split(".").map(Number);
				const ip = toInt(a.address), mask = toInt(a.netmask);
				const netw = ip.map((o, i) => o & mask[i]);
				netw[3] |= 1;
				out.gateway = netw.join(".");
				break;
			}
		}
		if (out.gateway) break;
	}
}

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

// 1. host-local services on the gateway: the published Postgres must be loopback-only,
//    and a generic 0.0.0.0-bound host service (port from argv) must be unreachable
//    at all — --internal leaves no route off the subnet.
if (out.gateway) {
	out.gatewayPg = await tcp(out.gateway, 15432, 4000);
	if (process.argv[4]) out.hostService = await tcp(out.gateway, Number(process.argv[4]), 4000);
}
// 2. public internet
out.internet = await tcp("1.1.1.1", 80, 4000);
// 3. the manager API: a sandbox peer must be refused even with the right token
out.managerMetrics = await http("http://sandbox-manager:8090/metrics", { headers: { "x-manager-token": token } });
out.managerPause = await http("http://sandbox-manager:8090/pause", {
	method: "POST",
	headers: { "content-type": "application/json", "x-manager-token": token },
	body: JSON.stringify({ user_id: "nobody" }),
});
// 4. another tenant's agent and its key sidecar (RFC 0013 §9.2: the sidecar
//    adds one target, same subnet wall)
if (victim) {
	out.victimIp = await new Promise((resolve) => dns.lookup(victim, { family: 4 }, (e, a) => resolve(e ? `dns:${e.code}` : a)));
	if (!String(out.victimIp).startsWith("dns:")) out.victimDial = await tcp(out.victimIp, 8080, 3000);
	else out.victimDial = out.victimIp;
	const victimSidecar = `${victim}-sidecar`;
	out.victimSidecarIp = await new Promise((resolve) => dns.lookup(victimSidecar, { family: 4 }, (e, a) => resolve(e ? `dns:${e.code}` : a)));
	if (!String(out.victimSidecarIp).startsWith("dns:")) out.victimSidecar = await tcp(out.victimSidecarIp, 8081, 3000);
	else out.victimSidecar = out.victimSidecarIp;
}

// 5. Phase 0 (RFC 0013 §6.4), from inside the sandbox: a tool child must not
//    read the server process's memory, and cores must be off. The ptrace probe
//    is a bash child of THIS node process opening /proc/$PPID/mem — the exact
//    §2.1 step-5 gesture — and must fail (non-zero) under both runsc and runc.
{
	const { spawnSync } = await import("node:child_process");
	const probe = spawnSync("bash", ["-c", "exec 3< /proc/$PPID/mem"]);
	out.ptrace = { status: probe.status, stderr: String(probe.stderr).trim() };
	const ulimitc = spawnSync("sh", ["-c", "ulimit -c"]);
	out.coreLimit = String(ulimitc.stdout).trim();
}

out.breach =
	(out.gatewayPg === "connect:ok" ? "gateway_pg_reachable " : "") +
	(out.hostService === "connect:ok" ? "host_service_reachable " : "") +
	(out.internet === "connect:ok" ? "internet_reachable " : "") +
	(out.managerMetrics.status === 200 ? "manager_answered_sandbox " : "") +
	(out.managerPause.status === 200 ? "manager_pausable " : "") +
	(out.victimDial === "connect:ok" ? "victim_agent_reachable " : "") +
	(out.victimSidecar === "connect:ok" ? "victim_sidecar_reachable " : "") +
	(out.ptrace.status === 0 ? "ptrace_opened_parent_mem " : "") +
	(out.coreLimit !== "0" ? "core_dumps_enabled" : "");
console.log(JSON.stringify(out));
