#!/usr/bin/env bash
# E2E suite: happy path + parallel responses, against a running stack.
#
# Prerequisite: docker compose up -d  (plus the affido-agent image, since
# the manager creates agents from it on demand).
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

echo "== compose shape: agents are manager-owned, not declared services =="
services="$("${COMPOSE[@]}" config --services)"
for service in caddy oltp sandbox-manager; do
	grep -qx "${service}" <<<"${services}" || fail "compose is missing ${service}"
done
if grep -q '^agent' <<<"${services}"; then fail "compose still declares agent services"; fi
pass "compose declares only caddy, oltp, sandbox-manager"

docker image inspect affido-agent:latest >/dev/null 2>&1 \
	|| fail "missing affido-agent:latest (docker build -t affido-agent:latest ./agent)"
pass "sandbox manager image affido-agent:latest is available"

./happy-path.sh
./parallel.sh
./citations.sh
./uploads.sh
./skills.sh
./artifacts.sh
./providers.sh

echo
echo "E2E CHECKS PASSED"
