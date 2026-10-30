#!/usr/bin/env bash
# RFC 0016 e2e: the web-search node is provisioned with the sandbox, its tool
# contract holds through the manager (opaque ids, no URL argument, per-run
# budgets), and the taint gate blocks ingest/upload/skill installation for the
# conversation that read the web.
#
# Prerequisites: a running stack, affido-agent:latest, an internal websearch-in
# network, and the e2e fake search stack (see verify.sh). The node is never
# exposed through Caddy, so its contract is probed from the manager container,
# the other peer on the per-user network — the same route the agent takes.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USER_ID="web-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

echo "== provision the sandbox; the web-search node comes with it =="
curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status" >/dev/null \
	|| fail "first request did not provision the sandbox"
CONTAINER="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USER_ID}'")"
[[ -n "${CONTAINER}" ]] || fail "no sandbox registered for ${USER_ID}"
NODE="${CONTAINER}-websearch"
NET="pi-net-${CONTAINER#u}"
[[ "$(docker inspect -f '{{.State.Running}}' "${NODE}" 2>/dev/null || true)" == "true" ]] \
	|| fail "the web-search node ${NODE} is not running"
for c in "${CONTAINER}" "${CONTAINER}-sidecar" "${NODE}"; do
	[[ "$(docker inspect -f '{{.HostConfig.Runtime}}' "${c}")" == "runsc" ]] \
		|| fail "${c} does not run on runsc"
	[[ "$(docker inspect -f '{{.HostConfig.CapDrop}}' "${c}" | tr '[:upper:]' '[:lower:]')" == "[all]" ]] \
		|| fail "${c} is not --cap-drop ALL"
done
# No writable volume and no published port: a fetched page has nowhere to go.
[[ "$(docker inspect -f '{{len .Mounts}}' "${NODE}")" == "0" ]] \
	|| fail "the web-search node has a mount: $(docker inspect -f '{{json .Mounts}}' "${NODE}")"
[[ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "${NODE}")" == "0" ]] \
	|| fail "the web-search node publishes a port"
# Dual-homed: the sandbox talks to it on its own network; the search services
# live on the shared internal one, which is the only other attachment.
attached="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${NODE}")"
[[ " ${attached} " == *" ${NET} "* ]] || fail "the node is not on ${NET}: ${attached}"
[[ " ${attached} " == *" $(manager_env WEBSEARCH_IN) "* ]] \
	|| fail "the node is not on the shared search network: ${attached}"
[[ " ${attached} " != *" $(manager_env WEBSEARCH_OUT) "* ]] \
	|| fail "the node must never be attached to the egress network: ${attached}"
# The manager delivers the node's control token to the agent on every resolve.
sandbox_status="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status")"
[[ "$(printf '%s' "${sandbox_status}" | field "d['webControl']")" == "True" ]] \
	|| fail "the agent did not receive the web control token: ${sandbox_status}"
pass "agent, sidecar and ${NODE}: runsc, no capabilities, no volumes, dual-homed; control token delivered"

echo "== the node's tool contract, over the same edge the agent uses =="
probe="$(docker compose exec -T sandbox-manager python3 - \
	"http://${NODE}:8082" "${USER_ID}" "run-${USER_ID}" < "${E2E_DIR}/websearch-probe.py")"
# RFC 0016 §7: the manager's control token is idempotent; a different one is
# refused, and an unregistered or unauthorised run cannot search at all.
[[ "$(printf '%s' "${probe}" | field "d['control']['status']")" == "200" ]] \
	|| fail "control delivery failed: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['control_mismatch']['status']")" == "403" ]] \
	|| fail "a different control token was accepted: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['control_mismatch']['error']")" == "control_token_mismatch" ]] \
	|| fail "the control refusal is not named: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['unregistered']['status']")" == "403" ]] \
	|| fail "an unregistered run could search: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['unregistered']['error']")" == "web_not_authorized" ]] \
	|| fail "the unregistered refusal is not named: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['web_off']['status']")" == "403" ]] \
	|| fail "a run registered with web=false could search: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['web_off']['error']")" == "web_not_authorized" ]] \
	|| fail "the web=false refusal is not named: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['search']['status']")" == "200" ]] \
	|| fail "search failed: ${probe}"
# Two fetchable results; the fake stack's file:/// entry is dropped.
[[ "$(printf '%s' "${probe}" | field "d['search']['results']")" == "2" ]] \
	|| fail "the node returned the wrong result count: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['search']['domain']")" == "example.com" ]] \
	|| fail "the first result has no domain: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['search']['leaksUrl']")" == "False" ]] \
	|| fail "a sourceId carries the URL: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['read']['status']")" == "200" ]] \
	|| fail "read failed: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['read']['untrusted']")" == "True" ]] \
	|| fail "read text is not marked untrusted: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['read']['chars']")" -le 6000 ]] \
	|| fail "read text exceeds the 6000-char cap: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['read']['hasText']")" == "True" ]] \
	|| fail "the fetched page text did not arrive: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['already_read']['status']")" == "429" ]] \
	|| fail "a second read of one result was allowed: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['already_read']['error']")" == "already_read" ]] \
	|| fail "the duplicate read has no named error: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['url_argument']['status']")" == "400" ]] \
	|| fail "a URL argument was accepted: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['url_argument']['error']")" == "no_url_in_arguments" ]] \
	|| fail "the URL refusal is not named: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['unknown_source']['status']")" == "404" ]] \
	|| fail "a foreign sourceId was accepted: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['unknown_source']['error']")" == "unknown_source" ]] \
	|| fail "the unknown-source refusal is not named: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['query_too_long']['status']")" == "413" ]] \
	|| fail "an over-long query was accepted: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['query_too_long']['error']")" == "query_too_long" ]] \
	|| fail "the query bound is not named: ${probe}"
for index in 0 1 2 3; do
	[[ "$(printf '%s' "${probe}" | field "d['searches'][${index}]['status']")" == "200" ]] \
		|| fail "search $((index + 1)) was refused: ${probe}"
done
[[ "$(printf '%s' "${probe}" | field "d['searches'][4]['status']")" == "429" ]] \
	|| fail "the fifth search was allowed: ${probe}"
[[ "$(printf '%s' "${probe}" | field "d['searches'][4]['error']")" == "budget_exhausted" ]] \
	|| fail "the search budget is not named: ${probe}"
pass "opaque ids, no URL argument, one read per result, four searches per run"

echo "== web is off unless the user enables it for the message (RFC 0016 §7) =="
off_reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"search the web for the renewal date","requestId":"web-off-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "web-off prompt failed"
[[ "$(printf '%s' "${off_reply}" | field "d['status']")" == "done" ]] \
	|| fail "web-off prompt not done: ${off_reply}"
[[ "$(printf '%s' "${off_reply}" | field "d['webMode']")" == "off" ]] \
	|| fail "webMode is not off: ${off_reply}"
OFF_ANSWER="$(printf '%s' "${off_reply}" | field "d['answer']")"
[[ "${OFF_ANSWER}" == *"web_not_authorized"* ]] \
	|| fail "a run without web authorisation still searched: ${OFF_ANSWER}"
pass "without web the model gets web_not_authorized, not a search"

echo "== the agent reads the web through the node, then the taint gate closes persistence =="
reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"search the web for the renewal date","requestId":"web-'${RUN_ID}'","web":"allowed"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "web prompt failed"
[[ "$(printf '%s' "${reply}" | field "d['status']")" == "done" ]] || fail "web prompt not done: ${reply}"
[[ "$(printf '%s' "${reply}" | field "d['webMode']")" == "allowed" ]] \
	|| fail "webMode is not allowed: ${reply}"
ANSWER="$(printf '%s' "${reply}" | field "d['answer']")"
[[ "${ANSWER}" == *"renews"* ]] \
	|| fail "the model did not see the node's read result: ${ANSWER}"
pass "with web allowed, web_search -> web_read ran through the node"

FIXTURE="$(mktemp /tmp/web-taint-XXXX.md)"
printf '# rinnovo\nIl contratto si rinnova il 1 marzo 2027.\n' >"${FIXTURE}"
upload_status="$(curl -sS -o /tmp/web-taint-reply.$$ -w '%{http_code}' --max-time 60 -X POST \
	-H "Cookie: ${COOKIE}" -H 'content-type: text/markdown' --data-binary @"${FIXTURE}" \
	"${BASE}/u/${USER_ID}/ingest?docId=doc_taint_${RUN_ID}&filename=contratto.md&title=Rinnovo")"
[[ "${upload_status}" == "409" ]] \
	|| fail "ingest after web content answered ${upload_status}: $(cat /tmp/web-taint-reply.$$)"
[[ "$(field "d['error']" < /tmp/web-taint-reply.$$)" == "web_tainted" ]] \
	|| fail "the taint refusal is not named: $(cat /tmp/web-taint-reply.$$)"

skill_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -X POST \
	-H "Cookie: ${COOKIE}" -H 'content-type: text/markdown' --data-binary 'x' \
	"${BASE}/u/${USER_ID}/skills/file?skill=web-taint&path=SKILL.md")"
[[ "${skill_status}" == "409" ]] || fail "skill installation after web content answered ${skill_status}"
pass "ingest and skill installation are refused with web_tainted"

echo "== the taint is durable across a restart and clears only with a new conversation =="
docker restart "${CONTAINER}" >/dev/null
sleep 1
retry_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 120 -X POST \
	-H "Cookie: ${COOKIE}" -H 'content-type: text/markdown' --data-binary @"${FIXTURE}" \
	"${BASE}/u/${USER_ID}/ingest?docId=doc_taint_restart&filename=contratto.md&title=Rinnovo")"
[[ "${retry_status}" == "409" ]] \
	|| fail "the taint did not survive a restart: ingest answered ${retry_status}"
curl -fsS --max-time 60 -X POST -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/session/new" >/dev/null \
	|| fail "session/new failed"
fresh_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -X POST \
	-H "Cookie: ${COOKIE}" -H 'content-type: text/markdown' --data-binary @"${FIXTURE}" \
	"${BASE}/u/${USER_ID}/ingest?docId=doc_fresh&filename=contratto.md&title=Rinnovo")"
[[ "${fresh_status}" == "200" ]] \
	|| fail "a new conversation still refuses ingest: ${fresh_status}"
rm -f "${FIXTURE}" /tmp/web-taint-reply.$$
pass "taint survives a restart; a new conversation starts clean"

echo
echo "WEB SEARCH CHECKS PASSED"
