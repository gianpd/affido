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
# Pin the image this script just built and disable any local secrets mount: the
# gate runs the keyless faux provider, so the e2e answers (including the
# scripted citation dance of RFC 0006) are deterministic. A local
# docker-compose.override.yml may point interactive stacks at a real provider;
# these environment overrides hold only for this invocation.
AGENT_IMAGE=affido-agent:latest AGENT_SECRETS_DIR= "${COMPOSE[@]}" up -d --build >/dev/null
pass "caddy, oltp and sandbox-manager are up"

echo "== RFC 0003: happy path + parallel responses =="
./e2e-test/run.sh

echo "== RFC 0003: sandbox lifecycle =="
./verify-sandbox.sh

echo
echo "ALL CHECKS PASSED"
