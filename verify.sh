#!/usr/bin/env bash
# Gate: typecheck + unit tests, then the end-to-end checks through Caddy.
#
# Sandbox agents are not compose services: the manager creates them on demand
# from affido-agent:latest, so this script builds that image itself.
#
# Usage: ./verify.sh
set -euo pipefail

cd "$(dirname "$0")"

# The lifecycle check waits for a real L0 pause and L1 stop. Keep both short;
# the manager reads these at container start (see docker-compose.yml).
export STOP_AFTER_S="${STOP_AFTER_S:-25}"
export EVICT_TICK_S="${EVICT_TICK_S:-2}"

COMPOSE=(docker compose)

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }

# RFC 0012: the KEK of the BYOK provider keys. Compose mounts it read-only into
# the manager only; docker would turn a missing file into a directory, so it
# must exist before any `up`. Random once, 0600, gitignored with all of secrets/.
ensure_kek() {
	# secrets/ is gitignored, so it does not exist in a fresh clone: create it
	# or the redirect below fails with "No such file or directory" in CI.
	if [ ! -f secrets/llm_key_kek ]; then
		umask 077
		mkdir -p secrets
		openssl rand -base64 32 > secrets/llm_key_kek
		pass "created secrets/llm_key_kek (BYOK KEK, base64 of 32 bytes)"
	fi
}

ensure_manager_token() {
	# Pentest W1 (2026-10): never run the stack on the well-known compose
	# default dev-manager-token — the manager's bridge IP answers any local
	# process, and the manager refuses that default at startup
	# (sandbox_manager.py enforce_token_default). Same pattern as ensure_kek.
	if ! grep -q '^MANAGER_TOKEN=' .env 2>/dev/null; then
		# The operator's .env may lack a trailing newline: prepend one or the
		# token glues onto the last line and both settings break.
		if [ -f .env ] && [ -n "$(tail -c 1 .env 2>/dev/null)" ]; then
			printf '\n' >> .env
		fi
		printf 'MANAGER_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env
		chmod 600 .env
		pass "created MANAGER_TOKEN in .env (random per stack)"
	fi
}

require_runsc() {
	# gVisor is mandatory (the sidecar key delivery is cleartext HTTP on the
	# per-user bridge; under runc a root agent with CAP_NET_RAW can ARP-spoof
	# the sidecar and capture it). sandbox-manager itself fails closed at boot
	# without runsc — this probe makes the gate fail earlier and louder.
	if docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null \
		| grep -qw runsc; then
		pass "docker daemon serves the runsc runtime (gVisor, mandatory)"
	else
		fail "docker daemon has no runsc runtime: gVisor is mandatory (install it; the manager will refuse to boot without it)"
	fi
}

echo "== typecheck: server.ts must pass tsc --noEmit =="
(
	cd agent
	# Install (dev) dependencies only when missing; the gate itself is npm run typecheck.
	if [ ! -x node_modules/.bin/tsc ]; then npm ci --no-audit --no-fund >/dev/null; fi
	npm run typecheck >/dev/null
) || fail "agent does not type-check"
pass "server.ts passes tsc --noEmit (strict)"

echo "== unit tests: agent runs on an injected HarnessLifecycle =="
(
	cd agent
	npm test >/dev/null
) || fail "agent unit tests"
pass "ContainerAgent passes on a fake lifecycle (node --test)"

echo "== build the sandbox agent image =="
docker build -q -t affido-agent:latest ./agent >/dev/null || fail "agent image build failed"
pass "affido-agent:latest built"

echo "== image gate: closed toolbox (RFC 0009 D3) =="
# The installer must not exist in the runtime image: the command itself fails.
for binary in npm npx corepack; do
	if docker run --rm --network none affido-agent:latest "${binary}" --version >/dev/null 2>&1; then
		fail "${binary} must be absent from the runtime image"
	fi
done
pass "npm, npx and corepack are absent (command not found)"
# The baked runtime libraries resolve through NODE_PATH, with no network.
docker run --rm --network none affido-agent:latest \
	node -e "require('docx'); require('unpdf')" >/dev/null 2>&1 \
	|| fail "require('docx')/require('unpdf') must resolve through NODE_PATH"
pass "docx and unpdf resolve in the image without network"

echo "== marketplace bundle: manifest hashes are fresh (RFC 0009 R1) =="
node marketplace/manifest.mjs --check >/dev/null || fail "marketplace manifest is stale: run node marketplace/manifest.mjs"
pass "catalog manifest matches the bundle"

echo "== build and start the control plane =="
ensure_kek
ensure_manager_token
require_runsc
# Start from a clean control plane: the BYOK phase below recreates the manager
# twice more per run, and back-to-back runs on containerd-store daemons can
# otherwise leave a manager container on a garbage-collected image digest.
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
# Pin the image this script just built: the gate runs the keyless faux
# provider, so the e2e answers (including the scripted citation dance of RFC
# 0006) are deterministic. AGENT_EGRESS is pinned off for the keyless phases
# too: an operator .env with AGENT_EGRESS=open (BYOK in use) would otherwise
# leak through compose interpolation and the egress gate below would see
# egress=open instead of the keyless default it asserts. A local
# docker-compose.override.yml may point interactive stacks elsewhere; this
# override holds only for this invocation.
AGENT_IMAGE=affido-agent:latest AGENT_EGRESS=off "${COMPOSE[@]}" up -d --build >/dev/null
pass "caddy, oltp and sandbox-manager are up"

echo "== manager unit tests: BYOK crypto and baseUrl rules (RFC 0012 M1) =="
"${COMPOSE[@]}" exec -T sandbox-manager python3 -m unittest test_sandbox_manager >/dev/null \
	|| fail "manager unit tests failed"
pass "KEK round-trip, AAD swap, baseUrl rules (python3 -m unittest)"

echo "== RFC 0003: happy path + parallel responses =="
./e2e-test/run.sh

echo "== RFC 0012 M1/M4: /providers API in the default (egress-off) stack =="
./e2e-test/providers.sh

echo "== RFC 0003: sandbox lifecycle =="
./verify-sandbox.sh

echo "== RFC 0003: security containment negatives =="
./e2e-test/security.sh

echo "== RFC 0012 M2/M3/M5: BYOK chain against the fake upstream =="
# The BYOK chain runs exactly as production BYOK would (egress open), with the
# provider pointed at a same-network fake upstream instead of the internet.
# Ran last so the default keyless suites above keep their egress-off stack.
docker build -q -t affido-e2e-fake-upstream ./e2e-test/fake-upstream >/dev/null || fail "fake upstream build failed"
AGENTS_NET="$(docker network ls --filter label=com.docker.compose.network=agents --format '{{.Name}}' | head -1)"
[ -n "${AGENTS_NET}" ] || fail "cannot find the compose agents network"
docker rm -f e2e-fake-upstream >/dev/null 2>&1 || true
docker run -d --name e2e-fake-upstream --network "${AGENTS_NET}" --restart unless-stopped \
	affido-e2e-fake-upstream >/dev/null || fail "fake upstream did not start"
AGENT_IMAGE=affido-agent:latest AGENT_EGRESS=open PROVIDER_DEV_HTTP=1 FAKE_UPSTREAM_CONTAINER=e2e-fake-upstream \
	"${COMPOSE[@]}" up -d >/dev/null || fail "BYOK stack did not start"
./e2e-test/byok.sh

echo "== restore the default (keyless, egress-off) stack =="
docker rm -f e2e-fake-upstream >/dev/null
# Pin AGENT_EGRESS=off like the keyless phases above: the BYOK phase exported
# it open in this process, and an operator .env may carry open too — without
# the pin the "restored" stack keeps NAT egress and the security negatives
# (internet_reachable) fail on any later standalone re-run.
AGENT_IMAGE=affido-agent:latest AGENT_EGRESS=off "${COMPOSE[@]}" up -d >/dev/null
pass "stack restored: faux default, no fake upstream"

echo
echo "ALL CHECKS PASSED"
