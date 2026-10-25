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

echo "== first prompt: answered by the fake upstream, bearer seen exactly once (§6.2) =="
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
[[ "$(printf '%s' "${status_json}" | field "d['keyFingerprint']")" == "${FINGERPRINT1}" ]] \
	|| fail "status fingerprint mismatch: ${status_json}"
pass "delivery -> generation with Bearer <key> exactly once; /status shows the fingerprint"

echo "== no key material in env, filesystem, or logs (R3, §8.1) =="
CONTAINER="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USER_K}'")"
if docker inspect "${CONTAINER}" | grep -qF "${KEY1}"; then fail "key in docker inspect"; fi
if docker exec "${CONTAINER}" sh -c 'cat /proc/1/environ' | grep -qF "${KEY1}"; then fail "key in /proc/1/environ"; fi
if docker exec "${CONTAINER}" grep -R -qF "${KEY1}" /data /workspace; then fail "key in /data or /workspace"; fi
if docker logs sandbox-manager 2>&1 | grep -qF "${KEY1}"; then fail "key in manager logs"; fi
pass "docker inspect, /proc/1/environ, /data, /workspace and manager logs are key-free"

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
[[ "$(printf '%s' "${status_json}" | field "d['keyFingerprint']")" == "${FINGERPRINT2}" ]] \
	|| fail "status fingerprint after rotation: ${status_json}"
pass "rotation re-delivered; upstream saw the new bearer; fingerprint ${FINGERPRINT2}"

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

echo "== durability: L0 pause keeps model and fingerprint (§10 M3) =="
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
	&& [[ "$(printf '%s' "${status_json}" | field "d['keyFingerprint']")" == "${FINGERPRINT2}" ]] \
	|| fail "L0 recovery lost the runtime model: ${status_json}"
pass "L0 pause + resolve: same model ${FINGERPRINT2}, same conversation ${CONV}"

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

echo "== durability: container recreation re-provisions and re-delivers (§10 M3) =="
docker rm -f "${CONTAINER}" >/dev/null
answer="$(prompt "byok-5")"
[[ "$(printf '%s' "${answer}" | field "d['conversationId']")" == "${CONV}" ]] \
	|| fail "recreation changed the conversation: ${answer}"
[[ "$(printf '%s' "${answer}" | field "d['answer']")" == *"fake upstream answered"* ]] \
	|| fail "recreation did not re-deliver: ${answer}"
[[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" == "true" ]] \
	|| fail "container was not recreated"
pass "docker rm + resolve: reprovision, re-delivery, session intact"

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
