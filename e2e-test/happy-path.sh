#!/usr/bin/env bash
# Happy path: caddy -> sandbox-manager -> caddy -> sandbox agent -> reply.
#
# Agents are not declared in compose, so a successful request proves Caddy got
# the upstream from the manager (X-Sandbox-Endpoint) and dialled it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USER_ID="happy-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

[[ "$(sql -c "SELECT count(*) FROM sandbox_registry WHERE user_id = '${USER_ID}'")" == "0" ]] \
	|| fail "user ${USER_ID} already has a registry row"

echo "== caddy -> manager (cold provision) -> caddy -> agent =="
status_json="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status")" \
	|| fail "GET /u/${USER_ID}/status did not return a sandbox"
CONTAINER="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USER_ID}'")"
[[ -n "${CONTAINER}" ]] || fail "manager did not record a container for ${USER_ID}"
[[ "$(printf '%s' "${status_json}" | field "d['agent']")" == "${CONTAINER}" ]] \
	|| fail "reply came from $(printf '%s' "${status_json}" | field "d['agent']"), expected ${CONTAINER}"
[[ "$(sql -c "SELECT status FROM sandbox_registry WHERE user_id = '${USER_ID}'")" == "running" ]] \
	|| fail "registry status is not running"
[[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" == "true" ]] \
	|| fail "${CONTAINER} is not running"
members="$(docker network inspect "pi-net-${CONTAINER#u}" -f '{{range .Containers}}{{.Name}} {{end}}')"
[[ "${members}" == *"caddy"* && "${members}" == *"sandbox-manager"* ]] \
	|| fail "per-user network lacks caddy/manager: ${members}"
pass "manager provisioned ${CONTAINER}; caddy dialled it and got the agent reply"

echo "== agent replies through the same path (POST /prompt) =="
answer="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"list the files\",\"requestId\":\"happy-${USER_ID}\"}" \
	"${BASE}/u/${USER_ID}/prompt")" || fail "prompt through caddy failed"
[[ "$(printf '%s' "${answer}" | field "d['status']")" == "done" ]] || fail "prompt did not finish: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['answer']")" == *"notes.txt"* ]] \
	|| fail "agent did not read its own workspace: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['conversationId']")" == "1" ]] || fail "unexpected conversation: ${answer}"
pass "agent answered from its workspace (conversation 1)"

echo "== new session: a separate conversation, the old one stays readable (RFC 0008) =="
new_json="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/session/new")" \
	|| fail "POST /session/new failed"
NEW_CONV="$(printf '%s' "${new_json}" | field "d['conversationId']")"
[[ "${NEW_CONV}" =~ ^[0-9]+$ && "${NEW_CONV}" != "1" ]] \
	|| fail "new session returned conversation ${NEW_CONV}, expected one distinct from 1"
answer2="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"list the files again\",\"requestId\":\"happy2-${USER_ID}\"}" \
	"${BASE}/u/${USER_ID}/prompt")" || fail "prompt in the new conversation failed"
[[ "$(printf '%s' "${answer2}" | field "d['conversationId']")" == "${NEW_CONV}" ]] \
	|| fail "the prompt after /session/new did not land in conversation ${NEW_CONV}"
old_trace="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/inspect?conversation=1&limit=500")" \
	|| fail "inspect of conversation 1 after the switch failed"
[[ "$(printf '%s' "${old_trace}" | field "d['conversationId']")" == "1" ]] \
	|| fail "old conversation no longer readable"
OLD_ENTRIES="$(printf '%s' "${old_trace}" | field "d['entries']['returned']")"
[[ "${OLD_ENTRIES}" -ge 1 ]] || fail "conversation 1 lost its entries: ${OLD_ENTRIES}"
status2="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status")"
[[ "$(printf '%s' "${status2}" | field "d['conversationId']")" == "${NEW_CONV}" ]] \
	|| fail "status does not report the active conversation"
pass "new session -> conversation ${NEW_CONV}; conversation 1 kept ${OLD_ENTRIES} entries; status follows the switch"

echo "== switch back: POST /session/switch resumes conversation 1 (RFC 0008) =="
switch_json="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"conversationId":1}' \
	"${BASE}/u/${USER_ID}/session/switch")" || fail "POST /session/switch failed"
[[ "$(printf '%s' "${switch_json}" | field "d['conversationId']")" == "1" ]] \
	|| fail "switch did not report conversation 1: ${switch_json}"
SWITCH_ENTRIES="$(printf '%s' "${switch_json}" | field "d['entries']")"
[[ "${SWITCH_ENTRIES}" -ge 1 ]] || fail "resumed conversation 1 reports ${SWITCH_ENTRIES} entries"
answer3="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"back to the first topic\",\"requestId\":\"happy3-${USER_ID}\"}" \
	"${BASE}/u/${USER_ID}/prompt")" || fail "prompt after the switch failed"
[[ "$(printf '%s' "${answer3}" | field "d['conversationId']")" == "1" ]] \
	|| fail "the prompt after /session/switch did not land in conversation 1"
status3="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status")"
[[ "$(printf '%s' "${status3}" | field "d['conversationId']")" == "1" ]] \
	|| fail "status does not follow the switch back"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"conversationId":999}' \
	"${BASE}/u/${USER_ID}/session/switch")"
[[ "${code}" == "404" ]] || fail "switch to an unknown conversation returned ${code}, expected 404"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"conversationId":"one"}' \
	"${BASE}/u/${USER_ID}/session/switch")"
[[ "${code}" == "400" ]] || fail "switch with a non-integer conversationId returned ${code}, expected 400"
pass "switch resumed conversation 1 (${SWITCH_ENTRIES} entries); prompts land in it; unknown ids are 404"

echo "== identity comes from the session, not the URL =="
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/u/${USER_ID}/status")"
[[ "${code}" == "401" ]] || fail "request without a session returned ${code}, expected 401"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ${COOKIE}" "${BASE}/u/someone-else/status")"
[[ "${code}" == "403" ]] || fail "session/user mismatch returned ${code}, expected 403"
pass "401 without a session, 403 on user mismatch"

echo
echo "HAPPY PATH PASSED"
