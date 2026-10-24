#!/usr/bin/env bash
# Security containment negatives (RFC 0003 §11, extended): the checks that
# prove a sandbox cannot reach past its subnet, that the manager API refuses
# sandbox peers regardless of the token, and that the control-plane Postgres
# is bound to loopback only. The positive path (edge -> manager -> sandbox)
# is proven by verify-sandbox.sh; this script proves the walls.
#
# Traffic to agent endpoints goes through Caddy only. The direct probes here
# are the point of the check: they must FAIL to reach anything.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "$BASH_SOURCE[0]")" && pwd)"
# shellcheck disable=SC1091
source "${E2E_DIR}/lib.sh"
cd "${ROOT}"

ATK_USER="sec-a-${RUN_ID}"
VIC_USER="sec-b-${RUN_ID}"
ATK_TOKEN="tok-${ATK_USER}"
VIC_TOKEN="tok-${VIC_USER}"

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }

echo "== security: containment negatives =="

echo "== seed attacker and victim tenants =="
seed_session "${ATK_USER}" "${ATK_TOKEN}"
seed_session "${VIC_USER}" "${VIC_TOKEN}"
curl -fsS --max-time 90 -H "Cookie: better-auth.session_token=${ATK_TOKEN}" "${BASE}/u/${ATK_USER}/status" >/dev/null \
	|| fail "attacker sandbox did not provision"
curl -fsS --max-time 90 -H "Cookie: better-auth.session_token=${VIC_TOKEN}" "${BASE}/u/${VIC_USER}/status" >/dev/null \
	|| fail "victim sandbox did not provision"
ATK_C="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${ATK_USER}'")"
VIC_C="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${VIC_USER}'")"
MANAGER_TOKEN="$("${COMPOSE[@]}" exec -T sandbox-manager printenv MANAGER_TOKEN | tr -d '\r')"
[[ -n "${MANAGER_TOKEN}" ]] || fail "MANAGER_TOKEN is empty; the gate needs the real token to prove the guard ignores it"

echo "== control-plane Postgres is loopback-only =="
published="$(docker port oltp)"
[[ "$(printf '%s' "${published}" | grep -cv '127\.0\.0\.1:')" -eq 0 ]] \
	|| fail "oltp publishes on a non-loopback address: ${published}"
LAN_IP="$(hostname -I | awk '{print $1}')"
if timeout 3 bash -c "</dev/tcp/${LAN_IP}/15432" 2>/dev/null; then
	fail "Postgres answered on ${LAN_IP}:15432 (a remote peer with the host IP could reach it)"
fi
pass "oltp binds 127.0.0.1 only; ${LAN_IP}:15432 refuses connections"

echo "== the sandbox cannot reach past its subnet =="
docker cp -q "${E2E_DIR}/security-probe.mjs" "${ATK_C}:/tmp/security-probe.mjs" >/dev/null
probe="$(docker exec "${ATK_C}" node /tmp/security-probe.mjs "${VIC_C}" "${MANAGER_TOKEN}")"
breach="$(printf '%s' "${probe}" | field "d['breach'].strip()")"
[[ -z "${breach}" ]] || fail "containment breach: ${breach} (${probe})"
gateway="$(printf '%s' "${probe}" | field "d['gateway']")"
[[ "${gateway}" != "None" && -n "${gateway}" ]] || fail "probe could not find its gateway: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['managerMetrics']['status']")" == "403" ]] \
	|| fail "manager did not reject the sandbox peer: ${probe}"
pass "no egress (gateway ${gateway}, internet), manager 403, tenant ${VIC_C} unreachable"

echo "== a refused pause left the victim running =="
[[ "$(docker inspect -f '{{.State.Running}}' "${VIC_C}")" == "true" ]] \
	|| fail "victim sandbox stopped despite the guard"
pass "victim sandbox still running"

echo
echo "SECURITY CHECKS PASSED"
