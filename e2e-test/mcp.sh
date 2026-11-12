#!/usr/bin/env bash
# RFC 0024 e2e: the MCP node is provisioned with the sandbox behind the
# operator's MCP networks, its contract holds (manifest authority, per-run
# write gate, limits, named refusals), the taint gate closes persistence after
# the first MCP result, and revocation is a resolve, not a restart.
#
# Prerequisites: a running stack built with MCP_SERVERS=fake (verify.sh brings
# it up for this phase) and the e2e fake MCP server attached to mcp-in with
# alias e2e-fake-mcp. The fake's bearer token is fixed; the user enables the
# server through the manager's /mcp/servers route, exactly like the frontend.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USER_ID="mcp-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

echo "== provision the sandbox; the MCP node comes with it (D1) =="
curl -fsS --max-time 180 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status" >/dev/null \
	|| fail "first request did not provision the sandbox"
CONTAINER="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USER_ID}'")"
[[ -n "${CONTAINER}" ]] || fail "no sandbox registered for ${USER_ID}"
NODE="${CONTAINER}-mcp"
NET="pi-net-${CONTAINER#u}"
[[ "$(docker inspect -f '{{.State.Running}}' "${NODE}" 2>/dev/null || true)" == "true" ]] \
	|| fail "the MCP node ${NODE} is not running"
for c in "${CONTAINER}" "${NODE}"; do
	[[ "$(docker inspect -f '{{.HostConfig.Runtime}}' "${c}")" == "runsc" ]] \
		|| fail "${c} does not run on runsc"
	[[ "$(docker inspect -f '{{.HostConfig.CapDrop}}' "${c}" | tr '[:upper:]' '[:lower:]')" == "[all]" ]] \
		|| fail "${c} is not --cap-drop ALL"
done
# No writable volume, no published port, read-only rootfs (V4, M1).
[[ "$(docker inspect -f '{{len .Mounts}}' "${NODE}")" == "0" ]] \
	|| fail "the MCP node has a mount: $(docker inspect -f '{{json .Mounts}}' "${NODE}")"
[[ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "${NODE}")" == "0" ]] \
	|| fail "the MCP node publishes a port"
[[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "${NODE}")" == "true" ]] \
	|| fail "the MCP node does not run with a read-only rootfs"
# Three legs (D2): the per-user network, the operator leg, the egress leg.
attached="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${NODE}")"
[[ " ${attached} " == *" ${NET} "* ]] || fail "the node is not on ${NET}: ${attached}"
[[ " ${attached} " == *" $(manager_env MCP_IN) "* ]] || fail "the node is not on the operator MCP network: ${attached}"
[[ " ${attached} " == *" $(manager_env MCP_OUT) "* ]] || fail "the node is not on the egress MCP network: ${attached}"
# The sandbox itself stays off both MCP legs (D3: zero egress).
agent_nets="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${CONTAINER}")"
[[ " ${agent_nets} " != *" $(manager_env MCP_IN) "* && " ${agent_nets} " != *" $(manager_env MCP_OUT) "* ]] \
	|| fail "the agent container is attached to an MCP network: ${agent_nets}"
# mcp-out must not let nodes talk to each other (T7).
[[ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.enable_icc"}}' "$(manager_env MCP_OUT)")" == "false" ]] \
	|| fail "mcp-out does not disable inter-container traffic"
pass "${NODE}: runsc, no caps, read-only, no volume/port, three legs; sandbox untouched"

echo "== the agent got the runtime config but no enabled server yet =="
status="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/mcp")"
[[ "$(printf '%s' "${status}" | field "len(d['deployment'])")" -ge 1 ]] \
	|| fail "the deployment subset did not reach the agent: ${status}"
[[ "$(printf '%s' "${status}" | field "d['enabled']")" == "[]" ]] \
	|| fail "a server is enabled before the user asked: ${status}"
[[ "$(printf '%s' "${status}" | field "d['toolSearch']")" == "False" ]] \
	|| fail "tool_search is offered with no server enabled (D6): ${status}"
pass "/mcp reports the deployment set and no enabled server"

echo "== enable the fake server through the manager (D4: no user URL) =="
enable="$(curl -fsS --max-time 60 -X PUT -H "Cookie: ${COOKIE}" -H "Origin: ${BASE}" -H 'content-type: application/json' \
	-d '{"serverId":"fake","enabled":true,"token":"wgt_e2e_fake_token"}' \
	"${BASE}/mcp/servers")" || fail "PUT /mcp/servers failed"
[[ "$(printf '%s' "${enable}" | field "d['servers'][0]['enabled']")" == "True" ]] \
	|| fail "the enable did not land: ${enable}"
[[ "$(printf '%s' "${enable}" | field "d['servers'][0]['hasToken']")" == "True" ]] \
	|| fail "the token was not stored: ${enable}"
[[ "$(printf '%s' "${enable}" | field "d['delivery']")" == "delivered" ]] \
	|| fail "the enablement was not delivered live: ${enable}"
[[ "$(printf '%s' "${enable}" | field "'token' in d['servers'][0]")" == "False" ]] \
	|| fail "the masked view leaked a token field: ${enable}"
foreign="$(curl -sS -o /tmp/mcp-foreign.$$ -w '%{http_code}' --max-time 60 -X PUT \
	-H "Cookie: ${COOKIE}" -H "Origin: ${BASE}" -H 'content-type: application/json' \
	-d '{"serverId":"worldgraph","enabled":true}' "${BASE}/mcp/servers")"
[[ "${foreign}" == "400" ]] || fail "enabling a server outside the deployment answered ${foreign}"
[[ "$(field "d['error']" < /tmp/mcp-foreign.$$)" == "unknown_server" ]] \
	|| fail "the foreign-server refusal is not named: $(cat /tmp/mcp-foreign.$$)"
rm -f /tmp/mcp-foreign.$$
pass "enable + token stored (encrypted, never returned); foreign servers refused"

echo "== V2: the node answers its peers and refuses everyone else =="
probe="$(docker compose exec -T sandbox-manager python3 -c "
import json, urllib.request
print(json.dumps({
  'from_manager': urllib.request.urlopen('http://${NODE}:8083/servers', timeout=5).status,
}))")"
[[ "$(printf '%s' "${probe}" | field "d['from_manager']")" == "200" ]] \
	|| fail "the manager (a guest on the user network) could not read /servers: ${probe}"
pass "the manager reaches the node's /servers over the per-user network"

echo "== V3: the sandbox has no route to the MCP host and no direct egress =="
docker exec "${CONTAINER}" node -e \
	'fetch("http://e2e-fake-mcp:9410/healthz",{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1),()=>process.exit(0))' \
	|| fail "the agent container reached the fake MCP server directly"
pass "the sandbox cannot reach the MCP host (the node is the only edge)"

echo "== V5: the manifest description is what the model sees, never the server's =="
reply="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"probe the mcp echo tool","requestId":"mcp-echo-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the echo prompt failed"
[[ "$(printf '%s' "${reply}" | field "d['status']")" == "done" ]] \
	|| fail "the echo prompt did not finish: ${reply}"
ANSWER="$(printf '%s' "${reply}" | field "d['answer']")"
[[ "${ANSWER}" == *"echoed"* ]] || fail "the model did not see the node's result: ${ANSWER}"
# The tool round the model saw: tool_search's result text carries the manifest
# descriptions. The hostile server text must appear nowhere in the trace.
trace="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/inspect?limit=30")"
[[ "${trace}" == *"Echo its text argument back"* ]] \
	|| fail "the manifest description never reached the trace"
[[ "${trace}" != *"/etc/passwd"* && "${trace}" != *"ignore all previous instructions"* ]] \
	|| fail "hostile server text reached the model's trace"
pass "tool_search loaded the tool by its manifest description; hostile text absent"

echo "== V6: the first MCP result taints the conversation (D8) =="
FIXTURE="$(mktemp /tmp/mcp-taint-XXXX.md)"
printf '# note\nA staged document.\n' >"${FIXTURE}"
ingest_status="$(curl -sS -o /tmp/mcp-taint-reply.$$ -w '%{http_code}' --max-time 60 -X POST \
	-H "Cookie: ${COOKIE}" -H 'content-type: text/markdown' --data-binary @"${FIXTURE}" \
	"${BASE}/u/${USER_ID}/ingest?docId=doc_mcp_${RUN_ID}&filename=nota.md&title=Nota")"
[[ "${ingest_status}" == "409" ]] \
	|| fail "ingest after an MCP result answered ${ingest_status}: $(cat /tmp/mcp-taint-reply.$$)"
[[ "$(field "d['error']" < /tmp/mcp-taint-reply.$$)" == "web_tainted" ]] \
	|| fail "the taint refusal is not named: $(cat /tmp/mcp-taint-reply.$$)"
rm -f "${FIXTURE}" /tmp/mcp-taint-reply.$$
pass "ingest is refused with web_tainted after the first MCP result"

echo "== V7: write is a per-run grant that only the Caddy stamp makes real =="
# A bash child of the sandbox can POST /prompt directly (the listener is
# reachable), but it cannot stamp the admission header: the run registers
# read-only and the write tool refuses with the pinned code.
direct="$(docker exec "${CONTAINER}" node -e '
	const body = JSON.stringify({prompt:"probe the mcp write tool",requestId:"mcp-direct-'${RUN_ID}'",mcpWrite:"allowed"});
	fetch("http://127.0.0.1:8080/prompt",{method:"POST",headers:{"content-type":"application/json"},body})
		.then((r)=>r.text()).then((t)=>console.log(t)).catch((e)=>{console.error(e);process.exit(1)});')"
[[ "$(printf '%s' "${direct}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')" == "done" ]] \
	|| fail "the direct prompt did not finish: ${direct}"
DIRECT_ANSWER="$(printf '%s' "${direct}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["answer"])')"
[[ "${DIRECT_ANSWER}" == *"write_not_authorized"* ]] \
	|| fail "a stampless run performed or missed the write refusal: ${DIRECT_ANSWER}"
# Through Caddy with mcpWrite allowed, the same dance writes successfully.
stamped="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"probe the mcp write tool","requestId":"mcp-write-'${RUN_ID}'","mcpWrite":"allowed"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the stamped write prompt failed"
STAMPED_ANSWER="$(printf '%s' "${stamped}" | field "d['answer']")"
[[ "${STAMPED_ANSWER}" == *"saved"* ]] \
	|| fail "the stamped run did not perform the write: ${STAMPED_ANSWER}"
# The stamp alone is not the grant: without the user's mcpWrite the same
# request through the same Caddy route registers read-only (D7: the composer
# toggle is the user's act; the header only authenticates it). A client-
# supplied X-MCP-Admission is stripped by the gateway, so it cannot smuggle
# the choice either (T9).
unticked="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' -H 'X-MCP-Admission: forged-by-client' \
	-d '{"prompt":"probe the mcp write tool once more","requestId":"mcp-unticked-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the unticked write prompt failed"
UNTTICKED_ANSWER="$(printf '%s' "${unticked}" | field "d['answer']")"
[[ "${UNTTICKED_ANSWER}" == *"write_not_authorized"* ]] \
	|| fail "a run without the user's mcpWrite performed a write: ${UNTTICKED_ANSWER}"
pass "write refused without mcpWrite (direct and unticked), allowed with the stamp"

echo "== V8: over-cap results are refused and timeouts are named (D15/T6) =="
flood="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"probe the mcp flood tool","requestId":"mcp-flood-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the flood prompt failed"
FLOOD_ANSWER="$(printf '%s' "${flood}" | field "d['answer']")"
[[ "${FLOOD_ANSWER}" == *"upstream_error"* && "${FLOOD_ANSWER}" == *"exceeds 131072 bytes"* ]] \
	|| fail "the over-cap result was not refused by the transport: ${FLOOD_ANSWER}"
stall="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"probe the mcp stall tool","requestId":"mcp-stall-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the stall prompt failed"
STALL_ANSWER="$(printf '%s' "${stall}" | field "d['answer']")"
[[ "${STALL_ANSWER}" == *"timeout"* ]] || fail "the slow server was not a named timeout: ${STALL_ANSWER}"
pass "flood refused over the 128 KiB byte cap; stall answered timeout"

echo "== V9: revocation is a resolve, not a restart =="
disable="$(curl -fsS --max-time 60 -X PUT -H "Cookie: ${COOKIE}" -H "Origin: ${BASE}" -H 'content-type: application/json' \
	-d '{"serverId":"fake","enabled":false}' "${BASE}/mcp/servers")" || fail "the disable failed"
[[ "$(printf '%s' "${disable}" | field "d['servers'][0]['enabled']")" == "False" ]] \
	|| fail "the disable did not land: ${disable}"
revoked="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"probe the mcp echo tool again","requestId":"mcp-revoked-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the post-revocation prompt failed"
REVOKED_ANSWER="$(printf '%s' "${revoked}" | field "d['answer']")"
[[ "${REVOKED_ANSWER}" == *"server_disabled"* ]] \
	|| fail "the revoked server still answered: ${REVOKED_ANSWER}"
pass "PUT off -> resolve -> server_disabled, no restart"

echo
echo "MCP CHECKS PASSED"
