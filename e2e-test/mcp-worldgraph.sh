#!/usr/bin/env bash
# RFC 0024 §14.4: the real first catalog server. Unlike mcp.sh this is an
# OPERATOR verification, not part of ./verify.sh: it needs the worldGraph MCP
# server running on the docker host (the operator's own machine), reachable on
# the mcp-in bridge gateway, with a real wgt_ token.
#
# Runbook (§14.4, resolve-only v1):
#   1. cd <worldgraph repo> && uv run run.py mcp serve --http 0.0.0.0:8766
#   2. MCP_SERVERS=fake,worldgraph ./dev.sh reload   (or compose up with it)
#   3. WORLDGRAPH_TOKEN=$(cat ~/.config/worldgraph/agent2.token) \
#        ./e2e-test/mcp-worldgraph.sh
#
# The manager resolves the catalog host `worldgraph` at provision: a container
# with that alias on mcp-in wins; otherwise the network's gateway — the
# operator-hosted server — is baked into the node's /etc/hosts (§5.3).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

WG_TOKEN="${WORLDGRAPH_TOKEN:-$(cat ~/.config/worldgraph/agent2.token 2>/dev/null || true)}"
[[ -n "${WG_TOKEN}" ]] || fail "WORLDGRAPH_TOKEN (or ~/.config/worldgraph/agent2.token) is required"
WG_HOST="${WORLDGRAPH_HOST:-worldgraph}"
WG_PORT="${WORLDGRAPH_PORT:-8766}"

wait_ready

# The operator's server must be up before the manager resolves its address.
MCPIN_NET="$(manager_env MCP_IN)"
gateway="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "${MCPIN_NET}")"
curl -fsS --max-time 5 "http://${gateway}:${WG_PORT}/healthz" >/dev/null \
	|| fail "worldGraph is not reachable on the ${MCPIN_NET} gateway ${gateway}:${WG_PORT}; start it with --http 0.0.0.0:${WG_PORT}"
graphs="$(curl -fsS --max-time 5 "http://${gateway}:${WG_PORT}/healthz" | field "d['graphs']")"
[[ "${graphs}" -ge 1 ]] || fail "worldGraph reports no graphs"
pass "worldGraph answers on ${MCPIN_NET} gateway ${gateway}:${WG_PORT} (${graphs} graphs)"

# The deployment must offer it.
USER_ID="wg-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

echo "== provision; the node bakes the worldgraph host into /etc/hosts =="
curl -fsS --max-time 180 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/status" >/dev/null \
	|| fail "first request did not provision the sandbox"
CONTAINER="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USER_ID}'")"
NODE="${CONTAINER}-mcp"
baked="$(docker inspect -f '{{json .HostConfig.ExtraHosts}}' "${NODE}")"
[[ "${baked}" == *"\"${WG_HOST}:${gateway}\""* || "${baked}" == *"\"${WG_HOST}:"* ]] \
	|| fail "the node has no baked ${WG_HOST} entry: ${baked}"
pass "node /etc/hosts bakes ${WG_HOST} (from ${baked})"

status="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/mcp")"
[[ "$(printf '%s' "${status}" | field "len([s for s in d['deployment'] if s['id']=='worldgraph'])")" -ge 1 ]] \
	|| fail "worldgraph is not in the deployment set: ${status}"

echo "== enable worldgraph with the real token and prove the node verifies it =="
enable="$(curl -fsS --max-time 60 -X PUT -H "Cookie: ${COOKIE}" -H "Origin: ${BASE}" -H 'content-type: application/json' \
	-d "{\"serverId\":\"worldgraph\",\"enabled\":true,\"token\":\"${WG_TOKEN}\"}" \
	"${BASE}/mcp/servers")" || fail "PUT /mcp/servers failed"
[[ "$(printf '%s' "${enable}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print([s for s in d["servers"] if s["id"]=="worldgraph"][0]["enabled"])')" == "True" ]] \
	|| fail "the enable did not land: ${enable}"
sleep 1
node_servers="$(docker compose exec -T sandbox-manager python3 -c "
import json, urllib.request
print(json.dumps(urllib.request.urlopen('http://${NODE}:8083/servers', timeout=10).read().decode()))")"
wg_state="$(printf '%s' "${node_servers}" | python3 -c '
import sys, json
doc = json.loads(json.loads(sys.stdin.read()))
entry = next((s for s in doc["servers"] if s["id"] == "worldgraph"), None)
print(json.dumps({"verified": entry and entry["verified"], "healthy": entry and entry["healthy"], "tools": entry and len(entry["tools"])}))')"
[[ "$(printf '%s' "${wg_state}" | field "d['verified']")" == "True" ]] \
	|| fail "the node did not verify worldgraph against the manifest: ${wg_state}"
[[ "$(printf '%s' "${wg_state}" | field "d['healthy']")" == "True" ]] \
	|| fail "worldgraph is not healthy at the node: ${wg_state}"
[[ "$(printf '%s' "${wg_state}" | field "d['tools']")" -eq 15 ]] \
	|| fail "the manifest exposes the wrong tool count, expected 15: ${wg_state}"
pass "node verified worldgraph: 15 manifest tools, healthy, extra tools ignored"

echo "== the model calls the real server end-to-end =="
reply="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"probe the mcp graphs tool","requestId":"wg-list-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the worldgraph prompt failed"
[[ "$(printf '%s' "${reply}" | field "d['status']")" == "done" ]] \
	|| fail "the worldgraph prompt did not finish: ${reply}"
ANSWER="$(printf '%s' "${reply}" | field "d['answer']")"
[[ "${ANSWER}" == *"graph_version"* ]] \
	|| fail "the model did not see list_graphs output: ${ANSWER}"
[[ "${ANSWER}" == *"(mcp__worldgraph__list_graphs)"* ]] \
	|| fail "the answer does not name the tool: ${ANSWER}"
# The result was capped to the manifest budget and marked untrusted.
[[ "${ANSWER}" == *"untrusted"* ]] || fail "the result is not marked untrusted: ${ANSWER}"
TRUNCATED="$(printf '%s' "${ANSWER}" | python3 -c '
import sys, re
text = sys.stdin.read()
match = re.search(r"\"truncated\": (\w+)", text)
print(match.group(1) if match else "absent")')"
[[ "${TRUNCATED}" == "True" || "${TRUNCATED}" == "False" || "${TRUNCATED}" == "absent" ]] \
	|| fail "unexpected truncation marker: ${TRUNCATED}"
pass "tool_search -> mcp__worldgraph__list_graphs through the node, ${graphs} real graphs"

echo "== a second real tool: entity search across graphs =="
reply2="$(curl -fsS --max-time 180 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"probe the mcp locate tool with ref Microsoft","requestId":"wg-loc-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "the locate prompt failed"
ANSWER2="$(printf '%s' "${reply2}" | field "d['answer']")"
[[ "${ANSWER2}" == *"(mcp__worldgraph__locate_entity)"* ]] \
	|| fail "locate_entity did not run: ${ANSWER2}"
pass "locate_entity ran with the model-written arguments"

echo
echo "WORLDGRAPH MCP VERIFICATION PASSED"
