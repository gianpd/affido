#!/usr/bin/env bash
# RFC 0012 M2/M3/M5: the BYOK chain end-to-end against a fake OpenAI-compatible
# upstream, driven only through Caddy at localhost:18080. Preconditions (set up
# by verify.sh): the stack runs with AGENT_EGRESS=open PROVIDER_DEV_HTTP=1
# FAKE_UPSTREAM_CONTAINER=e2e-fake-upstream, the fake upstream container is on
# the compose network, and a KEK exists. The default keyless gate is untouched
# (R7): this script never runs against it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

USER_K="byok-${RUN_ID}"
USER_V="byok-v-${RUN_ID}"
TOKEN="tok-${USER_K}"
TOKEN_V="tok-${USER_V}"
COOKIE="better-auth.session_token=${TOKEN}"
COOKIE_V="better-auth.session_token=${TOKEN_V}"
ORIGIN="Origin: ${BASE}"
KEY1="sk-byok-one-${RUN_ID}"
KEY2="sk-byok-two-${RUN_ID}"
KEYV="sk-byok-valid-${RUN_ID}"
FAKE="e2e-fake-upstream"

seed_session "${USER_K}" "${TOKEN}"
seed_session "${USER_V}" "${TOKEN_V}"
pass "seeded sessions for ${USER_K} and ${USER_V}"

upstream_log() { # JSON array of {path, auth} the fake upstream saw
	docker exec "${FAKE}" node -e "fetch('http://localhost:8090/_log').then((r)=>r.text()).then(console.log)"
}
upstream_reset() {
	docker exec "${FAKE}" node -e "fetch('http://localhost:8090/_reset',{method:'POST'}).then(()=>console.log('reset'))" >/dev/null
}
bearers() { # one "path auth" line per recorded request, in order
	upstream_log | python3 -c "
import sys, json
for entry in json.load(sys.stdin):
    print(entry['path'], entry['auth'])"
}
prompt() { # prompt <request-id>
	curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" -H 'content-type: application/json' \
		-d "{\"prompt\":\"list the files\",\"requestId\":\"$1\"}" \
		"${BASE}/u/${USER_K}/prompt"
}
agent_status() {
	curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_K}/status"
}

echo "== setup through Caddy: key stored, masked view returned (§6.1) =="
upstream_reset
put="$(curl -fsS --max-time 60 -X PUT -H "Cookie: ${COOKIE}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d "{\"provider\":\"e2e-fake\",\"modelId\":\"e2e-fake-1\",\"apiKey\":\"${KEY1}\"}" \
	"${BASE}/providers/config")"
FINGERPRINT1="$(printf '%s' "${put}" | field "d['keys'][0]['fingerprint']")"
[[ "${FINGERPRINT1}" =~ ^[0-9a-f]{12}$ ]] || fail "PUT returned no fingerprint: ${put}"
[[ "$(printf '%s' "${put}" | grep -cF "${KEY1}")" == "0" ]] || fail "PUT response contains the key"
[[ "$(printf '%s' "${put}" | field "d['selection']['provider']")" == "e2e-fake" ]] \
	|| fail "selection not stored: ${put}"
sql -c "SELECT 1 FROM provider_key WHERE user_id = '${USER_K}' AND provider = 'e2e-fake'" >/dev/null
# Ciphertext, not plaintext: the stored bytes must not contain the key's hex.
HEXKEY1="$(printf '%s' "${KEY1}" | xxd -p | tr -d '\n')"
if sql -c "SELECT encode(ciphertext, 'hex') FROM provider_key WHERE user_id = '${USER_K}'" | grep -qF "${HEXKEY1}"; then
	fail "provider_key stores the key in the clear"
fi
[[ "$(sql -c "SELECT count(*) FROM provider_key WHERE user_id = '${USER_K}'")" == "1" ]] \
	|| fail "expected exactly one provider_key row"
pass "key stored as ciphertext; response carries only fingerprint ${FINGERPRINT1}"

echo "== first prompt: answered through the sidecar, bearer seen exactly once (§6.2) =="
answer="$(prompt "byok-1")"
[[ "$(printf '%s' "${answer}" | field "d['status']")" == "done" ]] || fail "prompt did not finish: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['answer']")" == *"fake upstream answered"* ]] \
	|| fail "answer did not come from the fake upstream: ${answer}"
CONV="$(printf '%s' "${answer}" | field "d['conversationId']")"
[[ "$(bearers)" == "$(printf '/v1/chat/completions Bearer %s' "${KEY1}")" ]] \
	|| fail "upstream auth log is not exactly one delivered bearer: $(bearers)"
status_json="$(agent_status)"
[[ "$(printf '%s' "${status_json}" | field "d['model']['provider']")" == "e2e-fake" ]] \
	|| fail "status model is not e2e-fake: ${status_json}"
# RFC 0013 R1: the agent process holds no key at all — /status reports where
# the key lives instead of a fingerprint it can no longer compute (§6.2).
[[ "$(printf '%s' "${status_json}" | field "d['keyVia']")" == "sidecar" ]] \
	|| fail "agent keyVia is not sidecar: ${status_json}"
[[ "$(printf '%s' "${status_json}" | field "d['keyFingerprint']")" == "None" ]] \
	|| fail "agent reports a keyFingerprint in sidecar mode: ${status_json}"
pass "delivery -> generation through the sidecar with Bearer <key> exactly once; agent /status: keyVia=sidecar, no fingerprint"

echo "== the sidecar pair exists and reports the key half (RFC 0013 §6.3, R9) =="
CONTAINER="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USER_K}'")"
SIDECAR_C="${CONTAINER}-sidecar"
[[ "$(docker inspect -f '{{.State.Running}}' "${SIDECAR_C}")" == "true" ]] \
	|| fail "sidecar ${SIDECAR_C} is not running"
# Same image, second entrypoint, reduced caps (R10), phase 0 hardening.
[[ "$(docker inspect -f '{{.Config.Image}}' "${SIDECAR_C}")" == "$(docker inspect -f '{{.Config.Image}}' "${CONTAINER}")" ]] \
	|| fail "sidecar runs a different image than the agent"
side_mem="$(docker inspect -f '{{.HostConfig.Memory}}' "${SIDECAR_C}")"
agent_mem="$(docker inspect -f '{{.HostConfig.Memory}}' "${CONTAINER}")"
[[ "${side_mem}" -lt "${agent_mem}" ]] \
	|| fail "sidecar memory cap ${side_mem} is not below the agent's ${agent_mem} (R10)"
sidecar_status() {
	docker exec "${SIDECAR_C}" node -e \
		"fetch('http://127.0.0.1:8081/status').then((r)=>r.text()).then(console.log)"
}
side_json="$(sidecar_status)"
[[ "$(printf '%s' "${side_json}" | field "d['provider']")" == "e2e-fake" ]] \
	|| fail "sidecar /status provider: ${side_json}"
[[ "$(printf '%s' "${side_json}" | field "d['keyFingerprint']")" == "${FINGERPRINT1}" ]] \
	|| fail "sidecar /status fingerprint mismatch: ${side_json}"
[[ "$(printf '%s' "${side_json}" | field "d['upstream']")" == "http://${FAKE}:8090/v1" ]] \
	|| fail "sidecar upstream is not the pinned fake endpoint: ${side_json}"
# No agent<->sidecar auth by design (§6.1): the peer on that network is the
# agent, and the only thing it can do is spend quota on the pinned upstream.
# R3 from the inside: a request for an unpinned host is refused.
unpinned="$(docker exec "${CONTAINER}" node -e \
	"fetch('http://${SIDECAR_C}:8081/e2e-fake/~/'+encodeURIComponent('http://attacker.example/v1')+'/chat/completions',{method:'POST',body:'{}'}).then(async(r)=>console.log(r.status+' '+(await r.text()))).catch(()=>console.log('dial-failed'))")"
[[ "${unpinned}" == "403"*unpinned_upstream* ]] \
	|| fail "the agent's own sidecar did not refuse an unpinned upstream: ${unpinned}"
foreign="$(docker exec "${CONTAINER}" node -e \
	"fetch('http://${SIDECAR_C}:8081/openai/~/'+encodeURIComponent('https://api.openai.com/v1')+'/models').then(async(r)=>console.log(r.status)).catch(()=>console.log('dial-failed'))")"
[[ "${foreign}" == "404" ]] \
	|| fail "the sidecar answered a foreign provider prefix: ${foreign}"
pass "sidecar running (same image, capped), /status reports fingerprint+upstream, unpinned/foreign requests refused"

echo "== no key material in the agent's env, filesystem, or logs (R3/§8.1, RFC 0013 R1) =="
if docker inspect "${CONTAINER}" | grep -qF "${KEY1}"; then fail "key in docker inspect"; fi
if docker exec "${CONTAINER}" sh -c 'cat /proc/1/environ' | grep -qF "${KEY1}"; then fail "key in /proc/1/environ"; fi
if docker exec "${CONTAINER}" grep -R -qF "${KEY1}" /data /workspace; then fail "key in /data or /workspace"; fi
if docker exec "${CONTAINER}" grep -R -qF "${KEY1}" /app; then fail "key in the agent image layer /app"; fi
if docker logs sandbox-manager 2>&1 | grep -qF "${KEY1}"; then fail "key in manager logs"; fi
# The key's only plaintext home is the sidecar process's RAM: not its env,
# not its filesystem, not its docker metadata, not its logs.
if docker inspect "${SIDECAR_C}" | grep -qF "${KEY1}"; then fail "key in sidecar docker inspect"; fi
if docker exec "${SIDECAR_C}" sh -c 'cat /proc/1/environ' | grep -qF "${KEY1}"; then fail "key in sidecar /proc/1/environ"; fi
if docker exec "${SIDECAR_C}" grep -R -qF "${KEY1}" /app /tmp; then fail "key in sidecar filesystem"; fi
if docker logs "${SIDECAR_C}" 2>&1 | grep -qF "${KEY1}"; then fail "key in sidecar logs"; fi
pass "agent and sidecar: docker inspect, env, filesystems and logs are key-free (RAM-only custody)"

echo "== later requests re-deliver nothing: resolve reconciles to matching state =="
before="$(bearers | wc -l)"
for _ in 1 2 3; do agent_status >/dev/null; done
[[ "$(bearers | wc -l)" == "${before}" ]] || fail "status requests triggered extra upstream traffic"
pass "three resolves against matching state: no extra upstream requests"

echo "== rotation: a new key changes the bearer on the next request (§6.3) =="
put="$(curl -fsS --max-time 60 -X PUT -H "Cookie: ${COOKIE}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d "{\"provider\":\"e2e-fake\",\"modelId\":\"e2e-fake-1\",\"apiKey\":\"${KEY2}\"}" \
	"${BASE}/providers/config")"
FINGERPRINT2="$(printf '%s' "${put}" | field "d['keys'][0]['fingerprint']")"
[[ "${FINGERPRINT2}" != "${FINGERPRINT1}" ]] || fail "rotation did not change the fingerprint"
answer="$(prompt "byok-2")"
[[ "$(printf '%s' "${answer}" | field "d['status']")" == "done" ]] || fail "prompt after rotation failed: ${answer}"
expected_log="$(printf '/v1/chat/completions Bearer %s\n/v1/chat/completions Bearer %s' "${KEY1}" "${KEY2}")"
[[ "$(bearers)" == "${expected_log}" ]] || fail "rotation did not change the bearer: $(bearers)"
status_json="$(agent_status)"
[[ "$(printf '%s' "${status_json}" | field "d['keyVia']")" == "sidecar" ]] \
	|| fail "keyVia after rotation: ${status_json}"
side_json="$(sidecar_status)"
[[ "$(printf '%s' "${side_json}" | field "d['keyFingerprint']")" == "${FINGERPRINT2}" ]] \
	|| fail "sidecar /status fingerprint after rotation: ${side_json}"
pass "rotation re-delivered; upstream saw the new bearer; sidecar fingerprint ${FINGERPRINT2}"

echo "== upstream validation: verified keys pass, invalid_key stores nothing (§5.6, §7.2) =="
put="$(curl -fsS --max-time 60 -X PUT -H "Cookie: ${COOKIE_V}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d "{\"provider\":\"e2e-fake\",\"modelId\":\"e2e-fake-1\",\"apiKey\":\"${KEYV}\",\"validate\":true}" \
	"${BASE}/providers/config")"
[[ "$(printf '%s' "${put}" | field "d['keys'][0]['verified']")" == "True" ]] \
	|| fail "validated key not marked verified: ${put}"
[[ "$(bearers | tail -1)" == "/v1/models Bearer ${KEYV}" ]] \
	|| fail "validation did not hit GET /v1/models with the key: $(bearers)"
put="$(curl -s --max-time 60 -X PUT -H "Cookie: ${COOKIE_V}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d '{"provider":"e2e-fake","modelId":"e2e-fake-1","apiKey":"sk-bad-key-x","validate":true}' \
	"${BASE}/providers/config")"
[[ "$(printf '%s' "${put}" | field "d['error']")" == "invalid_key" ]] || fail "bad key not rejected: ${put}"
config_v="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE_V}" "${BASE}/providers/config")"
keys_v="$(printf '%s' "${config_v}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d['keys']))")"
[[ "${keys_v}" == "1" ]] || fail "invalid key was stored or evicted the good one: ${config_v}"
pass "validation: good key verified via /v1/models; invalid_key stores nothing"

echo "== durability: L0 pause keeps model and key custody (§10 M3) =="
paused=""
for _ in $(seq 1 30); do
	paused="$(agent_status | field "d['paused']")"
	[[ "${paused}" == "True" ]] && break
	sleep 1
done
[[ "${paused}" == "True" ]] || fail "agent did not reach L0 pause"
answer="$(prompt "byok-3")"
[[ "$(printf '%s' "${answer}" | field "d['conversationId']")" == "${CONV}" ]] \
	|| fail "L0 recovery changed the conversation: ${answer}"
status_json="$(agent_status)"
[[ "$(printf '%s' "${status_json}" | field "d['model']['provider']")" == "e2e-fake" ]] \
	&& [[ "$(printf '%s' "${status_json}" | field "d['keyVia']")" == "sidecar" ]] \
	|| fail "L0 recovery lost the runtime model: ${status_json}"
pass "L0 pause + resolve: same model (keyVia=sidecar, ${FINGERPRINT2}), same conversation ${CONV}"

echo "== durability: L1 stop re-delivers, session intact (§6.4) =="
docker stop "${CONTAINER}" >/dev/null
answer="$(prompt "byok-4")"
[[ "$(printf '%s' "${answer}" | field "d['conversationId']")" == "${CONV}" ]] \
	|| fail "L1 recovery changed the conversation: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['answer']")" == *"fake upstream answered"* ]] \
	|| fail "L1 recovery did not re-deliver (answer not from upstream): ${answer}"
[[ "$(bearers | grep -cF "Bearer ${KEY2}")" -ge 3 ]] \
	|| fail "re-delivery did not generate from the upstream again: $(bearers)"
pass "docker stop + resolve: re-delivery, conversation ${CONV} intact"

echo "== durability: agent recreation re-provisions and re-delivers (§10 M3) =="
docker rm -f "${CONTAINER}" >/dev/null
answer="$(prompt "byok-5")"
[[ "$(printf '%s' "${answer}" | field "d['conversationId']")" == "${CONV}" ]] \
	|| fail "recreation changed the conversation: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['answer']")" == *"fake upstream answered"* ]] \
	|| fail "recreation did not re-deliver: ${answer}"
[[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" == "true" ]] \
	|| fail "container was not recreated"
pass "docker rm agent + resolve: reprovision, re-delivery, session intact"

echo "== RFC 0013 R7: docker rm of the SIDECAR re-provisions the pair (§6.3) =="
docker rm -f "${SIDECAR_C}" >/dev/null
answer="$(prompt "byok-6")"
[[ "$(printf '%s' "${answer}" | field "d['conversationId']")" == "${CONV}" ]] \
	|| fail "sidecar recreation changed the conversation: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['answer']")" == *"fake upstream answered"* ]] \
	|| fail "sidecar recreation broke generation: ${answer}"
[[ "$(docker inspect -f '{{.State.Running}}' "${SIDECAR_C}")" == "true" ]] \
	|| fail "sidecar was not recreated"
[[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" == "true" ]] \
	|| fail "agent is not running after pair reprovision"
side_json="$(sidecar_status)"
[[ "$(printf '%s' "${side_json}" | field "d['keyFingerprint']")" == "${FINGERPRINT2}" ]] \
	|| fail "recreated sidecar holds no key: ${side_json}"
pass "docker rm sidecar + resolve: pair recreated, key re-delivered, session intact"

echo "== account-deletion cascade (§7.13) =="
del="$(curl -fsS --max-time 60 -X DELETE -H "Cookie: ${COOKIE_V}" -H "Origin: ${BASE}" \
	"${BASE}/providers/config?all=1")"
[[ "$(printf '%s' "${del}" | field "d['selection']")" == "None" ]] || fail "DELETE ?all=1 kept a selection"
[[ "$(sql -c "SELECT count(*) FROM provider_key WHERE user_id = '${USER_V}'")" == "0" ]] \
	|| fail "DELETE ?all=1 kept provider_key rows"
[[ "$(sql -c "SELECT count(*) FROM provider_selection WHERE user_id = '${USER_V}'")" == "0" ]] \
	|| fail "DELETE ?all=1 kept provider_selection rows"
pass "DELETE ?all=1 drops both tables' rows for the user"

echo "== the manager log stays key-free across every path (M1) =="
for key in "${KEY1}" "${KEY2}" "${KEYV}"; do
	if docker logs sandbox-manager 2>&1 | grep -qF "${key}"; then fail "${key} appears in manager logs"; fi
done
pass "no key bytes ever appear in manager output"

echo
echo "BYOK CHECKS PASSED"
