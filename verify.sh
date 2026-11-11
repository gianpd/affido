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
# The identity e2e performs several logins in one minute. Keep the production
# defaults for interactive stacks, but never let a back-to-back gate run trip
# its own throttle; the rate limiter itself is covered by the manager tests.
export IDENTITY_LOGIN_PER_MINUTE="${IDENTITY_LOGIN_PER_MINUTE:-60}"
export IDENTITY_REGISTER_PER_HOUR="${IDENTITY_REGISTER_PER_HOUR:-100}"

COMPOSE=(docker compose)

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }

# The manager does real work at boot (catalog extraction, network checks), and
# every later `up -d` that changes its env recreates it: the next suite must
# not race that window with a 502. Poll its /healthz until it answers.
wait_manager() {
	for _ in $(seq 1 30); do
		if "${COMPOSE[@]}" exec -T sandbox-manager python3 -c \
			"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=2)" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	fail "sandbox-manager did not become ready"
}

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

has_env_value() { # name: an empty assignment does not count
	grep -qE "^$1=.+" .env 2>/dev/null
}

append_env() { # name value
	if [ -f .env ] && [ -n "$(tail -c 1 .env 2>/dev/null)" ]; then
		printf '\n' >> .env
	fi
	printf '%s=%s\n' "$1" "$2" >> .env
	chmod 600 .env
}

ensure_identity_config() {
	# RFC 0023: the manager seals better-auth cookies, so it needs the same
	# secret the web app verifies with. Copy frontend/.env's dev secret when it
	# exists; otherwise generate one (the e2e verifies signatures with it).
	if ! has_env_value BETTER_AUTH_SECRET; then
		local secret=""
		if [ -f frontend/.env ]; then
			secret="$(sed -n 's/^BETTER_AUTH_SECRET=//p' frontend/.env | tail -1 | tr -d '"' | tr -d "'")"
		fi
		[ -n "${secret}" ] || secret="$(openssl rand -base64 32)"
		append_env BETTER_AUTH_SECRET "${secret}"
		pass "added BETTER_AUTH_SECRET to .env (matched to frontend/.env when present)"
	fi
	if ! has_env_value IDENTITY_API_KEY; then
		append_env IDENTITY_API_KEY "$(openssl rand -base64 32)"
		pass "created IDENTITY_API_KEY in .env (scoped X-Identity-Key)"
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

# RFC 0016: the web-search node dials SearXNG and Camofox. The gate runs an
# e2e-only fake stack (one container, both listeners) on the internal
# `websearch-in` network, so the whole chain is exercised without the operator's
# services or the open internet. Both URLs use the container name: the manager
# bakes it into each node's /etc/hosts.
export SEARXNG_URL="http://e2e-fake-search:8080"
export CAMOFOX_URL="http://e2e-fake-search:9377"
export CAMOFOX_API_KEY="e2e-camofox-key"
export WEBSEARCH_IN="${WEBSEARCH_IN:-websearch-in}"

# RFC 0024: the MCP node dials operator-reviewed MCP servers. The gate offers
# the catalog's `fake` entry (never on a real deployment) and runs the e2e
# stand-in on `mcp-in`; MCP_ADMISSION_KEY is the secret Caddy stamps on
# /prompt and the manager delivers to every node. Both shared networks are
# created here with exactly the shape the manager would create them with, so
# its fail-closed shape checks see the intended topology.
export MCP_SERVERS="${MCP_SERVERS:-fake}"
export MCP_ADMISSION_KEY="${MCP_ADMISSION_KEY:-$(openssl rand -hex 32)}"
export MCP_IN="${MCP_IN:-mcp-in}"
export MCP_OUT="${MCP_OUT:-mcp-out}"

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

echo "== web search (RFC 0016): internal network + fake search stack =="
if ! docker network inspect "${WEBSEARCH_IN}" >/dev/null 2>&1; then
	docker network create --internal \
		--opt com.docker.network.bridge.enable_ip_masquerade=false \
		--label pi-affido-websearch=1 "${WEBSEARCH_IN}" >/dev/null
fi
[[ "$(docker network inspect -f '{{.Internal}}' "${WEBSEARCH_IN}")" == "true" ]] \
	|| fail "${WEBSEARCH_IN} must be --internal: the web-search node has no egress"
docker build -q -t affido-e2e-fake-search ./e2e-test/fake-search >/dev/null || fail "fake search stack build failed"
docker rm -f e2e-fake-search >/dev/null 2>&1 || true
docker run -d --name e2e-fake-search --network "${WEBSEARCH_IN}" --restart unless-stopped \
	affido-e2e-fake-search >/dev/null || fail "fake search stack did not start"
pass "websearch-in (internal) and the e2e fake SearXNG/Camofox are up"

echo "== mcp (RFC 0024): operator network + fake MCP server =="
if ! docker network inspect "${MCP_IN}" >/dev/null 2>&1; then
	docker network create --internal \
		--opt com.docker.network.bridge.enable_ip_masquerade=false \
		--label pi-affido-mcp=1 "${MCP_IN}" >/dev/null
fi
if ! docker network inspect "${MCP_OUT}" >/dev/null 2>&1; then
	docker network create \
		--opt com.docker.network.bridge.enable_icc=false \
		--label pi-affido-mcp=1 "${MCP_OUT}" >/dev/null
fi
[[ "$(docker network inspect -f '{{.Internal}}' "${MCP_IN}")" == "true" ]] \
	|| fail "${MCP_IN} must be --internal: the MCP node's operator leg has no egress"
[[ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.enable_icc"}}' "${MCP_OUT}")" == "false" ]] \
	|| fail "${MCP_OUT} must disable inter-container traffic (T7)"
docker build -q -t affido-e2e-fake-mcp ./e2e-test/fake-mcp >/dev/null || fail "fake MCP server build failed"
docker rm -f e2e-fake-mcp >/dev/null 2>&1 || true
docker run -d --name e2e-fake-mcp --network "${MCP_IN}" --network-alias e2e-fake-mcp \
	--restart unless-stopped affido-e2e-fake-mcp >/dev/null || fail "fake MCP server did not start"
pass "mcp-in (internal) + mcp-out (icc off) and the e2e fake MCP server are up"

echo "== build and start the control plane =="
ensure_kek
ensure_manager_token
ensure_identity_config
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
wait_manager
pass "caddy, oltp and sandbox-manager are up"

echo "== manager unit tests: BYOK crypto and baseUrl rules (RFC 0012 M1) =="
"${COMPOSE[@]}" exec -T sandbox-manager python3 -m unittest test_sandbox_manager >/dev/null \
	|| fail "manager unit tests failed"
pass "KEK round-trip, AAD swap, baseUrl rules (python3 -m unittest)"

echo "== RFC 0003: happy path + parallel responses =="
./e2e-test/run.sh

echo "== RFC 0016: web-search node, tool contract, taint gate =="
./e2e-test/websearch.sh

echo "== RFC 0024: MCP node, manifest authority, write gate, taint, revocation =="
./e2e-test/mcp.sh

echo "== RFC 0023: machine identity surface (register/login/logout/whoami) =="
./e2e-test/identity.sh

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
wait_manager
./e2e-test/byok.sh

echo "== restore the default (keyless, egress-off) stack =="
docker rm -f e2e-fake-upstream >/dev/null
# The fake search and MCP stacks are e2e-only; the networks stay (manager-owned
# networks, harmless when no services are attached).
docker rm -f e2e-fake-search >/dev/null 2>&1 || true
docker rm -f e2e-fake-mcp >/dev/null 2>&1 || true
# Pin AGENT_EGRESS=off like the keyless phases above: the BYOK phase exported
# it open in this process, and an operator .env may carry open too — without
# the pin the "restored" stack keeps NAT egress and the security negatives
# (internet_reachable) fail on any later standalone re-run. Drop the e2e search
# and MCP surface too, so the restored manager points at the operator's
# services (or the defaults) rather than at the fake stacks just removed.
(
	unset SEARXNG_URL CAMOFOX_URL CAMOFOX_API_KEY MCP_SERVERS MCP_ADMISSION_KEY
	AGENT_IMAGE=affido-agent:latest AGENT_EGRESS=off "${COMPOSE[@]}" up -d >/dev/null
)
pass "stack restored: faux default, no fake upstream, operator search and MCP surfaces"

echo
echo "ALL CHECKS PASSED"
