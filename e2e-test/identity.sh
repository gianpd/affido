#!/usr/bin/env bash
# RFC 0023: the machine identity surface through Caddy.
#
# Proves the scoped X-Identity-Key gate (not MANAGER_TOKEN), the Origin wall,
# the user+account+session transaction, better-auth-compatible hash and cookie,
# /whoami's email/name, duplicate and concurrent registration, session
# compatibility with forward_auth, and logout revocation. Everything goes
# through Caddy at localhost:18080.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready
AUTH_TABLES_CREATED=0
TMP="$(mktemp -d)"
cleanup() {
	# Remove this run's identity rows even when the web app's schema existed
	# before the e2e; when the e2e created user/account, drop them too so a
	# later `pnpm db:migrate` starts clean.
	sql -c "DELETE FROM \"session\" WHERE \"userId\" IN (SELECT id FROM \"user\" WHERE email LIKE 'identity-%${RUN_ID}%')" \
		>/dev/null 2>&1 || true
	if [[ "${AUTH_TABLES_CREATED:-0}" == "1" ]]; then
		sql -c 'DROP TABLE IF EXISTS "account"; DROP TABLE IF EXISTS "user";' \
			>/dev/null 2>&1 || true
	else
		sql -c "DELETE FROM \"account\" WHERE \"userId\" IN (SELECT id FROM \"user\" WHERE email LIKE 'identity-%${RUN_ID}%')" \
			>/dev/null 2>&1 || true
		sql -c "DELETE FROM \"user\" WHERE email LIKE 'identity-%${RUN_ID}%'" \
			>/dev/null 2>&1 || true
	fi
	rm -rf "${TMP}"
}
trap cleanup EXIT
ensure_auth_tables
pass "better-auth tables present (user, account, session)"

KEY="$(manager_env IDENTITY_API_KEY)"
[[ -n "${KEY}" ]] || fail "manager has no IDENTITY_API_KEY (run ./dev.sh up or verify.sh)"
[[ -n "$(manager_env BETTER_AUTH_SECRET)" ]] || fail "manager has no BETTER_AUTH_SECRET"
ORIGIN_ENV="$(manager_env ORIGIN)"
[[ -n "${ORIGIN_ENV}" ]] || fail "manager has no ORIGIN"
if [[ "${ORIGIN_ENV}" == https://* ]]; then
	COOKIE_NAME="__Secure-better-auth.session_token"
else
	COOKIE_NAME="better-auth.session_token"
fi
pass "identity surface configured (cookie ${COOKIE_NAME})"

BODY_FILE="${TMP}/body"
HEADER_FILE="${TMP}/headers"
STATUS=""

# call METHOD PATH DATA [curl args...]: DATA "-" sends no body. Sets STATUS,
# BODY_FILE and HEADER_FILE. The key is never part of the URL.
call() {
	local method="$1" path="$2" data="$3"
	shift 3
	BODY_FILE="${TMP}/body"
	HEADER_FILE="${TMP}/headers"
	local args=(-sS -o "${BODY_FILE}" -D "${HEADER_FILE}" -w '%{http_code}' -X "${method}")
	if [[ "${data}" != "-" ]]; then
		args+=(-H 'content-type: application/json' -d "${data}")
	fi
	STATUS="$(curl "${args[@]}" "$@" "${BASE}${path}")"
}

body_field() { python3 -c "import json; d=json.load(open('${BODY_FILE}')); print($1)"; }
header_is() { grep -qi "^$1: $2" "${HEADER_FILE}" || fail "missing header $1: $2 in $(tr -d '\r' <"${HEADER_FILE}")"; }
rows() { sql -c "$1"; }

register_body() {
	python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2], "name": sys.argv[3]}))' "$1" "$2" "$3"
}
login_body() {
	python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "$1" "$2"
}

PASSWORD="correct horse battery staple"
EMAIL_RAW="Identity-${RUN_ID}@Example.COM"
EMAIL="$(printf '%s' "${EMAIL_RAW}" | tr '[:upper:]' '[:lower:]')"

echo "== GET on the POST routes is 405 JSON (route present, no account created) =="
call GET /identity/register -
[[ "${STATUS}" == "405" ]] || fail "GET /identity/register returned ${STATUS}, expected 405"
[[ "$(body_field "d['code']")" == "method_not_allowed" ]] || fail "405 body: $(cat "${BODY_FILE}")"
header_is allow POST
header_is cache-control no-store
header_is content-type application/json
pass "GET /identity/register is 405 JSON with Allow: POST and no-store"

echo "== /whoami without a session is 401 JSON no-store =="
call GET /whoami -
[[ "${STATUS}" == "401" ]] || fail "cookieless /whoami returned ${STATUS}, expected 401"
header_is cache-control no-store
header_is content-type application/json
pass "cookieless /whoami is 401 JSON no-store"

echo "== a wrong key writes nothing and cannot be guessed from the query string =="
call POST /identity/register "$(register_body "${EMAIL}" "${PASSWORD}" "Elena")" \
	-H 'X-Identity-Key: wrong-key'
[[ "${STATUS}" == "401" ]] || fail "wrong key returned ${STATUS}, expected 401"
[[ "$(body_field "d['code']")" == "unauthorized" ]] || fail "wrong-key body: $(cat "${BODY_FILE}")"
[[ "$(rows "SELECT count(*) FROM \"user\" WHERE email = '${EMAIL}'")" == "0" ]] \
	|| fail "a rejected register wrote a user row"
call POST "/identity/register?X-Identity-Key=${KEY}" "$(register_body "${EMAIL}" "${PASSWORD}" "Elena")"
[[ "${STATUS}" == "401" ]] || fail "key-only-in-query returned ${STATUS}, expected 401"
pass "bad key and query-string key are 401, zero rows written"

echo "== a request carrying Origin is 403 and writes nothing =="
call POST /identity/register "$(register_body "${EMAIL}" "${PASSWORD}" "Elena")" \
	-H "X-Identity-Key: ${KEY}" -H "Origin: ${BASE}"
[[ "${STATUS}" == "403" ]] || fail "Origin-bearing register returned ${STATUS}, expected 403"
[[ "$(body_field "d['code']")" == "forbidden_origin" ]] || fail "origin body: $(cat "${BODY_FILE}")"
[[ "$(rows "SELECT count(*) FROM \"user\" WHERE email = '${EMAIL}'")" == "0" ]] \
	|| fail "a rejected register wrote a user row"
pass "Origin-bearing register is 403, zero rows written"

echo "== register: user + account + session in one transaction, better-auth formats =="
call POST /identity/register "$(register_body "${EMAIL_RAW}" "${PASSWORD}" " Elena ")" \
	-H "X-Identity-Key: ${KEY}"
[[ "${STATUS}" == "201" ]] || fail "register returned ${STATUS}: $(cat "${BODY_FILE}")"
USER_ID="$(body_field "d['user']['id']")"
[[ "$(body_field "d['user']['email']")" == "${EMAIL}" ]] || fail "register did not lowercase the email"
[[ "$(body_field "d['user']['name']")" == "Elena" ]] || fail "register did not trim the name"
COOKIE="$(body_field "d['session']['cookie']")"
[[ "${COOKIE}" == "${COOKIE_NAME}="* ]] || fail "cookie name is not ${COOKIE_NAME}: ${COOKIE}"
TOKEN="$(python3 - "${COOKIE}" <<'PY'
import sys, urllib.parse
value = sys.argv[1].split("=", 1)[1]
print(urllib.parse.unquote(value).split(".", 1)[0])
PY
)"
[[ "${TOKEN}" =~ ^[A-Za-z0-9]{32}$ ]] || fail "session token is not 32 alphanumerics: ${TOKEN}"
[[ "${USER_ID}" =~ ^[A-Za-z0-9]{32}$ ]] || fail "user id is not 32 alphanumerics: ${USER_ID}"
[[ "$(rows "SELECT count(*) FROM \"user\" WHERE email = '${EMAIL}'")" == "1" ]] || fail "user row missing"
[[ "$(rows "SELECT count(*) FROM \"account\" WHERE \"userId\" = '${USER_ID}' AND \"accountId\" = '${USER_ID}' AND \"providerId\" = 'credential'")" == "1" ]] \
	|| fail "credential account row missing or malformed"
[[ "$(rows "SELECT \"emailVerified\" FROM \"user\" WHERE id = '${USER_ID}'")" == "f" ]] \
	|| fail "emailVerified must start false"
[[ "$(rows "SELECT extract(day FROM \"expiresAt\" - now())::int FROM \"session\" WHERE token = '${TOKEN}'")" == "6" ]] \
	|| fail "session does not expire in ~7 days"
HASH="$(rows "SELECT password FROM \"account\" WHERE \"userId\" = '${USER_ID}'")"
[[ "${HASH}" =~ ^[0-9a-f]{32}:[0-9a-f]{128}$ ]] || fail "password is not salt:key (32:128 hex)"
docker compose exec -T -e TEST_HASH="${HASH}" -e TEST_PASSWORD="${PASSWORD}" sandbox-manager \
	python3 -c 'import os, sandbox_manager as sm; assert sm.verify_password(os.environ["TEST_HASH"], os.environ["TEST_PASSWORD"]); print("hash-ok")' \
	| grep -q hash-ok || fail "stored hash does not verify the plaintext"
COOKIE_CHECK="$(docker compose exec -T -e TEST_COOKIE="${COOKIE}" sandbox-manager python3 - <<'PY'
import base64, hashlib, hmac, os, urllib.parse
cookie = os.environ["TEST_COOKIE"]
_, _, value = cookie.partition("=")
token, _, signature = urllib.parse.unquote(value).rpartition(".")
want = base64.b64encode(
    hmac.new(os.environ["BETTER_AUTH_SECRET"].encode(), token.encode(), hashlib.sha256).digest()
).decode()
assert signature == want, "signature mismatch"
print("cookie-ok")
PY
)"
[[ "${COOKIE_CHECK}" == *cookie-ok* ]] || fail "cookie is not better-auth's signed format"
pass "register wrote user/account/session; hash and cookie match better-auth"

echo "== whoami returns user_id, email and name; no-store =="
call GET /whoami - -H "Cookie: ${COOKIE}"
[[ "${STATUS}" == "200" ]] || fail "whoami with the session returned ${STATUS}"
[[ "$(body_field "d['user_id']")" == "${USER_ID}" ]] || fail "whoami user_id: $(cat "${BODY_FILE}")"
[[ "$(body_field "d['email']")" == "${EMAIL}" ]] || fail "whoami email: $(cat "${BODY_FILE}")"
[[ "$(body_field "d['name']")" == "Elena" ]] || fail "whoami name: $(cat "${BODY_FILE}")"
header_is cache-control no-store
pass "whoami resolves the session to user_id/email/name"

echo "== login: same answer for a wrong password and an unknown address =="
BEFORE="$(rows "SELECT count(*) FROM \"session\" WHERE \"userId\" = '${USER_ID}'")"
call POST /identity/login "$(login_body "${EMAIL}" "not the password")" -H "X-Identity-Key: ${KEY}"
[[ "${STATUS}" == "401" ]] || fail "wrong password returned ${STATUS}, expected 401"
[[ "$(body_field "d['code']")" == "invalid_credentials" ]] || fail "wrong-password body: $(cat "${BODY_FILE}")"
call POST /identity/login "$(login_body "nobody-${RUN_ID}@example.com" "${PASSWORD}")" -H "X-Identity-Key: ${KEY}"
[[ "${STATUS}" == "401" ]] || fail "unknown email returned ${STATUS}, expected 401"
[[ "$(body_field "d['code']")" == "invalid_credentials" ]] || fail "unknown-email body: $(cat "${BODY_FILE}")"
[[ "$(rows "SELECT count(*) FROM \"session\" WHERE \"userId\" = '${USER_ID}'")" == "${BEFORE}" ]] || fail "a failed login wrote a session"
pass "wrong password and unknown email are both 401 invalid_credentials, no session"

echo "== login: a second session for the same user =="
call POST /identity/login "$(login_body "${EMAIL}" "${PASSWORD}")" -H "X-Identity-Key: ${KEY}"
[[ "${STATUS}" == "200" ]] || fail "login returned ${STATUS}: $(cat "${BODY_FILE}")"
COOKIE2="$(body_field "d['session']['cookie']")"
[[ "${COOKIE2}" != "${COOKIE}" ]] || fail "login reissued the same token"
[[ "$(rows "SELECT count(*) FROM \"session\" WHERE \"userId\" = '${USER_ID}'")" == "$((BEFORE + 1))" ]] || fail "login did not add exactly one session"
call GET /whoami - -H "Cookie: ${COOKIE2}"
[[ "${STATUS}" == "200" ]] || fail "the login cookie does not resolve: ${STATUS}"
pass "login mints a second, distinct session"

echo "== duplicate register is 409 and keeps one account =="
call POST /identity/register "$(register_body "${EMAIL}" "${PASSWORD}" "Elena")" -H "X-Identity-Key: ${KEY}"
[[ "${STATUS}" == "409" ]] || fail "duplicate register returned ${STATUS}: $(cat "${BODY_FILE}")"
[[ "$(body_field "d['code']")" == "email_taken" ]] || fail "duplicate body: $(cat "${BODY_FILE}")"
[[ "$(rows "SELECT count(*) FROM \"user\" WHERE email = '${EMAIL}'")" == "1" ]] || fail "duplicate register wrote a second user"
[[ "$(rows "SELECT count(*) FROM \"account\" WHERE \"userId\" = '${USER_ID}'")" == "1" ]] \
	|| fail "duplicate register wrote a second account"
pass "second register is 409 email_taken, one user and one account"

echo "== concurrent registers: exactly one wins =="
RACE_EMAIL="identity-race-${RUN_ID}@example.com"
RACE_BODY="$(register_body "${RACE_EMAIL}" "${PASSWORD}" "Race")"
curl -sS -o /dev/null -w '%{http_code}' -X POST -H "X-Identity-Key: ${KEY}" \
	-H 'content-type: application/json' -d "${RACE_BODY}" \
	"${BASE}/identity/register" > "${TMP}/race1" &
RACE1=$!
curl -sS -o /dev/null -w '%{http_code}' -X POST -H "X-Identity-Key: ${KEY}" \
	-H 'content-type: application/json' -d "${RACE_BODY}" \
	"${BASE}/identity/register" > "${TMP}/race2" &
RACE2=$!
wait "${RACE1}"
wait "${RACE2}"
CODES="$(sort "${TMP}/race1" "${TMP}/race2")"
[[ "${CODES}" == $'201\n409' ]] || fail "concurrent registers returned '${CODES}', expected '201 409'"
[[ "$(rows "SELECT count(*) FROM \"user\" WHERE email = '${RACE_EMAIL}'")" == "1" ]] \
	|| fail "concurrent registers wrote more than one user"
[[ "$(rows "SELECT count(*) FROM \"account\" a JOIN \"user\" u ON u.id = a.\"userId\" WHERE u.email = '${RACE_EMAIL}'")" == "1" ]] \
	|| fail "concurrent registers wrote more than one account"
pass "two simultaneous registers -> one 201, one 409, one user and one account"

echo "== gateway: the identity cookie passes forward_auth on POST /prompt =="
call POST "/u/${USER_ID}/prompt" \
	"{\"prompt\":\"list the files\",\"requestId\":\"identity-${RUN_ID}\"}" \
	--max-time 180 -H "Cookie: ${COOKIE2}"
[[ "${STATUS}" == "200" ]] || fail "POST /u/${USER_ID}/prompt returned ${STATUS}, expected 200"
[[ "$(body_field "d['status']")" == "done" ]] || fail "prompt did not finish: $(cat "${BODY_FILE}")"
pass "forward_auth accepts the manager-issued session cookie"

echo "== logout revokes the session for whoami and the gateway =="
call POST /identity/logout - -H "X-Identity-Key: ${KEY}" -H "Cookie: ${COOKIE2}"
[[ "${STATUS}" == "204" ]] || fail "logout returned ${STATUS}, expected 204"
[[ ! -s "${BODY_FILE}" ]] || fail "204 logout returned a body"
[[ "$(rows "SELECT count(*) FROM \"session\" WHERE \"userId\" = '${USER_ID}'")" == "1" ]] \
	|| fail "logout did not delete exactly the presented session"
call GET /whoami - -H "Cookie: ${COOKIE2}"
[[ "${STATUS}" == "401" ]] || fail "whoami after logout returned ${STATUS}, expected 401"
call POST "/u/${USER_ID}/prompt" \
	"{\"prompt\":\"still there?\",\"requestId\":\"identity-after-${RUN_ID}\"}" \
	--max-time 30 -H "Cookie: ${COOKIE2}"
[[ "${STATUS}" == "401" ]] || fail "prompt after logout returned ${STATUS}, expected 401"
pass "logout deletes the row; whoami and forward_auth both answer 401"

echo
echo "IDENTITY SURFACE PASSED"
