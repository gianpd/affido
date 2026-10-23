#!/usr/bin/env bash
# PRD 0003 e2e: directory uploads through the whole path (caddy -> manager ->
# sandbox agent). The frontend dictates every path; the sandbox must store the
# tree exactly there and refuse anything that escapes the uploads root.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USER_ID="upl-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

echo "== setup phase: create the directory (POST /uploads/dir) =="
dir_json="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"path":"md-to-docx"}' \
	"${BASE}/u/${USER_ID}/uploads/dir")" || fail "create dir through caddy failed"
[[ "$(printf '%s' "${dir_json}" | field "d['path']")" == "corpus/uploads/md-to-docx" ]] \
	|| fail "create dir answered ${dir_json}"
pass "corpus/uploads/md-to-docx created"

echo "== upload phase: each file with its complete path (POST /uploads/file) =="
staged="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: text/markdown' \
	--data-binary '# md-to-docx skill

Read the references before converting.' \
	"${BASE}/u/${USER_ID}/uploads/file?path=md-to-docx/SKILL.md")" || fail "SKILL.md upload failed"
[[ "$(printf '%s' "${staged}" | field "d['path']")" == "corpus/uploads/md-to-docx/SKILL.md" ]] \
	|| fail "SKILL.md staged at ${staged}"
[[ "$(printf '%s' "${staged}" | field "d['bytes']")" != "0" ]] || fail "SKILL.md is empty: ${staged}"
[[ "$(printf '%s' "${staged}" | field "d['searchable']")" == "True" ]] \
	|| fail "a markdown upload must report searchable=True: ${staged}"

# Subfolders are implicit: references/ does not exist yet.
curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: text/markdown' \
	--data-binary 'Titles in title case. No orphans.' \
	"${BASE}/u/${USER_ID}/uploads/file?path=md-to-docx/references/style-guide.md" >/dev/null \
	|| fail "nested upload failed"
pass "two-level tree staged with full paths"

echo "== the tree reads back (GET /uploads) =="
tree="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/uploads?path=md-to-docx")" || fail "tree listing failed"
[[ "$(printf '%s' "${tree}" | field "[e['path'] for e in d['entries'] if e['path']=='md-to-docx/SKILL.md']")" == "['md-to-docx/SKILL.md']" ]] \
	|| fail "tree is missing SKILL.md: ${tree}"
[[ "$(printf '%s' "${tree}" | field "[e['path'] for e in d['entries'] if e['path']=='md-to-docx/references/style-guide.md']")" == "['md-to-docx/references/style-guide.md']" ]] \
	|| fail "tree is missing the nested file: ${tree}"
[[ "$(printf '%s' "${tree}" | field "[e['kind'] for e in d['entries'] if e['path']=='md-to-docx/references']")" == "['dir']" ]] \
	|| fail "references/ is not a directory in the tree: ${tree}"
pass "tree lists the file, the subfolder, and the nested file"

echo "== the agent sees the files at those paths (GET /file, activating) =="
read_back="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/file?path=corpus/uploads/md-to-docx/SKILL.md")" || fail "agent could not read the uploaded file"
[[ "$(printf '%s' "${read_back}" | field "d['content']")" == *"md-to-docx skill"* ]] \
	|| fail "content round-trip failed: ${read_back}"
pass "agent reads corpus/uploads/md-to-docx/SKILL.md through its own file API"

echo "== confinement: a path that escapes uploads/ is refused =="
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H "Cookie: ${COOKIE}" \
	--data-binary 'evil' \
	"${BASE}/u/${USER_ID}/uploads/file?path=../corpus/raw/evil.txt")"
[[ "${code}" == "400" ]] || fail "traversal path returned ${code}, expected 400"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X DELETE -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/uploads?path=..")"
[[ "${code}" == "400" ]] || fail "deleting above the root returned ${code}, expected 400"
pass "../ and absolute shapes are rejected with 400"

echo "== teardown: the subtree disappears (DELETE /uploads) =="
curl -fsS --max-time 120 -X DELETE -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/uploads?path=md-to-docx" >/dev/null || fail "delete subtree failed"
after="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" "${BASE}/u/${USER_ID}/uploads")" \
	|| fail "root listing after delete failed"
[[ "$(printf '%s' "${after}" | field "len(d['entries'])")" == "0" ]] \
	|| fail "the tree survived the delete: ${after}"
pass "delete removed the whole subtree, root listing is empty"

echo
echo "UPLOADS PASSED"
