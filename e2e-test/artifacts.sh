#!/usr/bin/env bash
# RFC 0009 e2e (artifacts): /md-to-docx through the whole chain — install the
# shipped bundle, let the faux documents dance build a real .docx through the
# baked library, read the run's artifacts from the /prompt envelope, download
# the file through the gateway path (the same agent endpoint /api/artifact
# proxies after the session check), and refuse the planted symlink.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USER_ID="art-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

BUNDLE="${ROOT}/marketplace/skills/md-to-docx"
MANIFEST="${BUNDLE}/marketplace.json"
urlenc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

echo "== setup: install the shipped md-to-docx bundle for this user =="
mapfile -t RELS < <(python3 - "${MANIFEST}" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
for entry in manifest["files"]:
    print(entry["path"])
PY
)
for rel in "${RELS[@]}"; do
	curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
		-H 'content-type: application/octet-stream' \
		--data-binary @"${BUNDLE}/${rel}" \
		"${BASE}/u/${USER_ID}/skills/file?skill=md-to-docx&path=$(urlenc "${rel}")" >/dev/null \
		|| fail "install of ${rel} failed"
done
# The manifest itself rides along (§5.3), so GET /skills reports the version.
curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/octet-stream' \
	--data-binary @"${MANIFEST}" \
	"${BASE}/u/${USER_ID}/skills/file?skill=md-to-docx&path=marketplace.json" >/dev/null \
	|| fail "install of marketplace.json failed"
pass "installed ${#RELS[@]} bundle files plus the manifest"

echo "== /md-to-docx drives the documents dance (POST /prompt) =="
result="$(curl -fsS --max-time 300 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"/md-to-docx make a proposal","requestId":"art-1","citations":"off"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "prompt failed"
[[ "$(printf '%s' "${result}" | field "d['status']")" == "done" ]] || fail "run did not finish: ${result}"
count="$(printf '%s' "${result}" | field "len(d['artifacts'])")"
[[ "${count}" -ge 1 ]] || fail "the envelope reports no artifacts: ${result}"
first="$(printf '%s' "${result}" | field "d['artifacts'][0]['path']")"
[[ "${first}" == *.docx ]] || fail "first artifact is not a docx: ${first}"
want_sha="$(printf '%s' "${result}" | field "d['artifacts'][0]['sha256']")"
bytes="$(printf '%s' "${result}" | field "d['artifacts'][0]['bytes']")"
[[ "${want_sha}" != "None" ]] || fail "sha256 above the cap for a fresh docx: ${result}"
answer="$(printf '%s' "${result}" | field "d['answer']")"
[[ "${answer}" == *"proposal.docx"* ]] || fail "the answer does not mention the document: ${answer}"
pass "envelope lists ${first} (${bytes} bytes, sha256 ${want_sha:0:12}…)"

echo "== replaying the same requestId answers the admitted submission =="
replay="$(curl -fsS --max-time 300 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"/md-to-docx make a proposal","requestId":"art-1","citations":"off"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "replay prompt failed"
[[ "$(printf '%s' "${replay}" | field "d['submissionId']")" == "$(printf '%s' "${result}" | field "d['submissionId']")" ]] \
	|| fail "replay ran a second submission"
[[ "$(printf '%s' "${replay}" | field "len(d['artifacts'])")" -ge 1 ]] \
	|| fail "replay lost the artifact list"
pass "same requestId -> same admitted submission, artifact list re-derived"

echo "== the file downloads as a zip whose sha256 matches (GET /artifact) =="
download="$(mktemp)"
trap 'rm -f "${download}"' EXIT
curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/artifact?path=$(urlenc "${first}")" -o "${download}" || fail "download failed"
got_sha="$(sha256sum "${download}" | cut -d' ' -f1)"
[[ "${got_sha}" == "${want_sha}" ]] || fail "downloaded sha256 ${got_sha} != envelope ${want_sha}"
python3 - "${download}" <<'PY' || fail "download is not a docx-shaped zip"
import sys
data = open(sys.argv[1], "rb").read()
assert data[:4] == b"PK\x03\x04", "missing zip signature"
assert b"[Content_Types].xml" in data, "missing [Content_Types].xml"
assert b"word/document.xml" in data, "missing word/document.xml"
PY
headers="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" -o /dev/null -D - \
	"${BASE}/u/${USER_ID}/artifact?path=$(urlenc "${first}")")"
grep -qi '^content-disposition: attachment;' <<<"${headers}" || fail "download is not an attachment"
grep -qi '^content-type: application/vnd.openxmlformats' <<<"${headers}" || fail "wrong content type"
pass "download is a valid docx (zip signature + parts), attachment, typed"

echo "== the tree lists the file and never the planted symlink (GET /artifacts) =="
tree="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/artifacts")" \
	|| fail "artifacts tree failed"
[[ "$(printf '%s' "${tree}" | field "[e['path'] for e in d['entries'] if e['path']=='${first}']")" == "['${first}']" ]] \
	|| fail "the tree is missing the document: ${tree}"
[[ "$(printf '%s' "${tree}" | field "'leak' in [e['path'] for e in d['entries']]")" == "False" ]] \
	|| fail "the symlink is listed: ${tree}"
pass "tree lists ${first}; the planted symlink is invisible"

echo "== the symlink and traversals are refused (GET /artifact) =="
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/artifact?path=leak")"
[[ "${code}" == "404" ]] || fail "symlink download returned ${code}, expected 404"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/artifact?path=$(urlenc "../data/session.sqlite")")"
[[ "${code}" == "400" ]] || fail "traversal returned ${code}, expected 400"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/artifact?path=")"
[[ "${code}" == "400" ]] || fail "empty path returned ${code}, expected 400"
pass "symlink 404, traversal and empty path 400"

echo "== an unknown /name gets the honest note, not a pretend run =="
nope="$(curl -fsS --max-time 300 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"/nope summarize the workspace","requestId":"art-nope","citations":"off"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "unknown-skill prompt failed"
nope_answer="$(printf '%s' "${nope}" | field "d['answer']")"
[[ "${nope_answer}" == *"not installed"* ]] || fail "the answer does not say not installed: ${nope_answer}"
[[ "$(printf '%s' "${nope}" | field "len(d['artifacts'])")" == "0" ]] \
	|| fail "the unknown-skill run claims artifacts"
pass "unknown /nope answers plainly without pretending"

echo "== teardown: the artifact disappears (DELETE /artifacts) =="
curl -fsS --max-time 120 -X DELETE -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/artifacts?path=$(urlenc "${first}")" >/dev/null || fail "artifact delete failed"
after="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/artifacts")" \
	|| fail "artifacts tree after delete failed"
[[ "$(printf '%s' "${after}" | field "len(d['entries'])")" == "0" ]] \
	|| fail "artifacts survived the delete: ${after}"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/artifact?path=$(urlenc "${first}")")"
[[ "${code}" == "404" ]] || fail "deleted artifact still downloadable (${code})"
pass "delete removed the artifact; downloading it is 404"

echo
echo "ARTIFACTS PASSED"
