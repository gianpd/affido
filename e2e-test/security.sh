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

echo "== the published entry point binds the configured address =="
# Default CADDY_BIND=127.0.0.1: the tenant surface must not answer on the LAN
# unless the operator opted in explicitly (.env mirrors compose interpolation).
CADDY_BIND="$(grep -E '^CADDY_BIND=' "${ROOT}/.env" 2>/dev/null | cut -d= -f2 || true)"
CADDY_BIND="${CADDY_BIND:-127.0.0.1}"
published="$(docker port caddy)"
[[ "$(printf '%s' "${published}" | grep -cv "${CADDY_BIND}:18080")" -eq 0 ]] \
	|| fail "caddy publishes on ${published}, expected ${CADDY_BIND}:18080 only"
pass "caddy publishes on ${CADDY_BIND}:18080 only"

echo "== the sandbox cannot reach past its subnet =="
# Bounded 0.0.0.0-bound host service: the sandbox must not even route to it
# (the gateway IP is the host). Killed right after the probe.
HOST_SVC_PORT=18081
timeout 30 python3 -m http.server --bind 0.0.0.0 "${HOST_SVC_PORT}" >/dev/null 2>&1 &
HOST_SVC_PID=$!
sleep 0.5
curl -fsS --max-time 2 "http://127.0.0.1:${HOST_SVC_PORT}/" >/dev/null \
	|| fail "host probe listener did not start on ${HOST_SVC_PORT} (port busy?)"
docker cp -q "${E2E_DIR}/security-probe.mjs" "${ATK_C}:/tmp/security-probe.mjs" >/dev/null
probe="$(docker exec "${ATK_C}" node /tmp/security-probe.mjs "${VIC_C}" "${MANAGER_TOKEN}" "${HOST_SVC_PORT}")"
kill "${HOST_SVC_PID}" 2>/dev/null || true
breach="$(printf '%s' "${probe}" | field "d['breach'].strip()")"
[[ -z "${breach}" ]] || fail "containment breach: ${breach} (${probe})"
gateway="$(printf '%s' "${probe}" | field "d['gateway']")"
[[ "${gateway}" != "None" && -n "${gateway}" ]] || fail "probe could not find its gateway: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['hostService']")" != "connect:ok" ]] \
	|| fail "sandbox reached a 0.0.0.0-bound host service on the gateway: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['managerMetrics']['status']")" == "403" ]] \
	|| fail "manager did not reject the sandbox peer: ${probe}"
pass "no egress (gateway ${gateway}, internet, host services), manager 403, tenant ${VIC_C} unreachable"

echo "== a refused pause left the victim running =="
[[ "$(docker inspect -f '{{.State.Running}}' "${VIC_C}")" == "true" ]] \
	|| fail "victim sandbox stopped despite the guard"
pass "victim sandbox still running"

echo
echo "SECURITY CHECKS PASSED"
