#!/usr/bin/env bash
# RFC 0012 M1/M4: the manager's /providers API against the default stack
# (AGENT_EGRESS=off, keyless). Proves: the catalog is served from the agent
# image, the egress gate fails closed, session binding and the CSRF wall hold,
# config GETs are no-store, and the peer guard covers /providers/*.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

USER_A="prov-a-${RUN_ID}"
USER_B="prov-b-${RUN_ID}"
TOKEN_A="tok-${USER_A}"
TOKEN_B="tok-${USER_B}"
COOKIE_A="better-auth.session_token=${TOKEN_A}"
COOKIE_B="better-auth.session_token=${TOKEN_B}"
ORIGIN="Origin: ${BASE}"
MANAGER_TOKEN="$("${COMPOSE[@]}" exec -T sandbox-manager printenv MANAGER_TOKEN | tr -d '\r')"

seed_session "${USER_A}" "${TOKEN_A}"
seed_session "${USER_B}" "${TOKEN_B}"
pass "seeded sessions for ${USER_A} and ${USER_B}"

echo "== catalog: generated from the agent image, served through Caddy =="
catalog="$(curl -fsS --max-time 60 -H "Cookie: ${COOKIE_A}" "${BASE}/providers/catalog")" \
	|| fail "GET /providers/catalog failed"
[[ "$(printf '%s' "${catalog}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [p['id'] for p in d['providers']]
print(' '.join(ids))")" == *"openrouter openai deepseek groq together fireworks xai cerebras mistral"* ]] \
	|| fail "catalog is missing built-in providers: ${catalog}"
models_json="$(printf '%s' "${catalog}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = [x for x in d['providers'] if x['id'] == 'deepseek'][0]
print(p['baseUrl'], len(p['models']) > 0)")"
[[ "${models_json}" == "https://api.deepseek.com True" ]] \
	|| fail "deepseek entry malformed: ${models_json}"
[[ "$(printf '%s' "${catalog}" | grep -c "e2e-fake")" == "0" ]] \
	|| fail "e2e-fake entry must not exist without the dev flags"
pass "catalog served with all 9 built-ins and their models"

echo "== no session through Caddy: 401 before the write handlers =="
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X PUT \
	-H 'content-type: application/json' -d '{"provider":"openai","modelId":"gpt-4"}' \
	"${BASE}/providers/config")"
[[ "${code}" == "401" ]] || fail "PUT through Caddy with no session returned ${code}, expected 401"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/providers/catalog")"
[[ "${code}" == "401" ]] || fail "catalog with no session returned ${code}, expected 401"
pass "cookieless browser requests never reach the write handlers (forward_auth /whoami)"

echo "== egress gate: a real provider fails closed at setup (§5.5) =="
put="$(curl -s --max-time 30 -X PUT -H "Cookie: ${COOKIE_A}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d '{"provider":"openai","modelId":"gpt-4","apiKey":"sk-should-not-store"}' \
	"${BASE}/providers/config")"
[[ "$(printf '%s' "${put}" | field "d['error']")" == "egress_blocked" ]] \
	|| fail "PUT with a real provider under egress=off: ${put}"
keys="$(sql -c "SELECT count(*) FROM provider_key WHERE user_id = '${USER_A}'")"
[[ "${keys}" == "0" ]] || fail "egress_blocked PUT stored a key anyway"
selection="$(sql -c "SELECT count(*) FROM provider_selection WHERE user_id = '${USER_A}'")"
[[ "${selection}" == "0" ]] || fail "egress_blocked PUT stored a selection anyway"
pass "provider != faux with AGENT_EGRESS=off answers egress_blocked and stores nothing"

echo "== custom baseUrl rules (§5.1) =="
put="$(curl -s --max-time 30 -X PUT -H "Cookie: ${COOKIE_A}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d '{"provider":"custom","modelId":"m","baseUrl":"http://api.example.com/v1","apiKey":"sk-x"}' \
	"${BASE}/providers/config")"
[[ "$(printf '%s' "${put}" | field "d['error']")" == "invalid_base_url" ]] \
	|| fail "http baseUrl accepted without the dev flag: ${put}"
put="$(curl -s --max-time 30 -X PUT -H "Cookie: ${COOKIE_A}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d '{"provider":"custom","modelId":"m","baseUrl":"https://localhost/v1","apiKey":"sk-x"}' \
	"${BASE}/providers/config")"
[[ "$(printf '%s' "${put}" | field "d['error']")" == "invalid_base_url" ]] \
	|| fail "private-network baseUrl accepted: ${put}"
pass "http-only and private-network custom baseUrls are rejected"

echo "== CSRF: a browser-path write without Origin is 403 (§7.14) =="
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X PUT \
	-H "Cookie: ${COOKIE_A}" -H 'content-type: application/json' \
	-d '{"provider":"faux","modelId":"faux-1"}' \
	"${BASE}/providers/config")"
[[ "${code}" == "403" ]] || fail "no-Origin PUT returned ${code}, expected 403"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X PUT \
	-H "Cookie: ${COOKIE_A}" -H "Origin: http://evil.example" -H 'content-type: application/json' \
	-d '{"provider":"faux","modelId":"faux-1"}' \
	"${BASE}/providers/config")"
[[ "${code}" == "403" ]] || fail "cross-origin PUT returned ${code}, expected 403"
pass "PUT without Origin and with a foreign Origin are both 403"

echo "== faux selection round-trip: masked view, no-store, trusted delete =="
put="$(curl -fsS --max-time 30 -X PUT -H "Cookie: ${COOKIE_A}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d '{"provider":"faux","modelId":"faux-1"}' \
	"${BASE}/providers/config")"
[[ "$(printf '%s' "${put}" | field "d['selection']['provider']")" == "faux" ]] \
	|| fail "faux selection was not stored: ${put}"
[[ "$(printf '%s' "${put}" | field "len(d['keys'])")" == "0" ]] \
	|| fail "faux selection must not create keys: ${put}"
headers="$(curl -s -D - -o /dev/null --max-time 30 -H "Cookie: ${COOKIE_A}" "${BASE}/providers/config")"
grep -qi '^cache-control: no-store' <<<"${headers}" \
	|| fail "GET /providers/config is not no-store: ${headers}"
pass "faux selection stored; GET /providers/config is Cache-Control: no-store"

echo "== session binding: identity is the cookie, mismatch is 403 (§5.3) =="
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
	-H "Cookie: ${COOKIE_A}" "${BASE}/providers/config?user_id=${USER_B}")"
[[ "${code}" == "403" ]] || fail "cross-user config GET returned ${code}, expected 403"
# A write carrying another user's body user_id is ignored outright: it lands on
# the session's own user (review clarification of §5.3).
put="$(curl -fsS --max-time 30 -X PUT -H "Cookie: ${COOKIE_B}" -H "Origin: ${BASE}" \
	-H 'content-type: application/json' \
	-d "{\"user_id\":\"${USER_A}\",\"provider\":\"faux\",\"modelId\":\"faux-1\"}" \
	"${BASE}/providers/config")"
sel_b="$(sql -c "SELECT provider FROM provider_selection WHERE user_id = '${USER_B}'")"
[[ "${sel_b}" == "faux" ]] || fail "body user_id was not ignored: B selection is '${sel_b}'"
[[ "$(sql -c "SELECT count(*) FROM provider_selection WHERE user_id = '${USER_A}' AND provider != 'faux'")" == "0" ]] \
	|| fail "user A selection changed from B's write"
pass "session is the write identity; cross-user reads 403, body user_id ignored"

echo "== trusted-caller path: token wall, write with explicit user_id =="
# The trusted caller is a container on the compose network (the SvelteKit app
# of RFC 0003); e2e drives it from the manager's own network namespace.
EXEC=(docker compose -f "${ROOT}/docker-compose.yml" exec -T sandbox-manager)
no_token="$(docker compose -f "${ROOT}/docker-compose.yml" exec -T -e MANAGER_TOKEN= sandbox-manager \
	python3 - GET "/providers/config?user_id=${USER_A}" < "${E2E_DIR}/manager-call.py" | head -1 | tr -d '\r' || true)"
[[ "${no_token}" == "401" ]] || fail "trusted path without token returned ${no_token}, expected 401"
trusted_put="$("${EXEC[@]}" python3 - PUT /providers/config \
	"{\"user_id\": \"${USER_A}\", \"provider\": \"faux\", \"modelId\": \"faux-1\"}" \
	< "${E2E_DIR}/manager-call.py" | tail -1 | field "d['selection']['provider']" || true)"
[[ "${trusted_put}" == "faux" ]] || fail "trusted PUT did not store the selection: ${trusted_put}"
trusted="$("${EXEC[@]}" python3 - DELETE "/providers/config?user_id=${USER_A}" \
	< "${E2E_DIR}/manager-call.py" | tail -1 | field "d['selection']" || true)"
[[ "${trusted}" == "None" ]] || fail "trusted DELETE did not clear the selection: ${trusted}"
[[ "$(sql -c "SELECT count(*) FROM provider_selection WHERE user_id = '${USER_A}'")" == "0" ]] \
	|| fail "selection survived the trusted DELETE"
pass "trusted path: 401 without the token, DELETE with it works"

echo "== peer guard: a sandbox calling /providers/* is 403 (§8.2) =="
ATK_USER="prov-atk-${RUN_ID}"
ATK_TOKEN="tok-${ATK_USER}"
seed_session "${ATK_USER}" "${ATK_TOKEN}"
curl -fsS --max-time 90 -H "Cookie: better-auth.session_token=${ATK_TOKEN}" "${BASE}/u/${ATK_USER}/status" >/dev/null \
	|| fail "attacker sandbox did not provision"
ATK_C="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${ATK_USER}'")"
probe="$(docker exec "${ATK_C}" node -e "
fetch('http://sandbox-manager:8090/providers/catalog', { headers: { 'X-Manager-Token': process.argv[1] } })
	.then((r) => console.log(r.status))
	.catch(() => console.log('err'))" "${MANAGER_TOKEN}")"
[[ "${probe}" == "403" ]] || fail "sandbox reached /providers/catalog: ${probe}"
pass "peer guard rejects sandbox peers on /providers/*"

echo
echo "PROVIDERS API CHECKS PASSED"
