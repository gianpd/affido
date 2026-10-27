#!/usr/bin/env bash
# RFC 0003 end-to-end check: Caddy forward_auth -> sandbox-manager -> per-user
# sandbox, including the L0 idle pause, the L1 docker stop, and a restart by the
# manager on the next request (same conversation).
#
# The SvelteKit/better-auth Web Client is not part of this repository, so this
# script seeds the better-auth-shaped `"session"` row that the manager reads.
# That is the only stand-in: Caddy, the manager, Postgres and the sandbox are real.
#
# Usage: ./verify-sandbox.sh   (after docker compose up, with STOP_AFTER_S <= 120)
set -euo pipefail

cd "$(dirname "$0")"

HOST_PORT="${HOST_PORT:-18080}"
BASE="http://localhost:${HOST_PORT}"
COMPOSE=(docker compose)
USER_ID="sbx-$(date +%s)-$$"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }
field() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
sql() { "${COMPOSE[@]}" exec -T oltp psql -U pi -d pi -v ON_ERROR_STOP=1 -tA "$@"; }
manager_env() { "${COMPOSE[@]}" exec -T sandbox-manager printenv "$1" | tr -d '\r'; }

echo "== RFC 0003: edge -> manager -> sandbox =="
for _ in $(seq 1 30); do
	if "${COMPOSE[@]}" exec -T caddy wget -qO- http://sandbox-manager:8090/healthz >/dev/null 2>&1; then break; fi
	sleep 1
done
"${COMPOSE[@]}" exec -T caddy wget -qO- http://sandbox-manager:8090/healthz >/dev/null 2>&1 \
	|| fail "caddy cannot reach sandbox-manager:8090/healthz"
pass "caddy reaches sandbox-manager:8090 (control plane)"

MANAGER_TOKEN="$(manager_env MANAGER_TOKEN || true)"
STOP_AFTER_S="$(manager_env STOP_AFTER_S || true)"
EVICT_TICK_S="$(manager_env EVICT_TICK_S || true)"
AGENT_IDLE_MS="$(manager_env AGENT_IDLE_MS || true)"
STOP_AFTER_S="${STOP_AFTER_S:-600}"
EVICT_TICK_S="${EVICT_TICK_S:-15}"
AGENT_IDLE_MS="${AGENT_IDLE_MS:-5000}"
[[ "${STOP_AFTER_S}" -le 120 ]] || fail "STOP_AFTER_S=${STOP_AFTER_S}s is too slow for this check; export STOP_AFTER_S=25 and recreate sandbox-manager"

if [[ -n "${MANAGER_TOKEN}" ]]; then
	metrics="$("${COMPOSE[@]}" exec -T caddy wget -qO- --header="X-Manager-Token: ${MANAGER_TOKEN}" http://sandbox-manager:8090/metrics)"
	[[ "${metrics}" == *'"by_status"'* ]] || fail "manager /metrics: ${metrics}"
	"${COMPOSE[@]}" exec -T caddy wget -S -O /dev/null --header='X-Manager-Token: wrong' \
		http://sandbox-manager:8090/metrics >/tmp/sbx-wrong-token 2>&1 || true
	grep -q '401 Unauthorized' /tmp/sbx-wrong-token || fail "manager accepted a wrong X-Manager-Token"
	rm -f /tmp/sbx-wrong-token
	pass "manager API is reachable from caddy and rejects a wrong token"
fi

echo "== signup stand-in: better-auth-shaped session row =="
sql >/dev/null <<SQL
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "userId" text NOT NULL,
  "token" text NOT NULL UNIQUE,
  "expiresAt" timestamptz NOT NULL
);
INSERT INTO "session" ("id", "userId", "token", "expiresAt")
VALUES ('sess-${USER_ID}', '${USER_ID}', '${TOKEN}', now() + interval '1 hour')
ON CONFLICT ("id") DO UPDATE SET "token" = EXCLUDED."token", "expiresAt" = EXCLUDED."expiresAt";
SQL
[[ "$(sql -c "SELECT count(*) FROM sandbox_registry WHERE user_id = '${USER_ID}'")" == "0" ]] \
	|| fail "user ${USER_ID} already has a sandbox row"
pass "fresh user ${USER_ID} with a session cookie"

echo "== caddy asks the manager for a sandbox (cold provision) =="
status_json="$(curl -fsS --max-time 90 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status")" \
	|| fail "first request through caddy did not return a sandbox"
row="$(sql -c "SELECT container_name || '|' || status FROM sandbox_registry WHERE user_id = '${USER_ID}'")"
CONTAINER="${row%%|*}"
[[ "${row##*|}" == "running" ]] || fail "registry after first request: ${row}"
[[ "$(printf '%s' "${status_json}" | field "d['agent']")" == "${CONTAINER}" ]] \
	|| fail "reply came from $(printf '%s' "${status_json}" | field "d['agent']"), expected ${CONTAINER}"
[[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" == "true" ]] || fail "${CONTAINER} is not running"
members="$(docker network inspect "pi-net-${CONTAINER#u}" -f '{{range .Containers}}{{.Name}} {{end}}')"
[[ "${members}" == *"caddy"* && "${members}" == *"sandbox-manager"* ]] \
	|| fail "per-user network does not attach caddy and manager: ${members}"
pass "caddy provisioned and proxied to ${CONTAINER} (data plane)"

want_runtime="$(manager_env AGENT_RUNTIME || true)"
want_runtime="${want_runtime:-runsc}"
runtime="$(docker inspect -f '{{.HostConfig.Runtime}}' "${CONTAINER}")"
[[ "${runtime}" == "${want_runtime}" ]] \
	|| fail "${CONTAINER} runs on runtime '${runtime}', expected '${want_runtime}'"
pass "sandbox runs under the configured runtime (${runtime})"

net="pi-net-${CONTAINER#u}"
want_ip="$(docker inspect -f "{{range \$k,\$v := .NetworkSettings.Networks}}{{if eq \$k \"${net}\"}}{{\$v.IPAddress}}{{end}}{{end}}" sandbox-manager)"
resolved="$(docker exec "${CONTAINER}" node -e "require('dns').lookup('sandbox-manager',(e,a)=>console.log(e?'ERR '+e.code:a))" 2>/dev/null || true)"
[[ "${resolved}" == "${want_ip}" ]] \
	|| fail "sandbox resolves 'sandbox-manager' as '${resolved}', expected ${want_ip}"
pass "sandbox resolves the control plane by name (/etc/hosts: gVisor has no embedded DNS)"

want_dns="$(manager_env AGENT_DNS || true)"
want_dns="${want_dns:-1.1.1.1}"
first_ns="$(docker exec "${CONTAINER}" head -1 /etc/resolv.conf | awk '{print $2}')"
[[ "${first_ns}" == "${want_dns}" ]] \
	|| fail "first nameserver is '${first_ns}', expected ${want_dns}: without the rewrite a runsc sandbox cannot resolve internet names (real providers)"
pass "resolver rewritten to ${first_ns} (Docker's --dns never reaches resolv.conf on user-defined networks)"

echo "== agent state before sleeping =="
answer="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" -H 'content-type: application/json' \
	-d "{\"prompt\":\"list the files\",\"requestId\":\"verify-${USER_ID}\"}" "${BASE}/u/${USER_ID}/prompt")" \
	|| fail "prompt through caddy failed"
[[ "$(printf '%s' "${answer}" | field "d['status']")" == "done" ]] || fail "prompt did not finish: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['answer']")" == *"notes.txt"* ]] || fail "agent did not read the workspace: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['conversationId']")" == "1" ]] || fail "unexpected conversation: ${answer}"
entries="$(printf '%s' "${answer}" | field "d['entries']")"
pass "sandbox answered from its workspace (conversation 1, entries=${entries})"

echo "== the trace is readable through /inspect =="
trace_json="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/inspect?limit=10")" \
	|| fail "inspect through caddy failed"
[[ "$(printf '%s' "${trace_json}" | field "d['conversationId']")" == "1" ]] || fail "trace reports another conversation: ${trace_json}"
[[ "$(printf '%s' "${trace_json}" | field "len(d['entries']['items'])")" -ge 5 ]] || fail "trace has no entries: ${trace_json}"
[[ "$(printf '%s' "${trace_json}" | field "d['entries']['items'][0]['kind']")" == "pi.assistant" ]] || fail "newest trace entry is not the answer: ${trace_json}"
[[ "$(printf '%s' "${trace_json}" | field "len(d['tasks'])+len(d['submissions'])")" == "0" ]] || fail "trace left live work behind: ${trace_json}"
pass "trace reports entries, no live work, and usage"

echo "== one entry is readable through /entry, tool output included =="
tool_entry="$(printf '%s' "${trace_json}" | field "next((item['id'] for item in d['entries']['items'] if item['kind'] == 'pi.tool-result'), None)")"
[[ "${tool_entry}" != "None" ]] || fail "the trace has no tool result entry: ${trace_json}"
entry_json="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/entry?id=${tool_entry}")" \
	|| fail "entry through caddy failed"
[[ "$(printf '%s' "${entry_json}" | field "d['id']")" == "${tool_entry}" ]] || fail "entry reports another id: ${entry_json}"
[[ "$(printf '%s' "${entry_json}" | field "d['messages'][0]['role']")" == "toolResult" ]] || fail "entry carries no tool result: ${entry_json}"
[[ "$(printf '%s' "${entry_json}" | field "d['messages'][0]['content'][0]['text']")" == *"notes.txt"* ]] \
	|| fail "tool output is not the text the model saw: ${entry_json}"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/entry?id=999999")"
[[ "${code}" == "404" ]] || fail "unknown entry id returned ${code}, expected 404"
pass "entry ${tool_entry} carries the tool output verbatim, unknown ids answer 404"

echo "== operation: the sandbox goes to sleep =="
sleep $(( AGENT_IDLE_MS / 1000 + 2 ))
status_json="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status")" \
	|| fail "status after idle failed"
[[ "$(printf '%s' "${status_json}" | field "d['paused']")" == "True" ]] || fail "agent did not pause: ${status_json}"
pass "agent paused in-process (L0) after ${AGENT_IDLE_MS}ms idle"

deadline=$(( $(date +%s) + STOP_AFTER_S + 3 * EVICT_TICK_S + 30 ))
while :; do
	state="$(sql -c "SELECT status FROM sandbox_registry WHERE user_id = '${USER_ID}'")"
	[[ "${state}" == "stopped" ]] && break
	[[ "$(date +%s)" -lt "${deadline}" ]] || fail "sandbox stayed ${state} past the eviction deadline"
	sleep 2
done
[[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" == "false" ]] \
	|| fail "${CONTAINER} is still running while the registry says stopped"
pass "manager stopped the idle sandbox (L1) and recorded 'stopped'"

echo "== operation: a new call restarts it via the manager =="
restart_json="$(curl -fsS --max-time 90 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/session")" \
	|| fail "call after eviction did not restart the sandbox"
[[ "$(printf '%s' "${restart_json}" | field "d['conversationId']")" == "1" ]] || fail "conversation changed: ${restart_json}"
[[ "$(printf '%s' "${restart_json}" | field "d['entries']")" == "${entries}" ]] || fail "entries changed across the stop: ${restart_json}"
[[ "$(printf '%s' "${restart_json}" | field "d['paused']")" == "False" ]] || fail "sandbox did not activate: ${restart_json}"
[[ "$(sql -c "SELECT status FROM sandbox_registry WHERE user_id = '${USER_ID}'")" == "running" ]] \
	|| fail "registry did not return to running"
[[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" == "true" ]] || fail "${CONTAINER} was not restarted"
# RFC 0013: the daemon regenerates /etc/resolv.conf at every container start,
# so the manager's rewrite must be re-applied on the restart path too — under
# runsc the regenerated 127.0.0.11 is a dead resolver, and the sidecar (which
# dials real provider upstreams) would be first to notice.
first_ns_restart="$(docker exec "${CONTAINER}" head -1 /etc/resolv.conf | awk '{print $2}')"
[[ "${first_ns_restart}" == "${want_dns}" ]] \
	|| fail "after L1 restart the first nameserver is '${first_ns_restart}', expected ${want_dns}: a restarted pair must get the rewrite again"
sidecar_c="${CONTAINER}-sidecar"
sidecar_ns="$(docker exec "${sidecar_c}" head -1 /etc/resolv.conf | awk '{print $2}')"
[[ "${sidecar_ns}" == "${want_dns}" ]] \
	|| fail "sidecar resolv.conf first nameserver is '${sidecar_ns}', expected ${want_dns}"
[[ "$(sql -c "SELECT count(*) FROM sandbox_registry WHERE user_id = '${USER_ID}'")" == "1" ]] \
	|| fail "more than one sandbox row for ${USER_ID}"
pass "manager restarted ${CONTAINER}; conversation 1 kept ${entries} entries; resolver rewritten on both halves"

echo "== negative: identity comes from the session, not the path =="
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/u/${USER_ID}/status")"
[[ "${code}" == "401" ]] || fail "request without a session returned ${code}, expected 401"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ${COOKIE}" "${BASE}/u/someone-else/status")"
[[ "${code}" == "403" ]] || fail "session user mismatch returned ${code}, expected 403"
spoofed="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" -H 'X-Sandbox-Endpoint: agent-a:8080' "${BASE}/u/${USER_ID}/status")" \
	|| fail "spoofed-upstream request failed"
[[ "$(printf '%s' "${spoofed}" | field "d['agent']")" == "${CONTAINER}" ]] \
	|| fail "client-supplied X-Sandbox-Endpoint reached the dial: ${spoofed}"
pass "401 without a session, 403 on user mismatch, spoofed upstream stripped"

echo
echo "SANDBOX CHECKS PASSED"
