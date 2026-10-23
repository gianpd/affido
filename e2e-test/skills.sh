#!/usr/bin/env bash
# RFC 0009 e2e (skills): install the SHIPPED catalog bundle — the real
# marketplace/skills/md-to-docx files with the manifest hashes — file by file
# through caddy -> manager -> sandbox agent, then list, verify, corrupt,
# refuse traversals, and uninstall.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USER_ID="skl-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

BUNDLE="${ROOT}/marketplace/skills/md-to-docx"
MANIFEST="${BUNDLE}/marketplace.json"
[[ -f "${MANIFEST}" ]] || fail "catalog bundle missing: ${MANIFEST}"

urlenc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

echo "== install phase: every manifest file with its complete path (POST /skills/file) =="
mapfile -t ENTRIES < <(python3 - "${MANIFEST}" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
for entry in manifest["files"]:
    print(f"{entry['path']}\t{entry['sha256']}")
PY
)
[[ "${#ENTRIES[@]}" -ge 3 ]] || fail "manifest lists too few files: ${#ENTRIES[@]}"

for entry in "${ENTRIES[@]}"; do
	rel="${entry%%	*}"
	want_sha="${entry#*	}"
	staged="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
		-H 'content-type: application/octet-stream' \
		--data-binary @"${BUNDLE}/${rel}" \
		"${BASE}/u/${USER_ID}/skills/file?skill=md-to-docx&path=$(urlenc "${rel}")")" \
		|| fail "install of ${rel} failed"
	[[ "$(printf '%s' "${staged}" | field "d['path']")" == "skills/md-to-docx/${rel}" ]] \
		|| fail "${rel} staged at ${staged}"
	[[ "$(printf '%s' "${staged}" | field "d['sha256']")" == "${want_sha}" ]] \
		|| fail "${rel} hash mismatch: ${staged}"
done
# The manifest itself is installed like any other file (§5.3): the local copy
# is what GET /skills reads the version from.
curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/octet-stream' \
	--data-binary @"${MANIFEST}" \
	"${BASE}/u/${USER_ID}/skills/file?skill=md-to-docx&path=marketplace.json" >/dev/null \
	|| fail "install of marketplace.json failed"
pass "installed ${#ENTRIES[@]} bundle files plus the manifest; every sha256 matches"

echo "== the install lists with provenance and version (GET /skills) =="
listed="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/skills")" \
	|| fail "GET /skills failed"
[[ "$(printf '%s' "${listed}" | field "[s['name'] for s in d['skills'] if s['name']=='md-to-docx']")" == "['md-to-docx']" ]] \
	|| fail "md-to-docx is not listed: ${listed}"
[[ "$(printf '%s' "${listed}" | field "[s['provenance'] for s in d['skills'] if s['name']=='md-to-docx']")" == "['marketplace']" ]] \
	|| fail "provenance is not marketplace: ${listed}"
[[ "$(printf '%s' "${listed}" | field "[s['version'] for s in d['skills'] if s['name']=='md-to-docx']")" == "['1.0.0']" ]] \
	|| fail "version is not reported: ${listed}"
[[ "$(printf '%s' "${listed}" | field "[s['verified'] for s in d['skills'] if s['name']=='md-to-docx']")" == "['ok']" ]] \
	|| fail "fresh verify is not ok: ${listed}"
pass "GET /skills lists md-to-docx (marketplace, v1.0.0, verified ok)"

echo "== verify against the shipped manifest (POST /skills/verify) =="
verified="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	--data-binary @"${MANIFEST}" \
	"${BASE}/u/${USER_ID}/skills/verify?skill=md-to-docx")" || fail "verify call failed"
[[ "$(printf '%s' "${verified}" | field "d['ok']")" == "True" ]] || fail "verify is not ok: ${verified}"
[[ "$(printf '%s' "${verified}" | field "[f['status'] for f in d['files'] if f['status']!='ok']")" == "[]" ]] \
	|| fail "verify reports non-ok files: ${verified}"
pass "all $(printf '%s' "${verified}" | field "len(d['files'])") files verify against the manifest"

echo "== a corrupted file is a visible mismatch, and reinstall repairs it =="
curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/octet-stream' \
	--data-binary '# one corrupted byte' \
	"${BASE}/u/${USER_ID}/skills/file?skill=md-to-docx&path=SKILL.md" >/dev/null || fail "corrupt write failed"
broken="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	--data-binary @"${MANIFEST}" \
	"${BASE}/u/${USER_ID}/skills/verify?skill=md-to-docx")" || fail "verify call failed"
[[ "$(printf '%s' "${broken}" | field "d['ok']")" == "False" ]] || fail "corruption is not visible: ${broken}"
[[ "$(printf '%s' "${broken}" | field "[f['path'] for f in d['files'] if f['status']=='mismatch']")" == "['SKILL.md']" ]] \
	|| fail "mismatch does not name SKILL.md: ${broken}"
curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/octet-stream' \
	--data-binary @"${BUNDLE}/SKILL.md" \
	"${BASE}/u/${USER_ID}/skills/file?skill=md-to-docx&path=SKILL.md" >/dev/null || fail "repair write failed"
repaired="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	--data-binary @"${MANIFEST}" \
	"${BASE}/u/${USER_ID}/skills/verify?skill=md-to-docx")" || fail "verify call failed"
[[ "$(printf '%s' "${repaired}" | field "d['ok']")" == "True" ]] || fail "reinstall did not repair: ${repaired}"
pass "corruption visible as a per-file mismatch; idempotent rewrite repairs it"

echo "== confinement: name and path traversals are refused =="
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H "Cookie: ${COOKIE}" \
	--data-binary 'x' \
	"${BASE}/u/${USER_ID}/skills/file?skill=../x&path=SKILL.md")"
[[ "${code}" == "400" ]] || fail "skill traversal returned ${code}, expected 400"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H "Cookie: ${COOKIE}" \
	--data-binary 'x' \
	"${BASE}/u/${USER_ID}/skills/file?skill=md-to-docx&path=../corpus/raw/evil.md")"
[[ "${code}" == "400" ]] || fail "path traversal returned ${code}, expected 400"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X DELETE -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/skills?skill=..")"
[[ "${code}" == "400" ]] || fail "skill=.. delete returned ${code}, expected 400"
pass "traversal shapes are rejected with 400"

echo "== teardown: uninstall removes the subtree (DELETE /skills) =="
curl -fsS --max-time 120 -X DELETE -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/skills?skill=md-to-docx" >/dev/null || fail "uninstall failed"
after="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/skills")" \
	|| fail "listing after uninstall failed"
[[ "$(printf '%s' "${after}" | field "len(d['skills'])")" == "0" ]] \
	|| fail "skills survived the uninstall: ${after}"
# Uninstalling again is not an error.
curl -fsS --max-time 120 -X DELETE -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/skills?skill=md-to-docx" >/dev/null || fail "second uninstall failed"
pass "uninstall removed the subtree; a repeat is not an error"

echo "== second catalog skill: pdf-text-extraction installs, verifies, lists, uninstalls =="
BUNDLE2="${ROOT}/marketplace/skills/pdf-text-extraction"
MANIFEST2="${BUNDLE2}/marketplace.json"
[[ -f "${MANIFEST2}" ]] || fail "catalog bundle missing: ${MANIFEST2}"
mapfile -t ENTRIES2 < <(python3 - "${MANIFEST2}" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
for entry in manifest["files"]:
    print(f"{entry['path']}\t{entry['sha256']}")
PY
)
[[ "${#ENTRIES2[@]}" -ge 2 ]] || fail "second manifest lists too few files: ${#ENTRIES2[@]}"
for entry in "${ENTRIES2[@]}"; do
	rel="${entry%%	*}"
	want_sha="${entry#*	}"
	staged="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
		-H 'content-type: application/octet-stream' \
		--data-binary @"${BUNDLE2}/${rel}" \
		"${BASE}/u/${USER_ID}/skills/file?skill=pdf-text-extraction&path=$(urlenc "${rel}")")" \
		|| fail "install of ${rel} failed"
	[[ "$(printf '%s' "${staged}" | field "d['sha256']")" == "${want_sha}" ]] \
		|| fail "${rel} hash mismatch: ${staged}"
done
curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/octet-stream' \
	--data-binary @"${MANIFEST2}" \
	"${BASE}/u/${USER_ID}/skills/file?skill=pdf-text-extraction&path=marketplace.json" >/dev/null \
	|| fail "install of second marketplace.json failed"
verified2="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	--data-binary @"${MANIFEST2}" \
	"${BASE}/u/${USER_ID}/skills/verify?skill=pdf-text-extraction")" || fail "second verify call failed"
[[ "$(printf '%s' "${verified2}" | field "d['ok']")" == "True" ]] || fail "second skill does not verify: ${verified2}"
listed2="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/skills")" \
	|| fail "GET /skills after second install failed"
[[ "$(printf '%s' "${listed2}" | field "[s['name'] for s in d['skills']]")" == "['pdf-text-extraction']" ]] \
	|| fail "second skill is not the only one listed: ${listed2}"
[[ "$(printf '%s' "${listed2}" | field "[s['version'] for s in d['skills']]")" == "['1.0.0']" ]] \
	|| fail "second skill version is not reported: ${listed2}"
curl -fsS --max-time 120 -X DELETE -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/skills?skill=pdf-text-extraction" >/dev/null || fail "second uninstall failed"
pass "pdf-text-extraction installed (${#ENTRIES2[@]} files), verified ok, listed v1.0.0, uninstalled"

echo
echo "SKILLS PASSED"
